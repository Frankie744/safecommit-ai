import { describe, expect, it } from "vitest";

import {
  createHumanApproval,
  createValidationSession,
  transitionValidationSession,
  type ApprovalBinding,
  type PullRequestRecord,
  type ValidationSession,
} from "@safeflash/domain";
import {
  CodeRabbitAdapter,
  GitHubAdapter,
  ProviderResponseError,
  createLiveIndependentReviewReceipt,
  createManualVerifiedCodeRabbitFinding,
  createManualVerifiedIndependentReviewReceipt,
  extractCodeRabbitSeverity,
  mapCodeRabbitSeverity,
  readGitHubConfig,
  type CodeRabbitClientPort,
  type CodeRabbitConfig,
  type GitHubClientPort,
  type GitHubConfig,
  type GitHubPullRequestInfo,
} from "@safeflash/integrations";

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
  commitSha: HEAD_SHA,
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
  lastUpdatedBody?: string;

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
      headRef: "safeflash/session-github",
      baseRef: "main",
    };
  }

  async updatePullRequest(request: {
    pullNumber: number;
    title: string;
    body: string;
  }) {
    this.calls.push("update-pr");
    this.lastUpdatedBody = request.body;
    const current = this.existing.find((item) => item.number === request.pullNumber);
    if (current === undefined) throw new Error("missing fake pull request");
    return current;
  }
}

