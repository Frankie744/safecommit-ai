import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const workspaceRoot = resolve(process.cwd());
const requiredP0Tests = [
  "baseline_builds_but_fails_sensor_disconnect_safety_test",
  "candidate_patch_schema_is_validated",
  "each_candidate_uses_unique_sandbox",
  "failed_build_is_ineligible",
  "failed_safety_gate_cannot_be_compensated_by_high_average_score",
  "patch_cannot_modify_existing_tests",
  "patch_cannot_modify_safety_thresholds",
  "highest_eligible_candidate_is_selected",
  "human_approval_required_before_pr",
  "approval_invalidated_when_patch_changes",
  "critical_review_finding_blocks_ready_to_merge",
  "review_fix_reenters_full_validation_pipeline",
  "secrets_are_not_exposed_to_frontend_or_git",
  "demo_session_can_be_replayed_from_recorded_evidence",
] as const;

interface CommandResult {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  passed: boolean;
  log: string;
  stdout: string;
  stderr: string;
}

interface VitestAssertion {
  fullName: string;
  status: string;
}

interface VitestReport {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  success: boolean;
  testResults: readonly {
    name?: string;
    status?: string;
    assertionResults: readonly VitestAssertion[];
  }[];
}

const SENSITIVE_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|SIGNING_KEY|AUTHORIZATION|CREDENTIALS?|PAT)(?:$|_)/iu;
type BuildSecretSentinels = Readonly<
  Record<
    | "FIREWORKS_API_KEY"
    | "DAYTONA_API_KEY"
    | "BRAINTRUST_API_KEY"
    | "GITHUB_TOKEN"
    | "SAFEFLASH_PUBLISH_AUTH_SECRET"
    | "SAFEFLASH_RECORDED_LIVE_SIGNING_KEY",
    string
  >
>;

function createBuildSecretSentinels(): BuildSecretSentinels {
  const sentinel = (label: string) =>
    `SAFEFLASH_${label}_${randomBytes(24).toString("hex")}`;
  return Object.freeze({
    FIREWORKS_API_KEY: sentinel("FIREWORKS"),
    DAYTONA_API_KEY: sentinel("DAYTONA"),
    BRAINTRUST_API_KEY: sentinel("BRAINTRUST"),
    GITHUB_TOKEN: sentinel("GITHUB"),
    // Canonical 32-byte base64url values also satisfy the real server-side
    // capability/signing-key validators without persisting a reusable secret.
    SAFEFLASH_PUBLISH_AUTH_SECRET: randomBytes(32).toString("base64url"),
    SAFEFLASH_RECORDED_LIVE_SIGNING_KEY: randomBytes(32).toString("base64url"),
  });
}

let buildSecretSentinels: BuildSecretSentinels =
  createBuildSecretSentinels();
let fileSensitiveValues: readonly string[] = [];

async function loadLocalSensitiveValues(): Promise<readonly string[]> {
  const values = new Set<string>();
  const directories = [workspaceRoot, join(workspaceRoot, "apps", "web")];
  const names = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ];
  for (const directory of directories) {
    for (const name of names) {
      let source: string;
      try {
        source = await readFile(join(directory, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(
          line.trim(),
        );
        if (match === null || !SENSITIVE_NAME.test(match[1]!)) continue;
        const raw = match[2]!.trim();
        const value =
          raw.length >= 2 &&
          ((raw.startsWith('"') && raw.endsWith('"')) ||
            (raw.startsWith("'") && raw.endsWith("'")))
            ? raw.slice(1, -1)
            : raw;
        if (value.length >= 4) values.add(value);
      }
    }
  }
  return [...values];
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:.]/gu, "");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function redact(value: string): string {
  let redacted = value;
  const secrets = new Set<string>(fileSensitiveValues);
  for (const [name, secret] of [
    ...Object.entries(process.env),
    ...Object.entries(buildSecretSentinels),
  ]) {
    if (SENSITIVE_NAME.test(name) && secret !== undefined && secret.length >= 4) {
      secrets.add(secret);
    }
  }
  for (const secret of [...secrets].sort(
    (left, right) => right.length - left.length,
  )) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(
      /\bsfpa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED_PUBLISH_AUTHORIZATION]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|authorization)\b(\s*[:=]\s*)([^\s;]+)/giu,
      "$1$2[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
}

function childEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !SENSITIVE_NAME.test(name),
    ),
  ) as NodeJS.ProcessEnv;
  return {
    ...safe,
    SAFEFLASH_ALLOW_LIVE: "false",
    ...overrides,
  };
}

function cmdQuote(value: string): string {
  return /^[A-Za-z0-9@%_+:,./=\\-]+$/u.test(value)
    ? value
    : `"${value.replace(/"/gu, '""')}"`;
}

