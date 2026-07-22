import { describe, expect, it } from "vitest";

import {
  createHumanApproval,
  type ApprovalBinding,
} from "@safeflash/domain";
import {
  CodeRabbitAdapter,
  GitHubAdapter,
  ProviderResponseError,
  createManualVerifiedCodeRabbitFinding,
  extractCodeRabbitSeverity,
  mapCodeRabbitSeverity,
  type CodeRabbitClientPort,
  type CodeRabbitConfig,
  type GitHubClientPort,
  type GitHubConfig,
  type GitHubPullRequestInfo,
} from "@safeflash/integrations";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OLD_HEAD_SHA = "c".repeat(40);

const GITHUB_CONFIG: GitHubConfig = {
  mode: "live",
  token: "test-only-not-a-live-token",
  owner: "safeflash-demo",
  repository: "public-firmware",
  baseBranch: "main",
  apiVersion: "2026-03-10",
};

const CURRENT_BINDING: ApprovalBinding = {
  candidateId: "candidate-approved",
  patchDigest: "patch-digest",
  evidenceDigest: "evidence-digest",
  policyVersion: "policy-v1",
  commitSha: BASE_SHA,
};

const APPROVAL = createHumanApproval({
  id: "approval-1",
  sessionId: "session-github",
  approverId: "human-operator",
  decision: "approved",
  sourceVersion: "v1",
  actedAt: "2026-07-22T12:00:00.000Z",
  ...CURRENT_BINDING,
});

class FakeGitHub implements GitHubClientPort {
  readonly transport = "local-test" as const;
  calls: string[] = [];
  existing: GitHubPullRequestInfo[] = [];
  remoteHead = HEAD_SHA;

  async getAuthenticated() {
    this.calls.push("auth");
    return { login: "contract-user" };
  }

  async getRepository() {
    this.calls.push("repo");
    return {
      private: false,
      defaultBranch: "main",
      permissions: { push: true },
    };
  }

  async getCommit() {
    this.calls.push("commit");
    return { sha: this.remoteHead };
  }

  async listOpenPullRequests() {
    this.calls.push("list-prs");
    return this.existing;
  }

  async createPullRequest() {
    this.calls.push("create-pr");
    return {
      number: 42,
      htmlUrl: "https://github.com/safeflash-demo/public-firmware/pull/42",
      state: "open" as const,
      merged: false,
      headSha: HEAD_SHA,
      headRef: "safeflash/session-github/patch-digest",
      baseRef: "main",
    };
  }
}

function createRequest() {
  return {
    sessionId: "session-github",
    candidateId: "candidate-approved",
    headBranch: "safeflash/session-github/patch-digest",
    expectedHeadSha: HEAD_SHA,
    title: "SafeFlash: fail closed on current-sensor timeout",
    description: {
      incident: "Current-sensor timeout reused stale data.",
      selectedStrategy: "fail-closed",
      tests: ["battery_unit_tests 5/5", "battery_safety_tests 4/4"],
      braintrustExperimentUrl:
        "https://www.braintrust.dev/app/safeflash/experiment/real-id",
      daytonaEvidenceRef: "artifacts/evidence/daytona/run.json",
      evidenceDigest: CURRENT_BINDING.evidenceDigest,
    },
    approval: APPROVAL,
    currentBinding: CURRENT_BINDING,
  };
}

const CODERABBIT_CONFIG: CodeRabbitConfig = {
  ...GITHUB_CONFIG,
  reviewTimeoutMs: 5_000,
  pollIntervalMs: 250,
};

class FakeCodeRabbit implements CodeRabbitClientPort {
  readonly transport = "local-test" as const;
  reviews: Awaited<ReturnType<CodeRabbitClientPort["listReviews"]>> = [];
  comments: Awaited<ReturnType<CodeRabbitClientPort["listReviewComments"]>> = [];
  checks: Awaited<ReturnType<CodeRabbitClientPort["listChecksForRef"]>> = [];

  async listReviews() {
    return this.reviews;
  }
  async listReviewComments() {
    return this.comments;
  }
  async listChecksForRef() {
    return this.checks;
  }
}

