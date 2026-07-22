import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

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
    assertionResults: readonly VitestAssertion[];
  }[];
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[-:.]/gu, "");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function redact(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|authorization)\b(\s*[:=]\s*)([^\s;]+)/giu,
      "$1$2[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
}

function childEnvironment(): NodeJS.ProcessEnv {
  const sensitiveName =
    /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|DAYTONA|BRAINTRUST|FIREWORKS|GITHUB|CODERABBIT|OPENAI)/iu;
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !sensitiveName.test(name),
    ),
  ) as NodeJS.ProcessEnv;
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
        env: childEnvironment(),
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        process.stdout.write(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        process.stderr.write(text);
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

async function main(): Promise<void> {
  const sourceCommit = await git("rev-parse", "HEAD");
  const dirty = await git("status", "--porcelain");
  if (dirty.length > 0) {
    throw new Error(
      "P0 evidence capture requires a clean working tree so every result is bound to one source commit.",
    );
  }

  const runId = `p0-verification-${utcStamp()}`;
  const phaseDirectory = join(workspaceRoot, "artifacts", "evidence", "phase-6");
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
    ["typecheck", ["run", "typecheck"]],
    ["vitest", ["run", "test"]],
    ["build", ["run", "build"]],
    ["playwright", ["run", "test:e2e"]],
  ] as const;
  const results: CommandResult[] = [];
  for (const [name, args] of commands) {
    results.push(await runNpm(name, args, stagingDirectory));
  }

  const vitestSource = join(
    workspaceRoot,
    "artifacts",
    "evidence",
    "latest-vitest.json",
  );
  const vitestDestination = join(stagingDirectory, "vitest.json");
  await copyFile(vitestSource, vitestDestination);
  const vitest = JSON.parse(
    await readFile(vitestDestination, "utf8"),
  ) as VitestReport;
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