async function git(...args: readonly string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd: workspaceRoot,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

async function runNpm(
  name: string,
  args: readonly string[],
  evidenceDirectory: string,
  environmentOverrides: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  const display = `npm ${args.join(" ")}`;
  const startedAt = performance.now();
  const logName = `${name}.log`;
  const logPath = join(evidenceDirectory, logName);
  const executable =
    process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const childArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", ["npm.cmd", ...args].map(cmdQuote).join(" ")]
      : [...args];

  const result = await new Promise<Omit<CommandResult, "durationMs" | "log">>(
    (resolveResult, reject) => {
      const child = spawn(executable, childArgs, {
        cwd: workspaceRoot,
        env: childEnvironment(environmentOverrides),
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (exitCode) =>
        resolveResult({
          name,
          command: display,
          exitCode,
          passed: exitCode === 0,
          stdout,
          stderr,
        }),
      );
    },
  );

  const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  const safeStdout = redact(result.stdout);
  const safeStderr = redact(result.stderr);
  if (safeStdout) process.stdout.write(safeStdout);
  if (safeStderr) process.stderr.write(safeStderr);
  await writeFile(
    logPath,
    [
      `COMMAND: ${display}`,
      `EXIT_CODE: ${result.exitCode ?? "null"}`,
      `DURATION_MS: ${durationMs}`,
      "",
      safeStdout,
      safeStderr ? `\nSTDERR:\n${safeStderr}` : "",
    ].join("\n"),
    "utf8",
  );

  return {
    ...result,
    stdout: safeStdout,
    stderr: safeStderr,
    durationMs,
    log: logName,
  };
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function assertNoSensitiveValues(
  directory: string,
  label: string,
): Promise<void> {
  const sensitiveValues = [
    ...Object.entries(process.env)
      .filter(
        ([name, value]) =>
          SENSITIVE_NAME.test(name) && value !== undefined && value.length >= 4,
      )
      .map(([, value]) => value!),
    ...Object.values(buildSecretSentinels),
    ...fileSensitiveValues,
  ];
  for (const path of await filesBelow(directory)) {
    const text = (await readFile(path)).toString("utf8");
    if (sensitiveValues.some((secret) => text.includes(secret))) {
      throw new Error(`${label} contains a sensitive value: ${basename(path)}`);
    }
    if (
      /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu.test(text) ||
      /\bgh[pousr]_[A-Za-z0-9]{12,}\b/gu.test(text) ||
      /\bsfpa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu.test(text) ||
      /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{12,}=*/giu.test(text)
    ) {
      throw new Error(`${label} contains an unredacted credential pattern: ${basename(path)}`);
    }
  }
}

async function assertNoSensitiveValuesInTrackedFiles(): Promise<void> {
  const sensitiveValues = [
    ...Object.entries(process.env)
      .filter(
        ([name, value]) =>
          SENSITIVE_NAME.test(name) && value !== undefined && value.length >= 4,
      )
      .map(([, value]) => value!),
    ...fileSensitiveValues,
  ];
  if (sensitiveValues.length === 0) return;
  const paths = (await git("ls-files", "-z")).split("\0").filter(Boolean);
  for (const relativePath of paths) {
    const bytes = await readFile(join(workspaceRoot, relativePath));
    if (
      sensitiveValues.some((secret) =>
        bytes.includes(Buffer.from(secret, "utf8")),
      )
    ) {
      throw new Error(
        `Git-tracked file contains a configured sensitive value: ${relativePath}`,
      );
    }
  }
}

async function main(): Promise<void> {
  // A fresh value set per capture makes a computed client-side projection
  // detectable without committing the test secret itself.
  buildSecretSentinels = createBuildSecretSentinels();
  // Next.js may load ignored .env files that the parent npm process did not.
  // Read only sensitive values for redaction/leak detection; never persist or
  // print their names or contents.
  fileSensitiveValues = await loadLocalSensitiveValues();
  await assertNoSensitiveValuesInTrackedFiles();
  const sourceCommit = await git("rev-parse", "HEAD");
  const dirty = await git("status", "--porcelain");
  if (dirty.length > 0) {
    throw new Error(
      "P0 evidence capture requires a clean working tree so every result is bound to one source commit.",
    );
  }

  const runId = `p0-verification-${utcStamp()}`;
  const configuredPhaseDirectory =
    process.env.SAFEFLASH_P0_PHASE_DIRECTORY?.trim();
  const phaseDirectory = resolve(
    configuredPhaseDirectory ||
      join(workspaceRoot, "artifacts", "evidence", "phase-6"),
  );
  const allowedCustomRoot = resolve(workspaceRoot, ".safeflash");
  if (configuredPhaseDirectory) {
    const customRelative = relative(allowedCustomRoot, phaseDirectory);
    if (
      customRelative === "" ||
      customRelative.startsWith("..") ||
      isAbsolute(customRelative)
    ) {
      throw new Error(
        "SAFEFLASH_P0_PHASE_DIRECTORY must be a child of the ignored .safeflash runtime directory.",
      );
    }
  }
  const evidenceDirectory = join(phaseDirectory, runId);
  const stagingDirectory = join(
    workspaceRoot,
    ".safeflash",
    "p0-evidence",
    runId,
  );
  // Keep transient logs under the ignored runtime directory while validation
  // runs. Creating the final evidence directory too early would make the
  // source tree dirty and correctly trip the tournament's provenance guard.
  await mkdir(stagingDirectory, { recursive: true });

  const commands = [
    { name: "typecheck", args: ["run", "typecheck"] },
    {
      name: "build",
      args: ["run", "build"],
      environment: buildSecretSentinels,
    },
    { name: "vitest", args: ["run", "test"] },
    {
      name: "playwright",
      args: ["run", "test:e2e"],
      environment: buildSecretSentinels,
    },
    {
      name: "secret-scan",
      args: ["run", "test:secrets"],
      environment: buildSecretSentinels,
    },
  ] as const;
  const results: CommandResult[] = [];
  for (const command of commands) {
    results.push(
      await runNpm(
        command.name,
        command.args,
        stagingDirectory,
        "environment" in command ? command.environment : {},
      ),
    );
  }

  await assertNoSensitiveValues(
    join(workspaceRoot, "apps", "web", ".next", "static"),
    "Production frontend bundle",
  );

  const vitestSource = join(
    workspaceRoot,
    "artifacts",
    "evidence",
    "latest-vitest.json",
  );
  const vitestDestination = join(stagingDirectory, "vitest.json");
  const vitest = JSON.parse(
    await readFile(vitestSource, "utf8"),
  ) as VitestReport;
  await writeFile(
    vitestDestination,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        success: vitest.success,
        suites: {
          total: vitest.numTotalTestSuites,
          passed: vitest.numPassedTestSuites,
          failed: vitest.numFailedTestSuites,
        },
        tests: {
          total: vitest.numTotalTests,
          passed: vitest.numPassedTests,
          failed: vitest.numFailedTests,
        },
        testResults: vitest.testResults.map((suite) => ({
          name: redact(suite.name ?? "unknown-suite"),
          status: suite.status ?? "unknown",
          assertions: suite.assertionResults.map((assertion) => ({
            fullName: redact(assertion.fullName),
            status: assertion.status,
          })),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const assertions = vitest.testResults.flatMap((suite) => suite.assertionResults);
  const p0Matrix = Object.fromEntries(
    requiredP0Tests.map((name) => {
      const match = assertions.find(
        (assertion) =>
          assertion.fullName === name || assertion.fullName.endsWith(` ${name}`),
      );
      return [name, match?.status ?? "missing"];
    }),
  );
  const missingOrFailed = Object.entries(p0Matrix).filter(
    ([, status]) => status !== "passed",
  );
  const commandSummaries = results.map(({ stdout: _stdout, stderr: _stderr, ...item }) =>
    item,
  );
  const passed =
    results.every((result) => result.passed) &&
    vitest.success &&
    missingOrFailed.length === 0;
  const summary = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    sourceCommit,
    provenance: {
      mode: "local-test",
      provider: "local-process",
      verifiedExternalProviders: false,
      notice:
        "Provider credentials were removed from child processes; this capture does not claim Daytona, Braintrust, Fireworks, GitHub, or CodeRabbit live execution.",
    },
    passed,
    commands: commandSummaries,
    vitest: {
      suites: {
        total: vitest.numTotalTestSuites,
        passed: vitest.numPassedTestSuites,
        failed: vitest.numFailedTestSuites,
      },
      tests: {
        total: vitest.numTotalTests,
        passed: vitest.numPassedTests,
        failed: vitest.numFailedTests,
      },
    },
    p0Matrix,
    missingOrFailed,
  };
  await writeFile(
    join(stagingDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  await assertNoSensitiveValues(stagingDirectory, "P0 evidence staging directory");

  const manifestEntries: string[] = [];
  for (const name of (await readdir(stagingDirectory)).sort()) {
    if (name === "manifest.sha256") continue;
    const bytes = await readFile(join(stagingDirectory, name));
    manifestEntries.push(`${sha256(bytes)}  ${basename(name)}`);
  }
  await writeFile(
    join(stagingDirectory, "manifest.sha256"),
    `${manifestEntries.join("\n")}\n`,
    "utf8",
  );

  const finalCommit = await git("rev-parse", "HEAD");
  const finalDirty = await git("status", "--porcelain");
  if (finalCommit !== sourceCommit || finalDirty.length > 0) {
    throw new Error(
      "P0 validation changed HEAD or the tracked working tree; evidence publication was refused.",
    );
  }

  // Publish only after every validation command and integrity check has
  // finished, so the captured source commit stays clean for the entire run.
  await mkdir(phaseDirectory, { recursive: true });
  await cp(stagingDirectory, evidenceDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(join(phaseDirectory, "latest-run.txt"), `${runId}\n`, "utf8");

  process.stdout.write(`\nP0_EVIDENCE=${evidenceDirectory}\n`);
  process.stdout.write(`P0_RESULT=${passed ? "PASS" : "FAIL"}\n`);
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