describe("GitHub mutation and CodeRabbit exact-head gates", () => {
  it("blocks PR creation without a current approval before any GitHub call", async () => {
    const fake = new FakeGitHub();
    const invalidApproval = { ...APPROVAL, evidenceDigest: "stale-evidence" };
    await expect(
      new GitHubAdapter(GITHUB_CONFIG, fake).createOrGetPullRequest({
        ...createRequest(),
        approval: invalidApproval,
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(fake.calls).toEqual([]);
  });

  it("creates only an open unmerged PR at the exact approved head", async () => {
    const fake = new FakeGitHub();
    const result = await new GitHubAdapter(
      GITHUB_CONFIG,
      fake,
      () => new Date("2026-07-22T12:30:00.000Z"),
    ).createOrGetPullRequest(createRequest());
    expect(fake.calls).toEqual(["repo", "commit", "list-prs", "create-pr"]);
    expect(result.data).toMatchObject({
      number: 42,
      headSha: HEAD_SHA,
      status: "open",
    });
    expect("merge" in fake).toBe(false);
  });

  it("is idempotent and refuses a changed remote head", async () => {
    const fake = new FakeGitHub();
    fake.existing = [
      {
        number: 42,
        htmlUrl: "https://github.com/safeflash-demo/public-firmware/pull/42",
        state: "open",
        merged: false,
        headSha: HEAD_SHA,
        headRef: "safeflash/session-github/patch-digest",
        baseRef: "main",
      },
    ];
    await new GitHubAdapter(GITHUB_CONFIG, fake).createOrGetPullRequest(
      createRequest(),
    );
    expect(fake.calls).not.toContain("create-pr");

    const changed = new FakeGitHub();
    changed.remoteHead = OLD_HEAD_SHA;
    await expect(
      new GitHubAdapter(GITHUB_CONFIG, changed).createOrGetPullRequest(
        createRequest(),
      ),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(changed.calls).not.toContain("create-pr");
  });

  it("maps current CodeRabbit severity names while preserving raw severity", () => {
    expect(mapCodeRabbitSeverity("critical")).toEqual({
      rawSeverity: "critical",
      severity: "critical",
    });
    expect(mapCodeRabbitSeverity("major")).toEqual({
      rawSeverity: "major",
      severity: "high",
    });
    expect(mapCodeRabbitSeverity("minor")).toEqual({
      rawSeverity: "minor",
      severity: "medium",
    });
    expect(mapCodeRabbitSeverity("nitpick")).toEqual({
      rawSeverity: "nitpick",
      severity: "low",
    });
    expect(extractCodeRabbitSeverity("🟠 Major: retry can re-enable output"))
      .toEqual({ rawSeverity: "major", severity: "high" });
  });

  it("does not accept CodeRabbit evidence from an older head SHA", async () => {
    const fake = new FakeCodeRabbit();
    fake.reviews = [
      {
        id: "review-old",
        actorLogin: "coderabbitai[bot]",
        state: "APPROVED",
        body: "Review completed",
        commitId: OLD_HEAD_SHA,
        url: "https://github.com/safeflash-demo/public-firmware/pull/42#review-old",
      },
    ];
    const result = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      fake,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(result.data.status).toBe("stale");
    expect(result.data.passed).toBe(false);
    expect(result.data.exactHeadEvidenceIds).toEqual([]);
    expect(result.data.staleEvidenceIds).toContain("review:review-old");
  });

  it("blocks Major findings and passes exact-head success without blockers", async () => {
    const blockedFake = new FakeCodeRabbit();
    blockedFake.comments = [
      {
        id: "comment-major",
        actorLogin: "coderabbitai[bot]",
        body: "Major: retry path can re-enable charging after a latched fault.",
        commitId: HEAD_SHA,
        url: "https://github.com/safeflash-demo/public-firmware/pull/42#discussion-major",
        path: "fixtures/battery-controller/src/battery_controller.c",
        line: 40,
      },
    ];
    blockedFake.checks = [
      {
        id: "check-success",
        appSlug: "coderabbitai",
        name: "CodeRabbit Review",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/safeflash-demo/public-firmware/runs/1",
      },
    ];
    const blocked = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      blockedFake,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(blocked.data.status).toBe("blocked");
    expect(blocked.data.findings[0]).toMatchObject({
      rawSeverity: "major",
      headSha: HEAD_SHA,
      finding: { severity: "high", sourceVersion: HEAD_SHA, resolved: false },
    });

    const passingFake = new FakeCodeRabbit();
    passingFake.comments = [
      {
        id: "comment-minor",
        actorLogin: "coderabbitai[bot]",
        body: "Minor: consider a clearer local variable name.",
        commitId: HEAD_SHA,
        url: "https://github.com/safeflash-demo/public-firmware/pull/42#discussion-minor",
      },
    ];
    passingFake.checks = blockedFake.checks;
    const passing = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      passingFake,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(passing.data.status).toBe("passed");
    expect(passing.data.passed).toBe(true);
  });

  it("supports verifiable structured manual fallback without losing raw severity", () => {
    const result = createManualVerifiedCodeRabbitFinding({
      sessionId: "session-github",
      headSha: HEAD_SHA,
      externalId: "manual-review-42",
      reviewUrl:
        "https://github.com/safeflash-demo/public-firmware/pull/42#pullrequestreview-42",
      rawSeverity: "major",
      title: "Retry path bypass",
      body: "The retry path bypasses the safety latch.",
      attestedBy: "demo-operator",
      attestedAt: "2026-07-22T13:00:00.000Z",
    });
    expect(result.data).toMatchObject({
      rawSeverity: "major",
      sourceKind: "manual-attestation",
      headSha: HEAD_SHA,
      finding: { provider: "manual_verified", severity: "high" },
    });
  });
});
