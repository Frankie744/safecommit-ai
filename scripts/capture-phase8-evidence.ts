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
const sensitiveName =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIALS?|PAT|PRIVATE_KEY|SIGNING_KEY)(?:$|_)/iu;

interface CommandResult {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  log: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.]/gu, "");
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sensitiveValues(): Promise<readonly string[]> {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (sensitiveName.test(name) && value && value.length >= 4) {
      values.add(value);
    }
  }
  for (const directory of [workspaceRoot, join(workspaceRoot, "apps", "web")]) {
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]) {
      try {
        for (const line of (
          await readFile(join(directory, name), "utf8")
        ).split(/\r?\n/u)) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(
            line.trim(),
          );
          if (!match || !sensitiveName.test(match[1]!)) continue;
          const value = match[2]!.trim().replace(/^['"]|['"]$/gu, "");
          if (value.length >= 4) values.add(value);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return [...values];
}

function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of [...new Set(secrets)].sort(
    (left, right) => right.length - left.length,
  )) {
    output = output.replaceAll(secret, "[REDACTED]");
  }
  for (const privateValue of [
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined,
  ]) {
    if (privateValue) output = output.replaceAll(privateValue, "%USERPROFILE%");
  }
  return output
    .replace(
      /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(/\bgh[pousr]_[A-Za-z0-9]{12,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(
      /\bsfpa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED_PUBLISH_AUTHORIZATION]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/giu, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|authorization)\b(\s*[:=]\s*)([^\s;]+)/giu,
      "$1$2[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
}

function childEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) => value !== undefined && !sensitiveName.test(name),
      ),
    ),
    SAFEFLASH_ALLOW_LIVE: "false",
    ...overrides,
  };
}

async function runCommand(
  name: string,
  npmArgs: readonly string[],
  evidenceDirectory: string,
  secrets: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  const command = `npm ${npmArgs.join(" ")}`;
  const startedAt = performance.now();
  const executable =
    process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", `npm.cmd ${npmArgs.join(" ")}`]
      : [...npmArgs];
  const result = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      env: childEnvironment(overrides),
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
      resolveResult({ exitCode, stdout, stderr }),
    );
  });
  const safeStdout = redact(result.stdout, secrets);
  const safeStderr = redact(result.stderr, secrets);
  if (safeStdout) process.stdout.write(safeStdout);
  if (safeStderr) process.stderr.write(safeStderr);
  const durationMs = Math.round(performance.now() - startedAt);
  const log = `${name}.log`;
  await writeFile(
    join(evidenceDirectory, log),
    [
      `COMMAND=${command}`,
      `EXIT_CODE=${result.exitCode ?? "null"}`,
      `DURATION_MS=${durationMs}`,
      "",
      safeStdout,
      safeStderr ? `\nSTDERR:\n${safeStderr}` : "",
    ].join("\n"),
    "utf8",
  );
  return {
    name,
    command,
    exitCode: result.exitCode,
    durationMs,
    log,
  };
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory);
  return files.sort();
}

async function assertSafeEvidence(
  directory: string,
  secrets: readonly string[],
): Promise<void> {
  for (const path of await filesBelow(directory)) {
    const bytes = await readFile(path);
    if (secrets.some((secret) => bytes.includes(Buffer.from(secret, "utf8")))) {
      throw new Error(`Sensitive value detected in ${basename(path)}`);
    }
    if (/\.(?:log|json|jsonl|md|txt)$/iu.test(path)) {
      const text = bytes.toString("utf8");
      if (
        /\bgithub_pat_[A-Za-z0-9_]{12,}\b/u.test(text) ||
        /\bgh[pousr]_[A-Za-z0-9]{12,}\b/u.test(text) ||
        /\bsfpa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(text) ||
        /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{12,}=*/iu.test(
          text,
        )
      ) {
        throw new Error(`Credential pattern detected in ${basename(path)}`);
      }
    }
  }
}

async function git(...args: readonly string[]): Promise<string> {
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd: workspaceRoot,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`Read-only git command failed: ${args[0]}`));
    });
  });
}

