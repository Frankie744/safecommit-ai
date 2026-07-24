import { basename, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PHASE_7A_REPOSITORY,
  formatDayOfCheck,
  runDayOfCheck,
  type ReadonlyCommandRunner,
} from "../../scripts/day-of-check";
import {
  formatDemoPullRequestPlan,
  prepareDemoPullRequest,
} from "../../scripts/prepare-demo-pr";

const HEAD = "b8e7396246ec35d032808850fa38a4ec783ca0cb";
const ROOT = resolve("C:/safe/safeflash");
const ENV_EXAMPLE = `
FIREWORKS_API_KEY=
DAYTONA_API_KEY=
BRAINTRUST_API_KEY=
GITHUB_TOKEN=
SAFEFLASH_PUBLISH_AUTH_SECRET=
SAFEFLASH_RECORDED_LIVE_SIGNING_KEY=
FIREWORKS_MODEL=
GITHUB_OWNER=Frankie744
GITHUB_REPO=safecommit-ai
GITHUB_BASE_BRANCH=main
GITHUB_EXPECT_PUBLIC=true
SAFEFLASH_CERTIFIED_MAIN_SHA=${HEAD}
`;

function commandKey(command: string, args: readonly string[]): string {
  return `${command} ${args.join(" ")}`;
}

function successfulHarness(): {
  calls: string[];
  runCommand: ReadonlyCommandRunner;
  readTextFile: (path: string) => Promise<string>;
} {
  const calls: string[] = [];
  const responses = new Map<string, string>([
    ["git rev-parse --show-toplevel", ROOT],
    ["git status --porcelain=v1 --untracked-files=normal", ""],
    ["git ls-files -- .env .env.local", ""],
    ["git status --ignored --porcelain=v1 -- .env .env.local", ""],
    ["git remote get-url --all origin", PHASE_7A_REPOSITORY.remote],
    ["git remote get-url --push --all origin", PHASE_7A_REPOSITORY.remote],
    ["git rev-parse HEAD", HEAD],
    ["git symbolic-ref --quiet --short HEAD", "main"],
    [
      "git ls-remote --exit-code origin refs/heads/main",
      `${HEAD}\trefs/heads/main`,
    ],
    ["gh auth status --hostname github.com --active", ""],
    ["gh api user --jq .login", "Frankie744"],
    [
      "gh repo view Frankie744/safecommit-ai --json owner,name,visibility,isFork,isArchived,url,defaultBranchRef",
      JSON.stringify({
        owner: { login: "Frankie744" },
        name: "safecommit-ai",
        visibility: "PUBLIC",
        isFork: false,
        isArchived: false,
        url: PHASE_7A_REPOSITORY.url,
        defaultBranchRef: { name: "main" },
      }),
    ],
  ]);
  return {
    calls,
    runCommand: async (command, args) => {
      const key = commandKey(command, args);
      calls.push(key);
      const stdout = responses.get(key);
      if (stdout === undefined) throw new Error(`unexpected command ${key}`);
      return { stdout };
    },
    readTextFile: async (path) => {
      switch (basename(path)) {
        case "package.json":
          return JSON.stringify({ name: "safeflash" });
        case "SafeFlash_Codex_First_Prize_Goal.md":
          return "# SafeFlash";
        case ".env.example":
          return ENV_EXAMPLE;
        default:
          throw new Error(`unexpected read ${path}`);
      }
    },
  };
}

