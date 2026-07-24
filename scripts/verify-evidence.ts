import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const workspaceRoot = resolve(process.cwd());
const allowedRoot = resolve(workspaceRoot, "artifacts", "evidence");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CREDENTIAL_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{12,}\b/u,
  /\bsfpa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\bAuthorization\s*:\s*(?!\[REDACTED\])\S+/iu,
  /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{12,}=*/iu,
  /\b(?:FIREWORKS|DAYTONA|BRAINTRUST)_API_KEY\s*[:=]\s*(?!\[REDACTED\])\S+/iu,
  /\b(?:GITHUB_TOKEN|SAFEFLASH_PUBLISH_AUTH_SECRET|SAFEFLASH_RECORDED_LIVE_SIGNING_KEY)\s*[:=]\s*(?!\[REDACTED\])\S+/iu,
] as const;
const SENSITIVE_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIALS?|PAT|PRIVATE_KEY|SIGNING_KEY)(?:$|_)/iu;
const execFile = promisify(execFileCallback);

async function git(...args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", [...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (!within(directory, path)) throw new Error("Evidence path escaped root");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("Evidence may not contain symbolic links");
      }
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error("Evidence contains an unsupported filesystem entry");
    }
  }
  await visit(directory);
  return files.sort();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function localSensitiveValues(): Promise<readonly string[]> {
  const values = new Set<string>();
  for (const directory of [workspaceRoot, join(workspaceRoot, "apps", "web")]) {
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]) {
      try {
        const text = await readFile(join(directory, name), "utf8");
        for (const line of text.split(/\r?\n/u)) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(
            line.trim(),
          );
          if (!match || !SENSITIVE_NAME.test(match[1]!)) continue;
          const value = match[2]!.trim().replace(/^['"]|['"]$/gu, "");
          if (value.length >= 4) values.add(value);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (SENSITIVE_NAME.test(name) && value && value.length >= 4) {
      values.add(value);
    }
  }
  return [...values];
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("Usage: npm run evidence:verify -- <evidence-directory>");
  }
  const directory = resolve(process.argv[2]!);
  if (!within(allowedRoot, directory) || directory === allowedRoot) {
    throw new Error("Evidence directory must be a run below artifacts/evidence");
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Evidence target must be a real directory");
  }
  const manifestPath = join(directory, "manifest.sha256");
  const manifest = await readFile(manifestPath, "utf8");
  const expected = new Map<string, string>();
  for (const [index, line] of manifest.trim().split(/\r?\n/u).entries()) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error(`Invalid manifest line ${index + 1}`);
    const path = match[2]!.replaceAll("\\", "/");
    const resolvedPath = resolve(directory, path);
    if (
      path === "manifest.sha256" ||
      isAbsolute(path) ||
      !within(directory, resolvedPath) ||
      expected.has(path)
    ) {
      throw new Error(`Unsafe or duplicate manifest path: ${path}`);
    }
    expected.set(path, match[1]!);
  }
  const files = (await filesBelow(directory)).filter(
    (path) => path !== manifestPath,
  );
  const actualPaths = files.map((path) =>
    relative(directory, path).replaceAll("\\", "/"),
  );
  if (
    actualPaths.length !== expected.size ||
    actualPaths.some((path) => !expected.has(path))
  ) {
    throw new Error("Manifest does not cover the exact evidence file set");
  }

  const requiredCommandNames = [
    "typecheck",
    "unit",
    "integration",
    "adversarial",
    "playwright-chrome",
    "production-build",
    "secret-scan",
    "npm-audit",
    "verify-p0",
    "rehearsal",
  ] as const;
  if (!expected.has("p0/latest-run.txt")) {
    throw new Error("Required Phase 8 evidence is missing: p0/latest-run.txt");
  }
  const p0RunId = (
    await readFile(join(directory, "p0", "latest-run.txt"), "utf8")
  ).trim();
  if (!/^p0-verification-\d{8}T\d{9}Z$/u.test(p0RunId)) {
    throw new Error("Nested P0 latest-run pointer is unsafe");
  }
  const p0Root = `p0/${p0RunId}`;
  const requiredPaths = [
    "summary.json",
    "git-state.txt",
    "console-1440x900.png",
    "p0/latest-run.txt",
    `${p0Root}/summary.json`,
    `${p0Root}/manifest.sha256`,
    ...requiredCommandNames.map((name) => `${name}.log`),
  ];
  for (const required of requiredPaths) {
    if (!expected.has(required)) {
      throw new Error(`Required Phase 8 evidence is missing: ${required}`);
    }
  }
  const summary = JSON.parse(
    await readFile(join(directory, "summary.json"), "utf8"),
  ) as {
    schemaVersion?: unknown;
    phase?: unknown;
    sourceCommit?: unknown;
    branch?: unknown;
    passed?: unknown;
    liveCertified?: unknown;
    recordedLiveProvenance?: unknown;
    mutations?: {
      githubPullRequestCreated?: unknown;
      githubPushPerformed?: unknown;
      githubMergePerformed?: unknown;
      liveWorkflowProviderCalls?: unknown;
      providerMutations?: unknown;
      readOnlyGithubChecks?: unknown;
    };
    postconditions?: {
      sourceCommitUnchanged?: unknown;
      branchUnchanged?: unknown;
      worktreeClean?: unknown;
    };
    commands?: {
      name?: unknown;
      exitCode?: unknown;
      log?: unknown;
    }[];
  };
  if (
    summary.schemaVersion !== 1 ||
    summary.phase !== "SafeFlash Phase 8 Competition Hardening" ||
    summary.passed !== true ||
    summary.liveCertified !== false ||
    !/^[0-9a-f]{40}$/u.test(String(summary.sourceCommit ?? "")) ||
    !String(summary.branch ?? "").startsWith(
      "safeflash/competition-hardening-",
    ) ||
    !["PASS", "NOT_AVAILABLE"].includes(
      String(summary.recordedLiveProvenance ?? ""),
    ) ||
    summary.mutations?.githubPullRequestCreated !== false ||
    summary.mutations.githubPushPerformed !== false ||
    summary.mutations.githubMergePerformed !== false ||
    summary.mutations.liveWorkflowProviderCalls !== 0 ||
    summary.mutations.providerMutations !== 0 ||
    summary.mutations.readOnlyGithubChecks !== true ||
    summary.postconditions?.sourceCommitUnchanged !== true ||
    summary.postconditions.branchUnchanged !== true ||
    summary.postconditions.worktreeClean !== true
  ) {
    throw new Error("Phase 8 summary does not certify a passing read-only run");
  }
  const expectedCommit = String(summary.sourceCommit);
  const expectedBranch = String(summary.branch);
  const [currentCommit, currentBranch, currentWorktree] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("branch", "--show-current"),
    git("status", "--porcelain=v1", "--untracked-files=normal"),
  ]);
  if (
    currentCommit !== expectedCommit ||
    currentBranch !== expectedBranch ||
    currentWorktree !== ""
  ) {
    throw new Error(
      "Phase 8 evidence is stale: current HEAD/branch/worktree no longer matches the clean captured source",
    );
  }
  if (
    !Array.isArray(summary.commands) ||
    summary.commands.length !== requiredCommandNames.length
  ) {
    throw new Error("Phase 8 summary command set is incomplete");
  }
  for (const name of requiredCommandNames) {
    const command = summary.commands.find((item) => item.name === name);
    if (command?.exitCode !== 0 || command.log !== `${name}.log`) {
      throw new Error(`Phase 8 command did not pass: ${name}`);
    }
  }
  const p0Summary = JSON.parse(
    await readFile(
      join(directory, "p0", p0RunId, "summary.json"),
      "utf8",
    ),
  ) as { passed?: unknown; sourceCommit?: unknown };
  if (
    p0Summary.passed !== true ||
    p0Summary.sourceCommit !== summary.sourceCommit
  ) {
    throw new Error("Nested P0 evidence is not passing or source-bound");
  }
  const gitState = await readFile(join(directory, "git-state.txt"), "utf8");
  if (
    !gitState.includes(`SOURCE_COMMIT=${String(summary.sourceCommit)}`) ||
    !gitState.includes("LIVE_CERTIFIED=NO") ||
    !gitState.includes("GITHUB_MUTATIONS=0") ||
    !gitState.includes("LIVE_WORKFLOW_PROVIDER_CALLS=0") ||
    !gitState.includes("PROVIDER_MUTATIONS=0") ||
    !gitState.includes("READ_ONLY_GITHUB_CHECKS=PASS")
  ) {
    throw new Error("Phase 8 git-state evidence is inconsistent");
  }
  const rehearsalLog = await readFile(join(directory, "rehearsal.log"), "utf8");
  const expectedRecordedLine =
    summary.recordedLiveProvenance === "PASS"
      ? "RECORDED_LIVE_PROVENANCE=PASS"
      : "RECORDED_LIVE_PROVENANCE=NOT_AVAILABLE";
  for (const requiredLine of [
    "REHEARSAL_STATUS=READY",
    "REHEARSAL_RESULT=PASS",
    expectedRecordedLine,
    "LIVE_WORKFLOW_PROVIDER_CALLS=0",
    "PROVIDER_MUTATIONS=0",
    "READ_ONLY_GITHUB_CHECKS=PASS",
    "GITHUB_MUTATIONS=0",
    "AUTO_MERGE=DISABLED",
  ]) {
    if (!rehearsalLog.split(/\r?\n/u).includes(requiredLine)) {
      throw new Error(`Rehearsal evidence is missing: ${requiredLine}`);
    }
  }

  const sensitiveValues = await localSensitiveValues();
  for (const [index, path] of files.entries()) {
    const relativePath = actualPaths[index]!;
    const bytes = await readFile(path);
    if (sha256(bytes) !== expected.get(relativePath)) {
      throw new Error(`SHA-256 mismatch: ${relativePath}`);
    }
    if (/\.(?:json|jsonl|log|md|txt|sha256)$/iu.test(relativePath)) {
      const text = bytes.toString("utf8");
      if (
        CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)) ||
        sensitiveValues.some((value) => text.includes(value))
      ) {
        throw new Error(`Sensitive material detected: ${relativePath}`);
      }
      if (/\.json$/iu.test(relativePath)) JSON.parse(text);
      if (/\.jsonl$/iu.test(relativePath)) {
        for (const line of text.split(/\r?\n/u).filter(Boolean)) JSON.parse(line);
      }
    }
  }
  const [finalCommit, finalBranch, finalWorktree] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("branch", "--show-current"),
    git("status", "--porcelain=v1", "--untracked-files=normal"),
  ]);
  if (
    finalCommit !== expectedCommit ||
    finalBranch !== expectedBranch ||
    finalWorktree !== ""
  ) {
    throw new Error(
      "Phase 8 evidence source changed while verification was running",
    );
  }
  process.stdout.write(
    [
      "EVIDENCE_VERIFY=PASS",
      `EVIDENCE_FILES=${files.length}`,
      "MANIFEST_SHA256=PASS",
      "SECRET_SCAN=PASS",
    ].join("\n") + "\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `EVIDENCE_VERIFY=FAIL ${error instanceof Error ? error.message : "unknown"}\n`,
  );
  process.exitCode = 1;
});
