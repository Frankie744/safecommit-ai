import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseRecordedLiveArtifact } from "@safeflash/domain";
import {
  DEFAULT_DEMO_SCENARIO_ID,
  runLocalTournament,
} from "@safeflash/orchestrator";

const execFile = promisify(execFileCallback);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED = Object.freeze({
  owner: "Frankie744",
  repository: "safeflash-ai",
  remote: "https://github.com/Frankie744/safeflash-ai.git",
  baseBranch: "main",
  certifiedMain: "6402e26db834069946aaab4391e8ef2dd224ad5e",
  pullNumber: 1,
  approvedRepairHead: "5b418b7eeac67e433609d0a0ca5ab6309bd4fe32",
  approvedCodeRabbitReviewId: 4_761_161_101,
});

const SECRET_ENVIRONMENT_NAMES = [
  "FIREWORKS_API_KEY",
  "DAYTONA_API_KEY",
  "BRAINTRUST_API_KEY",
  "GITHUB_TOKEN",
  "SAFEFLASH_PUBLISH_AUTH_SECRET",
  "SAFEFLASH_RECORDED_LIVE_SIGNING_KEY",
] as const;

interface Check {
  name: string;
  passed: boolean;
  detail: string;
  recovery?: string;
}

interface PullRequestMetadata {
  number?: number;
  state?: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefOid?: string;
  url?: string;
  mergedAt?: string | null;
}

interface RepositoryMetadata {
  nameWithOwner?: string;
  url?: string;
  visibility?: string;
  isFork?: boolean;
  isArchived?: boolean;
  defaultBranchRef?: { name?: string } | null;
}

interface PullRequestReviewMetadata {
  id?: number;
  state?: string;
  commit_id?: string;
  submitted_at?: string;
  user?: { login?: string } | null;
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const sensitiveName =
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIALS?|PAT|PRIVATE_KEY|SIGNING_KEY)(?:$|_)/iu;
  return {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) => value !== undefined && !sensitiveName.test(name),
      ),
    ),
    SAFEFLASH_ALLOW_LIVE: "false",
    SAFEFLASH_DEFAULT_MODE: "mock",
    GH_HOST: "github.com",
  };
}

async function run(
  executable: string,
  args: readonly string[],
  timeout = 45_000,
): Promise<string> {
  const result = await execFile(executable, [...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: safeChildEnvironment(),
    maxBuffer: 4 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function resolveGitHubCli(): Promise<string> {
  try {
    await run("gh", ["--version"]);
    return "gh";
  } catch {
    // Continue with the standard per-user GitHub CLI installation directory.
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) throw new Error("GitHub CLI is unavailable");
  const root = join(localAppData, "Programs", "GitHub CLI");
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = join(root, version, "bin", "gh.exe");
    try {
      await run(candidate, ["--version"]);
      return candidate;
    } catch {
      // Try the next installed version.
    }
  }
  throw new Error("GitHub CLI is unavailable");
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolveResult) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveResult(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolveResult(error === undefined));
    });
  });
}

function parseRemoteSha(value: string): string | undefined {
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main$/u.exec(value.trim());
  return match?.[1];
}

function parseEnvironmentExample(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (values.has(name)) throw new Error(`Duplicate .env.example key ${name}`);
    values.set(name, trimmed.slice(separator + 1).trim());
  }
  return values;
}

async function runCriticalP0(): Promise<void> {
  const args = [
    "vitest",
    "run",
    "tests/unit/candidate-patch-schema.test.ts",
    "tests/unit/selector.test.ts",
    "tests/unit/evidence-approval.test.ts",
    "tests/unit/recorded-live.test.ts",
    "tests/integration/competition-scenarios.test.ts",
    "tests/adversarial/no-auto-merge.test.ts",
    "--reporter=dot",
  ];
  if (process.platform === "win32") {
    await run(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `npx.cmd ${args.join(" ")}`],
      120_000,
    );
  } else {
    await run("npx", args, 120_000);
  }
}