describe("Phase 7A read-only launch readiness", () => {
  it("returns CREDENTIAL_READY without claiming live certification or revealing values", async () => {
    const harness = successfulHarness();
    const report = await runDayOfCheck({
      cwd: ROOT,
      environment: {
        FIREWORKS_API_KEY: "configured-secret-must-never-appear",
      },
      runCommand: harness.runCommand,
      readTextFile: harness.readTextFile,
    });
    const output = formatDayOfCheck(report);

    expect(report).toMatchObject({
      result: "CREDENTIAL_READY",
      liveCertified: false,
      localHead: HEAD,
      branch: "main",
      remoteBranchHead: HEAD,
      remoteMainHead: HEAD,
      missingSecretEnvironment: [
        "DAYTONA_API_KEY",
        "BRAINTRUST_API_KEY",
        "GITHUB_TOKEN",
        "SAFEFLASH_PUBLISH_AUTH_SECRET",
        "SAFEFLASH_RECORDED_LIVE_SIGNING_KEY",
      ],
      configuredSecretEnvironment: ["FIREWORKS_API_KEY"],
      missingNonSecretEnvironment: ["FIREWORKS_MODEL"],
      configuredNonSecretEnvironment: [],
    });
    expect(output).toContain("PHASE_7A_RESULT=CREDENTIAL_READY");
    expect(output).toContain("LIVE_CERTIFIED=NO");
    expect(output).toContain("MUTATIONS_PERFORMED=NO");
    expect(output).not.toContain("configured-secret-must-never-appear");
    expect(harness.calls).toEqual([
      "git rev-parse --show-toplevel",
      "git status --porcelain=v1 --untracked-files=normal",
      "git ls-files -- .env .env.local",
      "git status --ignored --porcelain=v1 -- .env .env.local",
      "git remote get-url --all origin",
      "git remote get-url --push --all origin",
      "git rev-parse HEAD",
      "git symbolic-ref --quiet --short HEAD",
      "git ls-remote --exit-code origin refs/heads/main",
      "git ls-remote --exit-code origin refs/heads/main",
      "gh auth status --hostname github.com --active",
      "gh api user --jq .login",
      "gh repo view Frankie744/safecommit-ai --json owner,name,visibility,isFork,isArchived,url,defaultBranchRef",
    ]);
  });

  it("accepts a clean pushed safeflash branch while independently pinning certified main", async () => {
    const harness = successfulHarness();
    const original = harness.runCommand;
    const competitionHead = "8d180bb2e93a3505e64017de650ce27714d4a8a7";
    const competitionRef =
      "refs/heads/safeflash/competition-hardening-20260723";
    harness.runCommand = async (command, args, cwd) => {
      switch (commandKey(command, args)) {
        case "git rev-parse HEAD":
          harness.calls.push(commandKey(command, args));
          return { stdout: competitionHead };
        case "git symbolic-ref --quiet --short HEAD":
          harness.calls.push(commandKey(command, args));
          return { stdout: "safeflash/competition-hardening-20260723" };
        case `git ls-remote --exit-code origin ${competitionRef}`:
          harness.calls.push(commandKey(command, args));
          return { stdout: `${competitionHead}\t${competitionRef}` };
        default:
          return original(command, args, cwd);
      }
    };

    const report = await runDayOfCheck({
      cwd: ROOT,
      environment: {},
      runCommand: harness.runCommand,
      readTextFile: harness.readTextFile,
    });

    expect(report).toMatchObject({
      branch: "safeflash/competition-hardening-20260723",
      localHead: competitionHead,
      remoteBranchHead: competitionHead,
      remoteMainHead: HEAD,
    });
  });

  it("fails closed on an unexpected authenticated owner", async () => {
    const harness = successfulHarness();
    const original = harness.runCommand;
    harness.runCommand = async (command, args, cwd) =>
      commandKey(command, args) === "gh api user --jq .login"
        ? { stdout: "someone-else" }
        : original(command, args, cwd);

    await expect(
      runDayOfCheck({
        cwd: ROOT,
        environment: {},
        runCommand: harness.runCommand,
        readTextFile: harness.readTextFile,
      }),
    ).rejects.toThrow(/not authenticated as Frankie744/u);
    expect(harness.calls).not.toContain(
      "gh repo view Frankie744/safecommit-ai --json owner,name,visibility,isFork,isArchived,url,defaultBranchRef",
    );
  });

  it("fails closed before GitHub access when the tree is dirty or defaults drift", async () => {
    const dirty = successfulHarness();
    const originalDirty = dirty.runCommand;
    dirty.runCommand = async (command, args, cwd) =>
      commandKey(command, args) ===
      "git status --porcelain=v1 --untracked-files=normal"
        ? { stdout: " M package.json" }
        : originalDirty(command, args, cwd);
    await expect(
      runDayOfCheck({
        cwd: ROOT,
        environment: {},
        runCommand: dirty.runCommand,
        readTextFile: dirty.readTextFile,
      }),
    ).rejects.toThrow(/worktree is not clean/u);
    expect(dirty.calls.some((call) => call.startsWith("gh "))).toBe(false);

    const drift = successfulHarness();
    await expect(
      runDayOfCheck({
        cwd: ROOT,
        environment: { GITHUB_REPO: "another-repository" },
        runCommand: drift.runCommand,
        readTextFile: drift.readTextFile,
      }),
    ).rejects.toThrow(/does not match the authorized public repository/u);
    expect(drift.calls.some((call) => call.startsWith("gh "))).toBe(false);
  });

  it("fails closed when a real environment file is present or an example secret is populated", async () => {
    const present = successfulHarness();
    const originalPresent = present.runCommand;
    present.runCommand = async (command, args, cwd) =>
      commandKey(command, args) ===
      "git status --ignored --porcelain=v1 -- .env .env.local"
        ? { stdout: "!! .env.local" }
        : originalPresent(command, args, cwd);
    await expect(
      runDayOfCheck({
        cwd: ROOT,
        environment: {},
        runCommand: present.runCommand,
        readTextFile: present.readTextFile,
      }),
    ).rejects.toThrow(/is present in the repository root/u);
    expect(present.calls.some((call) => call.startsWith("gh "))).toBe(false);

    const populated = successfulHarness();
    const originalReader = populated.readTextFile;
    populated.readTextFile = async (path) =>
      basename(path) === ".env.example"
        ? ENV_EXAMPLE.replace("GITHUB_TOKEN=", "GITHUB_TOKEN=not-allowed")
        : originalReader(path);
    await expect(
      runDayOfCheck({
        cwd: ROOT,
        environment: {},
        runCommand: populated.runCommand,
        readTextFile: populated.readTextFile,
      }),
    ).rejects.toThrow(/GITHUB_TOKEN must exist with an empty value/u);
    expect(populated.calls.some((call) => call.startsWith("gh "))).toBe(false);
  });

  it("rejects a separate or additional origin push URL", async () => {
    const harness = successfulHarness();
    const original = harness.runCommand;
    harness.runCommand = async (command, args, cwd) =>
      commandKey(command, args) === "git remote get-url --push --all origin"
        ? { stdout: "https://github.com/Frankie744/another-repository.git" }
        : original(command, args, cwd);

    await expect(
      runDayOfCheck({
        cwd: ROOT,
        environment: {},
        runCommand: harness.runCommand,
        readTextFile: harness.readTextFile,
      }),
    ).rejects.toThrow(/origin push URL must contain only/u);
    expect(harness.calls.some((call) => call.startsWith("gh "))).toBe(false);
  });

  it("requires the sole --dry-run argument without executing any command", async () => {
    const harness = successfulHarness();
    await expect(
      prepareDemoPullRequest([], {
        cwd: ROOT,
        environment: {},
        runCommand: harness.runCommand,
        readTextFile: harness.readTextFile,
      }),
    ).rejects.toThrow(/exactly --dry-run is required/u);
    expect(harness.calls).toEqual([]);
  });

  it("produces a read-only PR plan and exposes no mutation adapter", async () => {
    const harness = successfulHarness();
    const plan = await prepareDemoPullRequest(["--dry-run"], {
      cwd: ROOT,
      environment: {},
      runCommand: harness.runCommand,
      readTextFile: harness.readTextFile,
    });
    const output = formatDemoPullRequestPlan(plan);

    expect(plan).toMatchObject({
      mode: "DRY_RUN",
      mutationsPerformed: false,
      proposedBase: "main",
      sourceCommit: HEAD,
    });
    expect(output).toContain("PREPARE_DEMO_PR=PASS");
    expect(output).toContain("BRANCH_CREATED=NO");
    expect(output).toContain("PUSH_PERFORMED=NO");
    expect(output).toContain("PULL_REQUEST_CREATED=NO");
    expect(output.match(/MUTATIONS_PERFORMED=NO/gu)).not.toBeNull();
    expect(
      harness.calls.every(
        (call) =>
          !/^(?:git (?:push|commit|branch|switch|checkout|merge|reset)|gh (?:pr|repo) (?:create|edit|delete|merge))\b/u.test(
            call,
          ),
      ),
    ).toBe(true);
  });
});
