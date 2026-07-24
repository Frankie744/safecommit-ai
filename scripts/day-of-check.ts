import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

export const PHASE_7A_REPOSITORY = {
  owner: "Frankie744",
  name: "safecommit-ai",
  baseBranch: "main",
  url: "https://github.com/Frankie744/safecommit-ai",
  remote: "https://github.com/Frankie744/safecommit-ai.git",
} as const;

export const PHASE_7A_SECRET_ENVIRONMENT = [
  "FIREWORKS_API_KEY",
  "DAYTONA_API_KEY",
  "BRAINTRUST_API_KEY",
  "GITHUB_TOKEN",
  "SAFEFLASH_PUBLISH_AUTH_SECRET",
  "SAFEFLASH_RECORDED_LIVE_SIGNING_KEY",
] as const;

export const PHASE_7A_NON_SECRET_RUNTIME_ENVIRONMENT = [
  "FIREWORKS_MODEL",
] as const;

export interface ReadonlyCommandResult {
  stdout: string;
}

export type ReadonlyCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<ReadonlyCommandResult>;

export type TextFileReader = (path: string) => Promise<string>;
export type ReadinessEnvironment = Readonly<Record<string, string | undefined>>;

export interface DayOfCheckOptions {
  cwd?: string;
  environment?: ReadinessEnvironment;
  runCommand?: ReadonlyCommandRunner;
  readTextFile?: TextFileReader;
}

export interface DayOfCheckReport {
  result: "CREDENTIAL_READY";
  liveCertified: false;
  repositoryUrl: string;
  origin: string;
  branch: string;
  localHead: string;
  remoteBranchHead: string;
  remoteMainHead: string;
  authenticatedOwner: string;
  missingSecretEnvironment: readonly string[];
  configuredSecretEnvironment: readonly string[];
  missingNonSecretEnvironment: readonly string[];
  configuredNonSecretEnvironment: readonly string[];
}

interface RepositoryMetadata {
  owner?: { login?: string };
  name?: string;
  visibility?: string;
  isFork?: boolean;
  isArchived?: boolean;
  url?: string;
  defaultBranchRef?: { name?: string } | null;
}

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function fail(message: string): never {
  throw new Error(`PHASE_7A_BLOCKED: ${message}`);
}

export function parseEnvironmentExample(contents: string): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (parsed.has(key)) fail(`.env.example contains duplicate key ${key}`);
    parsed.set(key, value);
  }
  return parsed;
}