async function recordedLiveStatus(): Promise<{
  status: "PASS" | "NOT_AVAILABLE";
  detail: string;
}> {
  const configured = process.env.SAFEFLASH_RECORDED_LIVE_PATH?.trim();
  if (!configured) {
    return {
      status: "NOT_AVAILABLE",
      detail:
        "No real five-provider artifact is configured; replay remains unavailable and cannot fall back to mock.",
    };
  }
  const artifact = parseRecordedLiveArtifact(
    JSON.parse(await readFile(resolve(configured), "utf8")) as unknown,
    process.env.SAFEFLASH_RECORDED_LIVE_SIGNING_KEY ?? "",
  );
  return {
    status: "PASS",
    detail: `Immutable recorded run ${artifact.runId} passed HMAC attestation, canonical digest, and provider binding checks.`,
  };
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const add = (
    name: string,
    passed: boolean,
    detail: string,
    recovery?: string,
  ) => checks.push({ name, passed, detail, recovery });

  const root = resolve(await run("git", ["rev-parse", "--show-toplevel"]));
  add(
    "repository-root",
    root.toLowerCase() === workspaceRoot.toLowerCase(),
    relative(workspaceRoot, root) || ".",
    "Run the command from the SafeFlash repository root.",
  );
  const status = await run("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  add(
    "clean-worktree",
    status === "",
    status === "" ? "clean" : "tracked or untracked changes present",
    "Commit intended Phase 8 changes and remove unintended files.",
  );
  const rehearsalSourceHead = await run("git", ["rev-parse", "HEAD"]);
  const branch = await run("git", ["branch", "--show-current"]);
  add(
    "competition-branch",
    branch.startsWith("safeflash/competition-hardening-"),
    branch || "detached",
    "Switch to the dedicated competition-hardening branch.",
  );
  const example = parseEnvironmentExample(
    await readFile(join(workspaceRoot, ".env.example"), "utf8"),
  );
  const expectedExample = new Map<string, string>([
    ["SAFEFLASH_DEFAULT_MODE", "mock"],
    ["SAFEFLASH_ALLOW_LIVE", "false"],
    ["SAFEFLASH_RECORDED_LIVE_PATH", ""],
    ["SAFEFLASH_RETAIN_SANDBOXES", "false"],
    ["SAFEFLASH_ENABLE_POLICY_COMPOSER", "false"],
    ["GITHUB_OWNER", EXPECTED.owner],
    ["GITHUB_REPO", EXPECTED.repository],
    ["GITHUB_BASE_BRANCH", EXPECTED.baseBranch],
    ["GITHUB_EXPECT_PUBLIC", "true"],
    ["SAFEFLASH_CERTIFIED_MAIN_SHA", EXPECTED.certifiedMain],
    ["SAFEFLASH_CERTIFIED_PR_NUMBER", String(EXPECTED.pullNumber)],
    ["SAFEFLASH_CERTIFIED_PR_HEAD_SHA", EXPECTED.approvedRepairHead],
    ...SECRET_ENVIRONMENT_NAMES.map((name) => [name, ""] as const),
  ]);
  const environmentOverridesMatch = [
    ["SAFEFLASH_DEFAULT_MODE", "mock"],
    ["SAFEFLASH_ALLOW_LIVE", "false"],
    ["SAFEFLASH_RETAIN_SANDBOXES", "false"],
    ["SAFEFLASH_ENABLE_POLICY_COMPOSER", "false"],
    ["GITHUB_OWNER", EXPECTED.owner],
    ["GITHUB_REPO", EXPECTED.repository],
    ["GITHUB_BASE_BRANCH", EXPECTED.baseBranch],
    ["GITHUB_EXPECT_PUBLIC", "true"],
    ["SAFEFLASH_CERTIFIED_MAIN_SHA", EXPECTED.certifiedMain],
    ["SAFEFLASH_CERTIFIED_PR_NUMBER", String(EXPECTED.pullNumber)],
    ["SAFEFLASH_CERTIFIED_PR_HEAD_SHA", EXPECTED.approvedRepairHead],
  ].every(([name, expected]) => {
    const configured = process.env[name]?.trim();
    return !configured || configured === expected;
  });
  const exampleMatches =
    [...expectedExample].every(([name, expected]) => example.get(name) === expected) &&
    environmentOverridesMatch;
  add(
    "environment-contract",
    exampleMatches,
    exampleMatches
      ? "Pinned non-secret defaults and empty secret placeholders validated."
      : "Environment contract differs from the authorized competition target.",
    "Restore the pinned .env.example values; keep every secret placeholder empty.",
  );
  const origin = await run("git", ["remote", "get-url", "origin"]);
  add(
    "authorized-origin",
    origin === EXPECTED.remote,
    origin,
    `Set origin only after authorization to ${EXPECTED.remote}.`,
  );
  const remoteMain = parseRemoteSha(
    await run("git", [
      "ls-remote",
      "--exit-code",
      "origin",
      "refs/heads/main",
    ]),
  );
  add(
    "certified-main",
    remoteMain === EXPECTED.certifiedMain,
    remoteMain ?? "unresolved",
    "Stop: origin/main changed. Re-certify the new immutable main before demo.",
  );
  let basedOnCertifiedMain = false;
  try {
    await run("git", [
      "merge-base",
      "--is-ancestor",
      EXPECTED.certifiedMain,
      "HEAD",
    ]);
    basedOnCertifiedMain = true;
  } catch {
    // Report the immutable-base failure with a recovery instruction below.
  }
  add(
    "competition-base",
    basedOnCertifiedMain,
    basedOnCertifiedMain
      ? `HEAD descends from ${EXPECTED.certifiedMain}`
      : "HEAD is not descended from the certified main SHA",
    "Recreate the competition-hardening branch from the certified main; do not rewrite PR #1.",
  );

  const gh = await resolveGitHubCli();
  const owner = await run(gh, [
    "api",
    "--hostname",
    "github.com",
    "user",
    "--jq",
    ".login",
  ]);
  add(
    "github-account",
    owner === EXPECTED.owner,
    owner,
    `Authenticate GitHub CLI as ${EXPECTED.owner}.`,
  );
  const repositoryMetadata = JSON.parse(
    await run(gh, [
      "repo",
      "view",
      `${EXPECTED.owner}/${EXPECTED.repository}`,
      "--json",
      "nameWithOwner,url,visibility,isFork,isArchived,defaultBranchRef",
    ]),
  ) as RepositoryMetadata;
  const repositoryMatches =
    repositoryMetadata.nameWithOwner ===
      `${EXPECTED.owner}/${EXPECTED.repository}` &&
    repositoryMetadata.url ===
      `https://github.com/${EXPECTED.owner}/${EXPECTED.repository}` &&
    repositoryMetadata.visibility === "PUBLIC" &&
    repositoryMetadata.isFork === false &&
    repositoryMetadata.isArchived === false &&
    repositoryMetadata.defaultBranchRef?.name === EXPECTED.baseBranch;
  add(
    "github-repository-metadata",
    repositoryMatches,
    `${repositoryMetadata.nameWithOwner ?? "?"} ${
      repositoryMetadata.visibility ?? "?"
    } fork=${String(repositoryMetadata.isFork)} archived=${String(
      repositoryMetadata.isArchived,
    )} default=${repositoryMetadata.defaultBranchRef?.name ?? "?"}`,
    "Stop: restore the certified public, non-fork, non-archived repository metadata before demo.",
  );
  const metadata = JSON.parse(
    await run(gh, [
      "pr",
      "view",
      String(EXPECTED.pullNumber),
      "--repo",
      `${EXPECTED.owner}/${EXPECTED.repository}`,
      "--json",
      "number,state,isDraft,baseRefName,headRefOid,url,mergedAt",
    ]),
  ) as PullRequestMetadata;
  const prMatches =
    metadata.number === EXPECTED.pullNumber &&
    metadata.state === "OPEN" &&
    metadata.isDraft === true &&
    metadata.baseRefName === EXPECTED.baseBranch &&
    metadata.headRefOid === EXPECTED.approvedRepairHead &&
    metadata.url ===
      `https://github.com/${EXPECTED.owner}/${EXPECTED.repository}/pull/${EXPECTED.pullNumber}` &&
    metadata.mergedAt === null;
  add(
    "certified-pr-head",
    prMatches,
    `PR #${metadata.number ?? "?"} ${metadata.state ?? "UNKNOWN"} draft=${String(
      metadata.isDraft,
    )} base=${metadata.baseRefName ?? "?"} head=${
      metadata.headRefOid ?? "?"
    }`,
    "Stop: do not merge or rewrite PR #1. Re-run exact-head review certification.",
  );
  const reviews = JSON.parse(
    await run(gh, [
      "api",
      "--hostname",
      "github.com",
      `repos/${EXPECTED.owner}/${EXPECTED.repository}/pulls/${EXPECTED.pullNumber}/reviews?per_page=100`,
    ]),
  ) as PullRequestReviewMetadata[];
  const latestCodeRabbitReview = reviews
    .filter((review) => review.user?.login === "coderabbitai[bot]")
    .sort((left, right) =>
      String(right.submitted_at ?? "").localeCompare(
        String(left.submitted_at ?? ""),
      ),
    )[0];
  const codeRabbitMatches =
    latestCodeRabbitReview?.id === EXPECTED.approvedCodeRabbitReviewId &&
    latestCodeRabbitReview?.state === "APPROVED" &&
    latestCodeRabbitReview.commit_id === EXPECTED.approvedRepairHead;
  add(
    "coderabbit-exact-head-review",
    codeRabbitMatches,
    `review=${latestCodeRabbitReview?.id ?? "MISSING"} state=${
      latestCodeRabbitReview?.state ?? "MISSING"
    } head=${latestCodeRabbitReview?.commit_id ?? "MISSING"}`,
    "Stop: the CodeRabbit approval is missing, dismissed, or bound to another head; re-certify the exact PR head.",
  );

  const port = Number(process.env.SAFEFLASH_REHEARSAL_PORT ?? "3018");
  const validPort =
    Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535;
  const portAvailable = validPort ? await portIsAvailable(port) : false;
  add(
    "demo-port",
    validPort && portAvailable,
    validPort ? `127.0.0.1:${port}` : "invalid port",
    `Free port ${String(port)} or set SAFEFLASH_REHEARSAL_PORT to an available local port.`,
  );

  const sessionId = `rehearsal-${Date.now().toString(36)}`;
  const tournament = await runLocalTournament({
    sessionId,
    workspaceRoot,
    scenarioId: DEFAULT_DEMO_SCENARIO_ID,
    commandTimeoutMs: 90_000,
  });
  const unsafe = tournament.candidates.find(
    (candidate) => candidate.candidate.candidateId === "candidate-a-range-clamp",
  );
  const winner = tournament.candidates.find(
    (candidate) =>
      candidate.candidate.candidateId === tournament.decision.winnerCandidateId,
  );
  const fallbackPass =
    tournament.provenance.kind === "local-test" &&
    unsafe !== undefined &&
    winner?.candidate.candidateId === "candidate-c-fail-closed" &&
    unsafe.weightedScore > winner.weightedScore &&
    !unsafe.eligible &&
    winner.eligible;
  add(
    "software-fallback",
    fallbackPass,
    fallbackPass
      ? "MOCK unsafe-high-score rejected the top soft score and selected the hard-gate-safe repair."
      : "fallback tournament did not preserve the expected safety ordering",
    "Run npm run test:firmware and inspect the selector evidence.",
  );

  let recorded: Awaited<ReturnType<typeof recordedLiveStatus>>;
  try {
    recorded = await recordedLiveStatus();
    add(
      "recorded-live",
      true,
      `${recorded.status}: ${recorded.detail}`,
    );
  } catch {
    recorded = {
      status: "NOT_AVAILABLE",
      detail: "Configured recorded-live artifact failed closed.",
    };
    add(
      "recorded-live",
      false,
      recorded.detail,
      "Remove the invalid path/wrong key or generate a fresh signed artifact only from a complete real Live run.",
    );
  }

  try {
    await runCriticalP0();
    add(
      "p0-critical-path",
      true,
      "Critical schema, selector, approval, recorded-live, scenario, and no-auto-merge tests passed.",
    );
  } catch {
    add(
      "p0-critical-path",
      false,
      "One or more critical tests failed.",
      "Run the targeted Vitest command from scripts/rehearsal.ts and fix the first failure.",
    );
  }

  const finalHead = await run("git", ["rev-parse", "HEAD"]);
  const finalStatus = await run("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  add(
    "source-head-unchanged",
    finalHead === rehearsalSourceHead,
    finalHead === rehearsalSourceHead ? finalHead : "HEAD changed during rehearsal",
    "Restore the intended committed competition head and rerun from the start.",
  );
  add(
    "final-clean-worktree",
    finalStatus === "",
    finalStatus === "" ? "clean" : "rehearsal left repository changes",
    "Inspect and remove only rehearsal-generated unintended repository files.",
  );
  const missingSecrets = SECRET_ENVIRONMENT_NAMES.filter(
    (name) => !process.env[name]?.trim(),
  );
  const configuredSecrets = SECRET_ENVIRONMENT_NAMES.filter(
    (name) => !missingSecrets.includes(name),
  );
  const blocked = checks.filter((check) => !check.passed);
  const readOnlyGithubChecksPassed = [
    "authorized-origin",
    "certified-main",
    "github-account",
    "github-repository-metadata",
    "certified-pr-head",
    "coderabbit-exact-head-review",
  ].every((name) => checks.find((check) => check.name === name)?.passed === true);
  const localHead = finalHead;
  process.stdout.write(
    [
      ...checks.map(
        (check) =>
          `CHECK_${check.name.toUpperCase().replaceAll("-", "_")}=${
            check.passed ? "PASS" : "FAIL"
          }`,
      ),
      `REHEARSAL_STATUS=${blocked.length === 0 ? "READY" : "BLOCKED"}`,
      `REHEARSAL_RESULT=${blocked.length === 0 ? "PASS" : "FAIL"}`,
      `SOFTWARE_FALLBACK=${fallbackPass ? "PASS" : "FAIL"}`,
      `RECORDED_LIVE_PROVENANCE=${recorded.status}`,
      `CERTIFIED_MAIN_SHA=${remoteMain ?? "UNRESOLVED"}`,
      `CERTIFIED_PR_HEAD_SHA=${metadata.headRefOid ?? "UNRESOLVED"}`,
      `LOCAL_COMPETITION_HEAD=${localHead}`,
      `MISSING_OPTIONAL_LIVE_ENV=${missingSecrets.join(",") || "NONE"}`,
      `CONFIGURED_OPTIONAL_LIVE_ENV=${configuredSecrets.join(",") || "NONE"}`,
      "LIVE_WORKFLOW_PROVIDER_CALLS=0",
      "PROVIDER_MUTATIONS=0",
      `READ_ONLY_GITHUB_CHECKS=${
        readOnlyGithubChecksPassed ? "PASS" : "FAIL"
      }`,
      "GITHUB_MUTATIONS=0",
      "AUTO_MERGE=DISABLED",
      ...blocked.map(
        (check, index) =>
          `RECOVERY_${index + 1}=${check.name}: ${
            check.recovery ?? "Inspect the failed check."
          }`,
      ),
    ].join("\n") + "\n",
  );
  if (blocked.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `REHEARSAL_BLOCKED=${
      error instanceof Error ? error.message.replace(/\s+/gu, " ") : "unknown error"
    }\n`,
  );
  process.stderr.write("REHEARSAL_STATUS=BLOCKED\n");
  process.stderr.write("REHEARSAL_RESULT=FAIL\n");
  process.stderr.write("LIVE_WORKFLOW_PROVIDER_CALLS=0\n");
  process.stderr.write("PROVIDER_MUTATIONS=0\n");
  process.stderr.write("READ_ONLY_GITHUB_CHECKS=FAIL\n");
  process.stderr.write("GITHUB_MUTATIONS=0\n");
  process.stderr.write(
    "RECOVERY_1=preflight: restore network/GitHub CLI/toolchain access and rerun npm run rehearsal\n",
  );
  process.exitCode = 1;
});