function createRequest() {
  return {
    sessionId: "session-github",
    candidateId: "candidate-approved",
    headBranch: "safeflash/session-github",
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
  pullHeadSha = HEAD_SHA;
  pullHeadSequence: string[] = [];
  pullReadCount = 0;

  async getPullRequest() {
    const headSha = this.pullHeadSequence[this.pullReadCount] ?? this.pullHeadSha;
    this.pullReadCount += 1;
    return {
      number: 42,
      headSha,
      baseRef: "main",
      state: "open" as const,
      merged: false,
      url: "https://github.com/safeflash-demo/public-firmware/pull/42",
    };
  }

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
  it("rejects unsafe GitHub repository coordinates before client creation", () => {
    expect(() =>
      readGitHubConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        GITHUB_TOKEN: "configured-for-contract-test",
        GITHUB_OWNER: "../attacker",
        GITHUB_REPO: "public-firmware",
      }),
    ).toThrow(ProviderResponseError);
    expect(() =>
      readGitHubConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        GITHUB_TOKEN: "configured-for-contract-test",
        GITHUB_OWNER: "safeflash-demo",
        GITHUB_REPO: "public-firmware",
        GITHUB_BASE_BRANCH: "refs//heads/main",
      }),
    ).toThrow(ProviderResponseError);
  });

  it("keeps the GitHub smoke read-only while verifying the configured base head", async () => {
    const fake = new FakeGitHub();
    const result = await new GitHubAdapter(GITHUB_CONFIG, fake).smokeReadiness();
    expect(fake.calls).toEqual(["auth", "repo", "commit"]);
    expect(fake.calls).not.toContain("create-pr");
    expect(result.data).toMatchObject({
      public: true,
      pushPermission: true,
      configuredBaseBranch: "main",
      baseHeadSha: HEAD_SHA,
    });
  });

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

  it("binds candidate, evidence, and approved commit to the requested PR head", async () => {
    const mutations = [
      { candidateId: "candidate-other" },
      {
        description: {
          ...createRequest().description,
          evidenceDigest: "different-evidence",
        },
      },
      { expectedHeadSha: OLD_HEAD_SHA },
      { headBranch: "safeflash/session-github/patch-v2" },
    ];

    for (const mutation of mutations) {
      const fake = new FakeGitHub();
      await expect(
        new GitHubAdapter(GITHUB_CONFIG, fake).createOrGetPullRequest({
          ...createRequest(),
          ...mutation,
        }),
      ).rejects.toBeInstanceOf(ProviderResponseError);
      expect(fake.calls).toEqual([]);
    }
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
        headRef: "safeflash/session-github",
        baseRef: "main",
      },
    ];
    await new GitHubAdapter(GITHUB_CONFIG, fake).createOrGetPullRequest(
      createRequest(),
    );
    expect(fake.calls).not.toContain("create-pr");
    expect(fake.calls).toContain("update-pr");
    expect(fake.lastUpdatedBody).toContain(
      createRequest().description.braintrustExperimentUrl,
    );
    expect(fake.lastUpdatedBody).toContain(
      createRequest().description.daytonaEvidenceRef,
    );

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

  it("marks the request stale before reading review evidence when the PR head changed", async () => {
    const fake = new FakeCodeRabbit();
    fake.pullHeadSha = OLD_HEAD_SHA;
    fake.checks = [
      {
        id: "forged-success",
        appSlug: "coderabbitai",
        name: "CodeRabbit Review",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/safeflash-demo/public-firmware/runs/forged",
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
    expect(result.data).toMatchObject({ status: "stale", passed: false });
    expect(result.data.staleEvidenceIds).toEqual([
      `pull-request-head:${OLD_HEAD_SHA}`,
    ]);
    expect(result.data.exactHeadEvidenceIds).toEqual([]);
  });

  it("accepts only the official CodeRabbit bot login and app slug", async () => {
    const fake = new FakeCodeRabbit();
    fake.reviews = [
      {
        id: "lookalike-review",
        actorLogin: "code-rabbit-ai[bot]",
        state: "APPROVED",
        body: "Review completed",
        commitId: HEAD_SHA,
        url: "https://github.com/safeflash-demo/public-firmware/pull/42#lookalike",
      },
    ];
    fake.checks = [
      {
        id: "lookalike-check",
        appSlug: "untrusted-reviewer",
        name: "CodeRabbit Review",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/safeflash-demo/public-firmware/runs/lookalike",
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
    expect(result.data).toMatchObject({ status: "pending", passed: false });
    expect(result.data.exactHeadEvidenceIds).toEqual([]);
  });

  it("does not treat an unrelated check from the CodeRabbit app as review success", async () => {
    const fake = new FakeCodeRabbit();
    fake.checks = [
      {
        id: "unrelated-check",
        appSlug: "coderabbitai",
        name: "Installation diagnostics",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/safeflash-demo/public-firmware/runs/unrelated",
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
    expect(result.data).toMatchObject({ status: "pending", passed: false });
    expect(result.data.exactHeadEvidenceIds).toEqual([]);
  });

  it("maps a failed official CodeRabbit check into an exact-head REVIEW_BLOCKED workflow event", async () => {
    const fake = new FakeCodeRabbit();
    fake.checks = [
      {
        id: "failed-review-check",
        appSlug: "coderabbitai",
        name: "CodeRabbit Review",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/safeflash-demo/public-firmware/runs/991",
      },
    ];
    const inspection = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      fake,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(inspection.data).toMatchObject({ status: "blocked", passed: false });
    expect(inspection.data.findings[0]?.finding.reviewUrl).toContain("/runs/991");

    const receipt = createLiveIndependentReviewReceipt(
      {
        ...inspection,
        provenance: {
          mode: "live",
          kind: "live",
          capturedAt: "2026-07-22T13:00:00.000Z",
        },
      },
      CODERABBIT_CONFIG,
    );
    expect(receipt.reviewUrl).toBe(
      "https://github.com/safeflash-demo/public-firmware/pull/42",
    );

    const base = createValidationSession({
      id: "session-github",
      incidentId: "incident-battery",
      policyId: "policy-battery",
      policyVersion: CURRENT_BINDING.policyVersion,
      repository: {
        repoUrl: "https://github.com/safeflash-demo/public-firmware.git",
        commitSha: HEAD_SHA,
      },
      mode: "live",
      sourceVersion: "workflow-v1",
      at: "2026-07-22T12:00:00.000Z",
    });
    const pullRequest: PullRequestRecord = {
      id: "github-pr-42",
      sessionId: base.sessionId,
      createdAt: "2026-07-22T12:30:00.000Z",
      updatedAt: "2026-07-22T12:30:00.000Z",
      source: "github",
      sourceVersion: GITHUB_CONFIG.apiVersion,
      candidateId: CURRENT_BINDING.candidateId,
      provider: "github",
      owner: GITHUB_CONFIG.owner,
      repository: GITHUB_CONFIG.repository,
      number: 42,
      url: "https://github.com/safeflash-demo/public-firmware/pull/42",
      headSha: HEAD_SHA,
      baseBranch: GITHUB_CONFIG.baseBranch,
      status: "open",
    };
    const awaitingReview: ValidationSession = {
      ...base,
      state: "AWAITING_CODERABBIT",
      candidateIds: [CURRENT_BINDING.candidateId],
      selectedCandidateId: CURRENT_BINDING.candidateId,
      currentPatchDigest: CURRENT_BINDING.patchDigest,
      currentEvidenceDigest: CURRENT_BINDING.evidenceDigest,
      currentCommitSha: HEAD_SHA,
      approval: APPROVAL,
      pullRequest,
      validationRound: 1,
    };
    const blocked = transitionValidationSession(awaitingReview, {
      type: "REVIEW_FINDINGS_RECEIVED",
      at: "2026-07-22T13:00:01.000Z",
      findings: inspection.data.findings.map((item) => item.finding),
      receipt,
    });
    expect(blocked.state).toBe("REVIEW_BLOCKED");
    expect(blocked.reviewFindings[0]).toMatchObject({
      severity: "high",
      sourceVersion: HEAD_SHA,
    });
  });

  it("fails closed when the PR head changes during review evaluation", async () => {
    const fake = new FakeCodeRabbit();
    fake.pullHeadSequence = [HEAD_SHA, OLD_HEAD_SHA];
    fake.checks = [
      {
        id: "initial-success",
        appSlug: "coderabbitai",
        name: "CodeRabbit Review",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/safeflash-demo/public-firmware/runs/initial",
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

    expect(result.data).toMatchObject({
      status: "stale",
      passed: false,
      observedPrHeadSha: OLD_HEAD_SHA,
    });
    expect(result.data.exactHeadEvidenceIds).toEqual([]);
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

    expect(() =>
      createLiveIndependentReviewReceipt(passing, CODERABBIT_CONFIG),
    ).toThrow(ProviderResponseError);

    const receipt = createLiveIndependentReviewReceipt(
      {
        ...passing,
        provenance: {
          mode: "live",
          kind: "live",
          capturedAt: "2026-07-22T13:00:00.000Z",
        },
      },
      CODERABBIT_CONFIG,
    );
    expect(receipt).toMatchObject({
      provider: "coderabbit",
      sourceKind: "live-api",
      status: "passed",
      pullNumber: 42,
      headSha: HEAD_SHA,
    });
  });

  it("supports verifiable structured manual fallback without losing raw severity", () => {
    const result = createManualVerifiedCodeRabbitFinding({
      sessionId: "session-github",
      repository: CODERABBIT_CONFIG,
      pullNumber: 42,
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
    expect(result.provider).toBe("coderabbit");
    expect(result.provenance).toMatchObject({
      mode: "manual-verified",
      kind: "manual-verified",
      attestedBy: "demo-operator",
    });

    const receipt = createManualVerifiedIndependentReviewReceipt({
      repository: CODERABBIT_CONFIG,
      pullNumber: 42,
      headSha: HEAD_SHA,
      reviewUrl:
        "https://github.com/safeflash-demo/public-firmware/pull/42#pullrequestreview-42",
      status: "blocked",
      evidenceIds: ["manual-review-42"],
      attestedBy: "demo-operator",
      attestedAt: "2026-07-22T13:00:00.000Z",
    });
    expect(receipt.data).toMatchObject({
      provider: "manual_verified",
      sourceKind: "manual-attestation",
      status: "blocked",
      headSha: HEAD_SHA,
    });
    expect(receipt.provenance.kind).toBe("manual-verified");
  });

  it("rejects a manual attestation URL for another repository or PR", () => {
    expect(() =>
      createManualVerifiedCodeRabbitFinding({
        sessionId: "session-github",
        repository: CODERABBIT_CONFIG,
        pullNumber: 42,
        headSha: HEAD_SHA,
        externalId: "manual-review-evil",
        reviewUrl:
          "https://github.com/attacker/public-firmware/pull/42#pullrequestreview-42",
        rawSeverity: "major",
        title: "Unbound review",
        body: "This URL belongs to another repository.",
        attestedBy: "demo-operator",
        attestedAt: "2026-07-22T13:00:00.000Z",
      }),
    ).toThrow(ProviderResponseError);
  });
});