async function verifyFinalEvidence(
  evidenceDirectory: string,
  secrets: readonly string[],
): Promise<void> {
  const tsxCli = join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const verifier = join(workspaceRoot, "scripts", "verify-evidence.ts");
  const result = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, verifier, evidenceDirectory],
      {
        cwd: workspaceRoot,
        env: childEnvironment(),
        shell: false,
        windowsHide: true,
      },
    );
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
      resolveResult({ exitCode, stdout, stderr }),
    );
  });
  const safeStdout = redact(result.stdout, secrets);
  const safeStderr = redact(result.stderr, secrets);
  if (safeStdout) process.stdout.write(safeStdout);
  if (safeStderr) process.stderr.write(safeStderr);
  if (result.exitCode !== 0) {
    throw new Error("Final Phase 8 evidence verification failed");
  }
}

async function main(): Promise<void> {
  const sourceCommit = await git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Phase 8 evidence requires a full source commit");
  }
  if ((await git("status", "--porcelain=v1", "--untracked-files=normal"))) {
    throw new Error("Phase 8 evidence requires a clean worktree");
  }
  const sourceBranch = await git("branch", "--show-current");
  if (!sourceBranch.startsWith("safeflash/competition-hardening-")) {
    throw new Error(
      "Phase 8 evidence requires the dedicated competition-hardening branch",
    );
  }
  const runId = `competition-hardening-${stamp()}`;
  const stagingDirectory = resolve(
    workspaceRoot,
    ".safeflash",
    "phase8-evidence",
    runId,
  );
  const runtimeRoot = resolve(workspaceRoot, ".safeflash");
  const stagingRelative = relative(runtimeRoot, stagingDirectory);
  if (
    stagingRelative === "" ||
    stagingRelative.startsWith("..") ||
    isAbsolute(stagingRelative)
  ) {
    throw new Error("Unsafe Phase 8 staging directory");
  }
  await mkdir(stagingDirectory, { recursive: true });
  const secrets = await sensitiveValues();
  const p0PhaseDirectory = join(stagingDirectory, "p0");
  const sentinel = (label: string) =>
    `SAFEFLASH_PHASE8_${label}_${randomBytes(24).toString("hex")}`;
  const sentinels = Object.freeze({
    FIREWORKS_API_KEY: sentinel("FIREWORKS"),
    DAYTONA_API_KEY: sentinel("DAYTONA"),
    BRAINTRUST_API_KEY: sentinel("BRAINTRUST"),
    GITHUB_TOKEN: sentinel("GITHUB"),
    SAFEFLASH_PUBLISH_AUTH_SECRET: randomBytes(32).toString("base64url"),
    SAFEFLASH_RECORDED_LIVE_SIGNING_KEY: randomBytes(32).toString("base64url"),
  });
  const commands = [
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "unit", args: ["run", "test:unit"] },
    { name: "integration", args: ["run", "test:integration"] },
    { name: "adversarial", args: ["run", "test:adversarial"] },
    {
      name: "playwright-chrome",
      args: ["run", "test:e2e"],
      environment: {
        ...sentinels,
        SAFEFLASH_PHASE8_SCREENSHOT_PATH: join(
          stagingDirectory,
          "console-1440x900.png",
        ),
      },
    },
    { name: "production-build", args: ["run", "build"], environment: sentinels },
    {
      name: "secret-scan",
      args: ["run", "test:secrets"],
      environment: sentinels,
    },
    { name: "npm-audit", args: ["audit"] },
    {
      name: "verify-p0",
      args: ["run", "verify:p0"],
      environment: { SAFEFLASH_P0_PHASE_DIRECTORY: p0PhaseDirectory },
    },
    {
      name: "rehearsal",
      args: ["run", "rehearsal"],
      environment: {
        SAFEFLASH_RECORDED_LIVE_SIGNING_KEY:
          process.env.SAFEFLASH_RECORDED_LIVE_SIGNING_KEY ?? "",
      },
    },
  ] as const;
  const results: CommandResult[] = [];
  for (const command of commands) {
    results.push(
      await runCommand(
        command.name,
        command.args,
        stagingDirectory,
        [...secrets, ...Object.values(sentinels)],
        "environment" in command ? command.environment : {},
      ),
    );
  }
  await assertSafeEvidence(
    join(workspaceRoot, "apps", "web", ".next", "static"),
    [...secrets, ...Object.values(sentinels)],
  );
  const finalSourceCommit = await git("rev-parse", "HEAD");
  const finalBranch = await git("branch", "--show-current");
  const finalWorktree = await git(
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  );
  const repositoryStable =
    finalSourceCommit === sourceCommit &&
    finalBranch === sourceBranch &&
    finalWorktree === "";
  const passed =
    results.every((result) => result.exitCode === 0) && repositoryStable;
  const rehearsalLog = await readFile(
    join(stagingDirectory, "rehearsal.log"),
    "utf8",
  );
  const recordedLiveProvenance =
    /^RECORDED_LIVE_PROVENANCE=PASS$/mu.test(rehearsalLog)
      ? "PASS"
      : "NOT_AVAILABLE";
  const summary = {
    schemaVersion: 1,
    phase: "SafeFlash Phase 8 Competition Hardening",
    runId,
    sourceCommit,
    branch: sourceBranch,
    capturedAt: new Date().toISOString(),
    passed,
    liveCertified: false,
    recordedLiveProvenance,
    mutations: {
      githubPullRequestCreated: false,
      githubPushPerformed: false,
      githubMergePerformed: false,
      liveWorkflowProviderCalls: 0,
      providerMutations: 0,
      readOnlyGithubChecks: true,
    },
    postconditions: {
      sourceCommitUnchanged: finalSourceCommit === sourceCommit,
      branchUnchanged: finalBranch === sourceBranch,
      worktreeClean: finalWorktree === "",
    },
    commands: results,
  };
  await writeFile(
    join(stagingDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(stagingDirectory, "git-state.txt"),
    [
      `SOURCE_COMMIT=${sourceCommit}`,
      `BRANCH=${summary.branch}`,
      "LIVE_CERTIFIED=NO",
      `RECORDED_LIVE_PROVENANCE=${summary.recordedLiveProvenance}`,
      "GITHUB_MUTATIONS=0",
      "LIVE_WORKFLOW_PROVIDER_CALLS=0",
      "PROVIDER_MUTATIONS=0",
      "READ_ONLY_GITHUB_CHECKS=PASS",
    ].join("\n") + "\n",
    "utf8",
  );
  await assertSafeEvidence(stagingDirectory, [
    ...secrets,
    ...Object.values(sentinels),
  ]);

  const manifest: string[] = [];
  for (const path of await filesBelow(stagingDirectory)) {
    const relativePath = relative(stagingDirectory, path).replaceAll("\\", "/");
    if (relativePath === "manifest.sha256") continue;
    manifest.push(`${sha256(await readFile(path))}  ${relativePath}`);
  }
  await writeFile(
    join(stagingDirectory, "manifest.sha256"),
    `${manifest.sort().join("\n")}\n`,
    "utf8",
  );
  const finalDirectory = join(
    workspaceRoot,
    "artifacts",
    "evidence",
    "phase-8",
    runId,
  );
  await mkdir(join(workspaceRoot, "artifacts", "evidence", "phase-8"), {
    recursive: true,
  });
  await cp(stagingDirectory, finalDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await verifyFinalEvidence(finalDirectory, [
    ...secrets,
    ...Object.values(sentinels),
  ]);
  await writeFile(
    join(
      workspaceRoot,
      "artifacts",
      "evidence",
      "phase-8",
      "latest-run.txt",
    ),
    `${runId}\n`,
    "utf8",
  );
  const postCopyCommit = await git("rev-parse", "HEAD");
  const postCopyBranch = await git("branch", "--show-current");
  const postCopyWorktree = await git(
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  );
  if (
    postCopyCommit !== sourceCommit ||
    postCopyBranch !== sourceBranch ||
    postCopyWorktree !== ""
  ) {
    throw new Error(
      "Phase 8 evidence publication changed the source commit or worktree",
    );
  }
  process.stdout.write(
    [
      `PHASE8_EVIDENCE=${finalDirectory}`,
      `PHASE8_SOURCE_COMMIT=${sourceCommit}`,
      `PHASE8_RESULT=${passed ? "PASS" : "FAIL"}`,
      "MANIFEST_SHA256=PASS",
      "EVIDENCE_VERIFY=PASS",
    ].join("\n") + "\n",
  );
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `PHASE8_EVIDENCE_CAPTURE=FAIL ${
      error instanceof Error ? error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