const defaultRunner: ReadonlyCommandRunner = async (command, args, cwd) => {
  try {
    const result = await execFile(command, [...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
    return { stdout: result.stdout };
  } catch {
    // Do not relay subprocess output: an authentication helper or environment
    // could otherwise place a credential in an exception string.
    fail(`${command} ${args.join(" ")} did not complete successfully`);
  }
};

async function commandOutput(
  runner: ReadonlyCommandRunner,
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<string> {
  return (await runner(command, args, cwd)).stdout.trim();
}

function assertSha(value: string, label: string): void {
  if (!SHA_PATTERN.test(value)) fail(`${label} is not a full Git object ID`);
}

function assertExpectedConfiguration(
  example: ReadonlyMap<string, string>,
  environment: ReadinessEnvironment,
): void {
  const expected = {
    GITHUB_OWNER: PHASE_7A_REPOSITORY.owner,
    GITHUB_REPO: PHASE_7A_REPOSITORY.name,
    GITHUB_BASE_BRANCH: PHASE_7A_REPOSITORY.baseBranch,
    GITHUB_EXPECT_PUBLIC: "true",
  } as const;

  for (const [key, value] of Object.entries(expected)) {
    if (example.get(key) !== value) {
      fail(`.env.example ${key} must equal ${value}`);
    }
    const override = environment[key]?.trim();
    if (override !== undefined && override.length > 0 && override !== value) {
      fail(`${key} does not match the authorized public repository`);
    }
  }

  for (const key of PHASE_7A_SECRET_ENVIRONMENT) {
    if (example.get(key) !== "") {
      fail(`.env.example ${key} must exist with an empty value`);
    }
  }
  for (const key of PHASE_7A_NON_SECRET_RUNTIME_ENVIRONMENT) {
    if (!example.has(key)) {
      fail(`.env.example ${key} must exist`);
    }
  }
}

function parseRemoteBranch(
  output: string,
  expectedRef: string,
  label: string,
): string {
  const rows = output
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length !== 1) fail(`${label} did not resolve to exactly one ref`);
  const [sha, ref, ...extra] = rows[0]!.split(/\s+/u);
  if (
    sha === undefined ||
    ref !== expectedRef ||
    extra.length > 0
  ) {
    fail(`${label} returned an unexpected ref`);
  }
  assertSha(sha, label);
  return sha;
}

function parseAuthorizedRemote(output: string, label: string): string {
  const urls = output
    .split(/\r?\n/u)
    .map((url) => url.trim())
    .filter(Boolean);
  if (
    urls.length !== 1 ||
    urls[0] !== PHASE_7A_REPOSITORY.remote
  ) {
    fail(
      `${label} must contain only ${PHASE_7A_REPOSITORY.remote}`,
    );
  }
  return urls[0];
}

function parseRepositoryMetadata(raw: string): RepositoryMetadata {
  try {
    return JSON.parse(raw) as RepositoryMetadata;
  } catch {
    return fail("GitHub repository metadata was not valid JSON");
  }
}

/**
 * Performs only local reads plus read-only Git and GitHub CLI calls.
 * It never returns, prints, or probes the values of configured secrets.
 */
export async function runDayOfCheck(
  options: DayOfCheckOptions = {},
): Promise<DayOfCheckReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const runner = options.runCommand ?? defaultRunner;
  const reader = options.readTextFile ?? ((path) => readFile(path, "utf8"));

  const root = resolve(
    await commandOutput(runner, cwd, "git", ["rev-parse", "--show-toplevel"]),
  );
  if (root.toLowerCase() !== cwd.toLowerCase()) {
    fail("current directory is not the Git repository root");
  }

  let packageManifest: { name?: string };
  try {
    packageManifest = JSON.parse(await reader(resolve(cwd, "package.json"))) as {
      name?: string;
    };
  } catch {
    return fail("package.json could not be read");
  }
  if (packageManifest.name !== "safeflash") {
    fail("current Git root is not the SafeFlash project");
  }
  try {
    await reader(resolve(cwd, "SafeFlash_Codex_First_Prize_Goal.md"));
  } catch {
    return fail("SafeFlash goal specification is missing");
  }

  const status = await commandOutput(runner, cwd, "git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (status.length > 0) fail("Git worktree is not clean");

  const trackedEnvironmentFiles = await commandOutput(runner, cwd, "git", [
    "ls-files",
    "--",
    ".env",
    ".env.local",
  ]);
  if (trackedEnvironmentFiles.length > 0) {
    fail(".env or .env.local is tracked by Git");
  }
  const presentEnvironmentFiles = await commandOutput(runner, cwd, "git", [
    "status",
    "--ignored",
    "--porcelain=v1",
    "--",
    ".env",
    ".env.local",
  ]);
  if (presentEnvironmentFiles.length > 0) {
    fail(".env or .env.local is present in the repository root");
  }

  const example = parseEnvironmentExample(
    await reader(resolve(cwd, ".env.example")),
  );
  assertExpectedConfiguration(example, environment);

  const origin = parseAuthorizedRemote(
    await commandOutput(runner, cwd, "git", [
      "remote",
      "get-url",
      "--all",
      "origin",
    ]),
    "origin fetch URL",
  );
  parseAuthorizedRemote(
    await commandOutput(runner, cwd, "git", [
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    ]),
    "origin push URL",
  );

  const localHead = await commandOutput(runner, cwd, "git", [
    "rev-parse",
    "HEAD",
  ]);
  assertSha(localHead, "local HEAD");
  const branch = await commandOutput(runner, cwd, "git", [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (
    !/^(?:main|safeflash\/[A-Za-z0-9][A-Za-z0-9._/-]{0,120})$/u.test(
      branch,
    )
  ) {
    fail("current branch is not main or an authorized safeflash/* branch");
  }
  const branchRef = `refs/heads/${branch}`;
  const remoteBranchHead = parseRemoteBranch(
    await commandOutput(runner, cwd, "git", [
      "ls-remote",
      "--exit-code",
      "origin",
      branchRef,
    ]),
    branchRef,
    `origin/${branch}`,
  );
  if (localHead !== remoteBranchHead) {
    fail(`local HEAD does not exactly match origin/${branch}`);
  }
  const remoteMainHead = parseRemoteBranch(
    await commandOutput(runner, cwd, "git", [
      "ls-remote",
      "--exit-code",
      "origin",
      "refs/heads/main",
    ]),
    "refs/heads/main",
    "origin/main",
  );
  const certifiedMainHead = example.get("SAFEFLASH_CERTIFIED_MAIN_SHA");
  if (certifiedMainHead === undefined) {
    fail(".env.example SAFEFLASH_CERTIFIED_MAIN_SHA is missing");
  }
  assertSha(certifiedMainHead, "SAFEFLASH_CERTIFIED_MAIN_SHA");
  const certifiedMainOverride =
    environment.SAFEFLASH_CERTIFIED_MAIN_SHA?.trim();
  if (
    certifiedMainOverride !== undefined &&
    certifiedMainOverride.length > 0 &&
    certifiedMainOverride !== certifiedMainHead
  ) {
    fail("SAFEFLASH_CERTIFIED_MAIN_SHA override does not match .env.example");
  }
  if (remoteMainHead !== certifiedMainHead) {
    fail("origin/main moved away from SAFEFLASH_CERTIFIED_MAIN_SHA");
  }

  await commandOutput(runner, cwd, "gh", [
    "auth",
    "status",
    "--hostname",
    "github.com",
    "--active",
  ]);
  const authenticatedOwner = await commandOutput(runner, cwd, "gh", [
    "api",
    "user",
    "--jq",
    ".login",
  ]);
  if (authenticatedOwner !== PHASE_7A_REPOSITORY.owner) {
    fail(`GitHub CLI is not authenticated as ${PHASE_7A_REPOSITORY.owner}`);
  }

  const metadata = parseRepositoryMetadata(
    await commandOutput(runner, cwd, "gh", [
      "repo",
      "view",
      `${PHASE_7A_REPOSITORY.owner}/${PHASE_7A_REPOSITORY.name}`,
      "--json",
      "owner,name,visibility,isFork,isArchived,url,defaultBranchRef",
    ]),
  );
  if (
    metadata.owner?.login !== PHASE_7A_REPOSITORY.owner ||
    metadata.name !== PHASE_7A_REPOSITORY.name ||
    metadata.visibility !== "PUBLIC" ||
    metadata.isFork !== false ||
    metadata.isArchived !== false ||
    metadata.url !== PHASE_7A_REPOSITORY.url ||
    metadata.defaultBranchRef?.name !== PHASE_7A_REPOSITORY.baseBranch
  ) {
    fail("GitHub repository metadata does not match the authorized public target");
  }

  const missingSecretEnvironment = PHASE_7A_SECRET_ENVIRONMENT.filter(
    (key) => (environment[key]?.trim().length ?? 0) === 0,
  );
  const configuredSecretEnvironment = PHASE_7A_SECRET_ENVIRONMENT.filter(
    (key) => !missingSecretEnvironment.includes(key),
  );
  const missingNonSecretEnvironment =
    PHASE_7A_NON_SECRET_RUNTIME_ENVIRONMENT.filter(
      (key) => (environment[key]?.trim().length ?? 0) === 0,
    );
  const configuredNonSecretEnvironment =
    PHASE_7A_NON_SECRET_RUNTIME_ENVIRONMENT.filter(
      (key) => !missingNonSecretEnvironment.includes(key),
    );

  return {
    result: "CREDENTIAL_READY",
    liveCertified: false,
    repositoryUrl: PHASE_7A_REPOSITORY.url,
    origin,
    branch,
    localHead,
    remoteBranchHead,
    remoteMainHead,
    authenticatedOwner,
    missingSecretEnvironment,
    configuredSecretEnvironment,
    missingNonSecretEnvironment,
    configuredNonSecretEnvironment,
  };
}

export function formatDayOfCheck(report: DayOfCheckReport): string {
  return [
    "DAY_OF_CHECK=PASS",
    `PHASE_7A_RESULT=${report.result}`,
    "LIVE_CERTIFIED=NO",
    `GITHUB_REPOSITORY=${report.repositoryUrl}`,
    `GITHUB_OWNER=${report.authenticatedOwner}`,
    `GIT_ORIGIN=${report.origin}`,
    `GIT_BRANCH=${report.branch}`,
    `LOCAL_HEAD=${report.localHead}`,
    `REMOTE_BRANCH_HEAD=${report.remoteBranchHead}`,
    `REMOTE_MAIN_HEAD=${report.remoteMainHead}`,
    "REMOTE_SHA_MATCH=PASS",
    `MISSING_SECRET_ENV_VARS=${report.missingSecretEnvironment.join(",") || "NONE"}`,
    `CONFIGURED_SECRET_ENV_VARS=${report.configuredSecretEnvironment.join(",") || "NONE"}`,
    `MISSING_NON_SECRET_ENV_VARS=${report.missingNonSecretEnvironment.join(",") || "NONE"}`,
    `CONFIGURED_NON_SECRET_ENV_VARS=${report.configuredNonSecretEnvironment.join(",") || "NONE"}`,
    "MUTATIONS_PERFORMED=NO",
  ].join("\n");
}

export async function main(): Promise<void> {
  const report = await runDayOfCheck();
  process.stdout.write(`${formatDayOfCheck(report)}\n`);
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  resolve(entryPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "PHASE_7A_BLOCKED: unknown error"}\n`,
    );
    process.stderr.write("MUTATIONS_PERFORMED=NO\n");
    process.exitCode = 1;
  });
}
