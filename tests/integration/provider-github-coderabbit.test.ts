import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeFullRevalidationAttestationDigest,
  createHumanApproval,
  createValidationSession,
  transitionValidationSession,
  type ApprovalBinding,
  type FullRevalidationReceipt,
  type PullRequestRecord,
  type ValidationSession,
} from "@safeflash/domain";
import {
  CodeRabbitAdapter,
  GitHubAdapter,
  PublishAuthorizationError,
  ProviderResponseError,
  createLiveIndependentReviewReceipt,
  createManualVerifiedCodeRabbitFinding,
  createManualVerifiedIndependentReviewReceipt,
  extractCodeRabbitSeverity,
  mapCodeRabbitSeverity,
  mintPullRequestPublishAuthorization,
  readGitHubConfig,
  type CodeRabbitClientPort,
  type CodeRabbitConfig,
  type GitHubClientPort,
  type GitHubConfig,
  type GitHubPullRequestInfo,
  type PublishAuthorizationAuthority,
} from "@safeflash/integrations";
import {
  prepareCandidatePublicationData,
  type GitHubRecursiveTree,
} from "../../packages/integrations/src/github-publication";
import { createTestPublishAuthorizationAuthority } from "../../packages/integrations/src/publish-authorization";
import {
  registerOfficialTransport,
  transportEnvelope,
} from "../../packages/integrations/src/provider";

const officialCodeRabbitTestTransport = registerOfficialTransport({
  transport: "official-sdk" as const,
});

function officialCodeRabbitEnvelope<T>(data: T) {
  return transportEnvelope(
    "coderabbit",
    officialCodeRabbitTestTransport,
    data,
    "2026-07-22T13:00:00.000Z",
  );
}

const OLD_HEAD_SHA = "c".repeat(40);
const BASE_SHA = "a".repeat(40);

function gitObjectId(type: "blob" | "tree", content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

function singleEntryTree(mode: string, name: string, sha: string): string {
  return gitObjectId(
    "tree",
    Buffer.concat([
      Buffer.from(`${mode} ${name}\0`, "utf8"),
      Buffer.from(sha, "hex"),
    ]),
  );
}

function multiEntryTree(
  entries: readonly { mode: string; name: string; sha: string; tree?: boolean }[],
): string {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.name}${left.tree ? "/" : ""}`),
      Buffer.from(`${right.name}${right.tree ? "/" : ""}`),
    ),
  );
  return gitObjectId(
    "tree",
    Buffer.concat(
      sorted.flatMap((entry) => [
        Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
        Buffer.from(entry.sha, "hex"),
      ]),
    ),
  );
}

const BASE_FILE_PATH = "firmware/src/battery.c";
const BASE_FILE_CONTENT = "int read_current(void) {\n  return 0;\n}\n";
const PATCHED_FILE_CONTENT = "int read_current(void) {\n  return -1;\n}\n";
const BASE_BLOB_SHA = gitObjectId("blob", Buffer.from(BASE_FILE_CONTENT));
const PATCHED_BLOB_SHA = gitObjectId("blob", Buffer.from(PATCHED_FILE_CONTENT));
const BASE_SRC_TREE_SHA = singleEntryTree("100644", "battery.c", BASE_BLOB_SHA);
const BASE_FIRMWARE_TREE_SHA = singleEntryTree("40000", "src", BASE_SRC_TREE_SHA);
const BASE_TREE_SHA = singleEntryTree("40000", "firmware", BASE_FIRMWARE_TREE_SHA);
const PATCHED_SRC_TREE_SHA = singleEntryTree(
  "100644",
  "battery.c",
  PATCHED_BLOB_SHA,
);
const PATCHED_FIRMWARE_TREE_SHA = singleEntryTree(
  "40000",
  "src",
  PATCHED_SRC_TREE_SHA,
);
const DAYTONA_TREE_SHA = singleEntryTree(
  "40000",
  "firmware",
  PATCHED_FIRMWARE_TREE_SHA,
);
const BASE_TREE: GitHubRecursiveTree = {
  sha: BASE_TREE_SHA,
  truncated: false,
  entries: [
    {
      path: "firmware",
      mode: "040000",
      type: "tree",
      sha: BASE_FIRMWARE_TREE_SHA,
    },
    {
      path: "firmware/src",
      mode: "040000",
      type: "tree",
      sha: BASE_SRC_TREE_SHA,
    },
    {
      path: BASE_FILE_PATH,
      mode: "100644",
      type: "blob",
      sha: BASE_BLOB_SHA,
    },
  ],
};

function specialTouchedPathTree(
  mode: "100755" | "120000" | "160000",
  type: "blob" | "commit",
  sha: string,
): GitHubRecursiveTree {
  const src = singleEntryTree(mode, "battery.c", sha);
  const firmware = singleEntryTree("40000", "src", src);
  const root = singleEntryTree("40000", "firmware", firmware);
  return {
    sha: root,
    truncated: false,
    entries: [
      { path: "firmware", mode: "040000", type: "tree", sha: firmware },
      { path: "firmware/src", mode: "040000", type: "tree", sha: src },
      { path: BASE_FILE_PATH, mode, type, sha },
    ],
  };
}

const CANDIDATE = {
  candidateId: "candidate-approved",
  strategy: "fail-closed" as const,
  hypothesis: "Fail closed when current data is unavailable.",
  unifiedDiff: [
    `diff --git a/${BASE_FILE_PATH} b/${BASE_FILE_PATH}`,
    `index ${BASE_BLOB_SHA.slice(0, 7)}..${PATCHED_BLOB_SHA.slice(0, 7)} 100644`,
    `--- a/${BASE_FILE_PATH}`,
    `+++ b/${BASE_FILE_PATH}`,
    "@@ -1,3 +1,3 @@",
    " int read_current(void) {",
    "-  return 0;",
    "+  return -1;",
    " }",
    "",
  ].join("\n"),
  expectedSafetyEffect: ["Current sensor failure cannot reuse stale data."],
  risks: ["May stop output on transient read failure."],
  testsToRun: ["battery_unit_tests", "battery_safety_tests"],
};

const SOURCE_C_PATH = "fixtures/battery-controller/src/battery_controller.c";
const SOURCE_HEADER_PATH =
  "fixtures/battery-controller/include/battery_controller.h";
const SOURCE_C_CONTENT = "#include \"battery_controller.h\"\nint tick(void) { return 0; }\n";
const SOURCE_HEADER_CONTENT = "#pragma once\nint tick(void);\n";
const SOURCE_C_BLOB = gitObjectId("blob", Buffer.from(SOURCE_C_CONTENT));
const SOURCE_HEADER_BLOB = gitObjectId(
  "blob",
  Buffer.from(SOURCE_HEADER_CONTENT),
);
const SOURCE_SRC_TREE = singleEntryTree(
  "100644",
  "battery_controller.c",
  SOURCE_C_BLOB,
);
const SOURCE_INCLUDE_TREE = singleEntryTree(
  "100644",
  "battery_controller.h",
  SOURCE_HEADER_BLOB,
);
const SOURCE_CONTROLLER_TREE = multiEntryTree([
  { mode: "40000", name: "include", sha: SOURCE_INCLUDE_TREE, tree: true },
  { mode: "40000", name: "src", sha: SOURCE_SRC_TREE, tree: true },
]);
const SOURCE_FIXTURES_TREE = singleEntryTree(
  "40000",
  "battery-controller",
  SOURCE_CONTROLLER_TREE,
);
const SOURCE_ROOT_TREE = singleEntryTree(
  "40000",
  "fixtures",
  SOURCE_FIXTURES_TREE,
);
const SOURCE_TREE: GitHubRecursiveTree = {
  sha: SOURCE_ROOT_TREE,
  truncated: false,
  entries: [
    { path: "fixtures", mode: "040000", type: "tree", sha: SOURCE_FIXTURES_TREE },
    {
      path: "fixtures/battery-controller",
      mode: "040000",
      type: "tree",
      sha: SOURCE_CONTROLLER_TREE,
    },
    {
      path: "fixtures/battery-controller/include",
      mode: "040000",
      type: "tree",
      sha: SOURCE_INCLUDE_TREE,
    },
    {
      path: SOURCE_HEADER_PATH,
      mode: "100644",
      type: "blob",
      sha: SOURCE_HEADER_BLOB,
    },
    {
      path: "fixtures/battery-controller/src",
      mode: "040000",
      type: "tree",
      sha: SOURCE_SRC_TREE,
    },
    {
      path: SOURCE_C_PATH,
      mode: "100644",
      type: "blob",
      sha: SOURCE_C_BLOB,
    },
  ],
};

const GITHUB_CONFIG: GitHubConfig = {
  mode: "live",
  token: "test-only-not-a-live-token",
  owner: "safeflash-demo",
  repository: "public-firmware",
  baseBranch: "main",
  apiVersion: "2026-03-10",
};

const PUBLICATION = prepareCandidatePublicationData({
  request: {
    sessionId: "session-github",
    candidate: CANDIDATE,
    baseCommitSha: BASE_SHA,
    targetBaseCommitSha: BASE_SHA,
    expectedTreeSha: DAYTONA_TREE_SHA,
    committedAt: "2026-07-22T12:00:00.000Z",
  },
  target: {
    owner: GITHUB_CONFIG.owner,
    repository: GITHUB_CONFIG.repository,
    baseBranch: GITHUB_CONFIG.baseBranch,
  },
  baseTreeSha: BASE_TREE_SHA,
  baseTree: BASE_TREE,
  blobsByPath: {
    [BASE_FILE_PATH]: {
      sha: BASE_BLOB_SHA,
      contentBase64: Buffer.from(BASE_FILE_CONTENT).toString("base64"),
    },
  },
});
const HEAD_SHA = PUBLICATION.commitSha;
const TREE_SHA = PUBLICATION.treeSha;

const PUBLISH_AUTHORIZATION = createTestPublishAuthorizationAuthority({
  secret: Buffer.alloc(32, 0x5a),
});

const CURRENT_BINDING: ApprovalBinding = {
  candidateId: "candidate-approved",
  patchDigest: PUBLICATION.patchDigest,
  evidenceDigest: "e".repeat(64),
  policyVersion: "policy-v1",
  commitSha: HEAD_SHA,
  pullRequestTarget: {
    provider: "github",
    owner: GITHUB_CONFIG.owner,
    repository: GITHUB_CONFIG.repository,
    baseBranch: GITHUB_CONFIG.baseBranch,
  },
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

const RECEIPT_EVIDENCE = {
  sourceKind: "live-provider-evidence" as const,
  mode: "live" as const,
  validationPurpose: "review-repair" as const,
  sessionId: "session-github",
  policyVersion: CURRENT_BINDING.policyVersion,
  candidateId: CURRENT_BINDING.candidateId,
  patchDigest: CURRENT_BINDING.patchDigest,
  commitSha: HEAD_SHA,
  validatedTreeSha: TREE_SHA,
  pullRequestTarget: CURRENT_BINDING.pullRequestTarget!,
  evidenceDigest: CURRENT_BINDING.evidenceDigest,
  executionProvider: "daytona" as const,
  evaluationProvider: "braintrust" as const,
  sandboxId: "daytona-sandbox-42",
  daytonaRunId: "run-42",
  daytonaEvidenceRef: "daytona://sandbox/daytona-sandbox-42/runs/run-42",
  braintrustProjectId: "project-real-id",
  braintrustExperimentId: "experiment-real-id",
  braintrustExperimentName: "review-revalidation-real",
  braintrustExperimentRef:
    "https://www.braintrust.dev/app/safeflash/experiments/review-revalidation-real",
  buildPassed: true,
  unitTestsPassed: true,
  safetyTestsPassed: true,
  integrityChecksPassed: true,
  braintrustScored: true,
  candidateEligible: true,
};

const VALIDATION_RECEIPT: FullRevalidationReceipt = {
  ...RECEIPT_EVIDENCE,
  attestationDigest:
    computeFullRevalidationAttestationDigest(RECEIPT_EVIDENCE),
};

const PUBLISH_SESSION: ValidationSession = {
  ...createValidationSession({
    id: "session-github",
    incidentId: "incident-battery",
    policyId: "policy-battery",
    policyVersion: CURRENT_BINDING.policyVersion,
    repository: {
      repoUrl: "https://github.com/safeflash-demo/public-firmware.git",
      commitSha: BASE_SHA,
    },
    pullRequestTarget: CURRENT_BINDING.pullRequestTarget,
    mode: "live",
    sourceVersion: "workflow-v1",
    at: "2026-07-22T12:00:00.000Z",
  }),
  state: "CREATING_PULL_REQUEST",
  candidateIds: [CURRENT_BINDING.candidateId],
  selectedCandidateId: CURRENT_BINDING.candidateId,
  currentPatchDigest: CURRENT_BINDING.patchDigest,
  currentEvidenceDigest: CURRENT_BINDING.evidenceDigest,
  currentCommitSha: HEAD_SHA,
  currentValidatedTreeSha: TREE_SHA,
  approval: APPROVAL,
  lastRevalidation: VALIDATION_RECEIPT,
  revalidationSandboxIds: [VALIDATION_RECEIPT.sandboxId],
  validationRound: 1,
};

class FakeGitHub implements GitHubClientPort {
  readonly transport = "local-test" as const;
  calls: string[] = [];
  existing: GitHubPullRequestInfo[] = [];
  branchHead: string | undefined;
  branchTree = TREE_SHA;
  branchCommitSequence: { sha: string; treeSha: string }[] = [];
  branchCommitReadCount = 0;
  targetBaseHead = BASE_SHA;
  targetBaseSequence: string[] = [];
  targetBaseReadCount = 0;
  pullBaseSha = BASE_SHA;
  finalPullBaseSha?: string;
  baseTreeSha = BASE_TREE_SHA;
  treeSnapshot: GitHubRecursiveTree = BASE_TREE;
  blobsBySha = new Map<string, string>([
    [BASE_BLOB_SHA, BASE_FILE_CONTENT],
    [SOURCE_C_BLOB, SOURCE_C_CONTENT],
    [SOURCE_HEADER_BLOB, SOURCE_HEADER_CONTENT],
  ]);
  referenceSequence: Array<string | undefined> = [];
  referenceReadCount = 0;
  createdBlobShaOverride?: string;
  createdTreeSha = TREE_SHA;
  createdCommitSha = HEAD_SHA;
  onFirstNetwork?: () => void;
  networkStarted = false;
  createdTitle?: string;
  createdBody?: string;
  createdHead?: string;
  lastUpdatedBody?: string;

  async getAuthenticated() {
    this.calls.push("auth");
    return { login: "contract-user" };
  }

  async getRepository() {
    this.calls.push("repo");
    if (!this.networkStarted) {
      this.networkStarted = true;
      this.onFirstNetwork?.();
    }
    return {
      private: false,
      defaultBranch: "main",
      permissions: { push: true },
    };
  }

  async getCommit(_owner: string, _repository: string, ref: string) {
    this.calls.push("commit");
    if (ref === GITHUB_CONFIG.baseBranch) {
      const index = this.targetBaseReadCount;
      this.targetBaseReadCount += 1;
      return {
        sha: this.targetBaseSequence[index] ?? this.targetBaseHead,
        treeSha: BASE_TREE_SHA,
      };
    }
    if (ref === BASE_SHA) {
      return { sha: BASE_SHA, treeSha: this.baseTreeSha };
    }
    const index = this.branchCommitReadCount;
    this.branchCommitReadCount += 1;
    const sequenced = this.branchCommitSequence[index];
    return {
      sha: sequenced?.sha ?? this.branchHead ?? HEAD_SHA,
      treeSha: sequenced?.treeSha ?? this.branchTree,
    };
  }

  async getTree() {
    this.calls.push("tree");
    return this.treeSnapshot;
  }

  async getBlob(_owner: string, _repository: string, blobSha: string) {
    this.calls.push("blob");
    const content = this.blobsBySha.get(blobSha);
    if (content === undefined) throw new Error("missing fake blob");
    return {
      sha: blobSha,
      contentBase64: Buffer.from(content).toString("base64"),
    };
  }

  async createBlob(request: { contentBase64: string }) {
    this.calls.push("create-blob");
    const file = PUBLICATION.changedFiles.find(
      (item) => item.contentBase64 === request.contentBase64,
    );
    return {
      sha: this.createdBlobShaOverride ?? file?.blobSha ?? "f".repeat(40),
    };
  }

  async createTree() {
    this.calls.push("create-tree");
    return { sha: this.createdTreeSha };
  }

  async createCommit() {
    this.calls.push("create-commit");
    return {
      sha: this.createdCommitSha,
      treeSha: TREE_SHA,
      parentShas: [BASE_SHA],
    };
  }

  async getBranchReference() {
    this.calls.push("get-ref");
    const index = this.referenceReadCount;
    this.referenceReadCount += 1;
    if (index < this.referenceSequence.length) {
      const sha = this.referenceSequence[index];
      return sha === undefined ? undefined : { sha, type: "commit" };
    }
    return this.branchHead === undefined
      ? undefined
      : { sha: this.branchHead, type: "commit" };
  }

  async createBranchReference(request: { commitSha: string }) {
    this.calls.push("create-ref");
    this.branchHead = request.commitSha;
    this.branchTree = TREE_SHA;
    return { sha: request.commitSha, type: "commit" };
  }

  async updateBranchReference(request: { commitSha: string; force: false }) {
    this.calls.push("update-ref");
    expect(request.force).toBe(false);
    this.branchHead = request.commitSha;
    this.branchTree = TREE_SHA;
    return { sha: request.commitSha, type: "commit" };
  }

  async getPullRequest(_owner: string, _repository: string, pullNumber: number) {
    this.calls.push("get-pr");
    return {
      number: pullNumber,
      htmlUrl: `https://github.com/safeflash-demo/public-firmware/pull/${pullNumber}`,
      state: "open" as const,
      merged: false,
      headSha: this.branchHead ?? HEAD_SHA,
      headRef: "safeflash/session-github",
      baseRef: "main",
      baseSha: this.finalPullBaseSha ?? this.pullBaseSha,
    };
  }

  async listOpenPullRequests() {
    this.calls.push("list-prs");
    return this.existing.map((item) => ({
      ...item,
      headSha: this.branchHead ?? item.headSha,
    }));
  }

  async createPullRequest(request: {
    title: string;
    body: string;
    head: string;
  }) {
    this.calls.push("create-pr");
    this.createdTitle = request.title;
    this.createdBody = request.body;
    this.createdHead = request.head;
    return {
      number: 42,
      htmlUrl: "https://github.com/safeflash-demo/public-firmware/pull/42",
      state: "open" as const,
      merged: false,
      headSha: this.branchHead ?? HEAD_SHA,
      headRef: "safeflash/session-github",
      baseRef: "main",
      baseSha: this.pullBaseSha,
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
    return { ...current, headSha: this.branchHead ?? current.headSha };
  }
}

function createUnsignedRequest() {
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
        VALIDATION_RECEIPT.braintrustExperimentRef,
      daytonaEvidenceRef: VALIDATION_RECEIPT.daytonaEvidenceRef,
      evidenceDigest: CURRENT_BINDING.evidenceDigest,
    },
    approval: APPROVAL,
    currentBinding: CURRENT_BINDING,
    validationReceipt: VALIDATION_RECEIPT,
    publication: PUBLICATION,
  };
}

function createRequest() {
  const request = createUnsignedRequest();
  return {
    ...request,
    publishAuthorization: mintPullRequestPublishAuthorization(
      PUBLISH_AUTHORIZATION,
      PUBLISH_SESSION,
      request,
      GITHUB_CONFIG,
    ),
  };
}

function githubAdapter(
  fake: GitHubClientPort,
  clock: () => Date = () => new Date(),
) {
  return new GitHubAdapter(
    GITHUB_CONFIG,
    fake,
    clock,
    PUBLISH_AUTHORIZATION,
  );
}

async function expectSafeGitHubFailure(
  operation: Promise<unknown>,
  retryable: boolean,
  forbiddenSecret: string,
): Promise<ProviderResponseError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProviderResponseError);
  const providerError = caught as ProviderResponseError;
  expect(providerError).toMatchObject({ provider: "github", retryable });
  expect(providerError.message).not.toContain(forbiddenSecret);
  expect(providerError.cause).toBeUndefined();
  return providerError;
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
  pullBaseSha = BASE_SHA;
  pullBaseSequence: string[] = [];
  pullReadCount = 0;

  async getPullRequest() {
    const headSha = this.pullHeadSequence[this.pullReadCount] ?? this.pullHeadSha;
    const baseSha = this.pullBaseSequence[this.pullReadCount] ?? this.pullBaseSha;
    this.pullReadCount += 1;
    return {
      number: 42,
      headSha,
      baseRef: "main",
      baseSha,
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
      baseHeadSha: BASE_SHA,
      baseTreeSha: BASE_TREE_SHA,
    });
  });

  it("classifies HTTP 408, 429, and every 5xx response as retryable without exposing response data", async () => {
    for (const status of [408, 429, 500, 501, 502, 503, 504, 599]) {
      const fake = new FakeGitHub();
      const secret = `ghp_sensitive_http_${status}`;
      fake.getAuthenticated = async () => {
        throw {
          status,
          message: `request failed with ${secret}`,
          response: { status, data: { token: secret } },
        };
      };
      const error = await expectSafeGitHubFailure(
        new GitHubAdapter(GITHUB_CONFIG, fake).smokeReadiness(),
        true,
        secret,
      );
      expect(error.message).toBe(
        "GitHub authentication/repository smoke failed",
      );
    }
  });

  it("classifies authentication, authorization, not-found, and validation HTTP responses as nonretryable", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const fake = new FakeGitHub();
      const secret = `github-response-body-${status}`;
      fake.getAuthenticated = async () => {
        throw {
          status,
          code: "ETIMEDOUT",
          message: secret,
          response: { status, data: secret },
        };
      };
      await expectSafeGitHubFailure(
        new GitHubAdapter(GITHUB_CONFIG, fake).smokeReadiness(),
        false,
        secret,
      );
    }
  });

  it("classifies explicit transient network failures, including nested causes, as retryable", async () => {
    const failures: readonly unknown[] = [
      Object.assign(new Error("network-secret-ECONNRESET"), {
        code: "ECONNRESET",
      }),
      Object.assign(new Error("network-secret-ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
      new Error("request timeout network-secret-timeout"),
      {
        message: "outer network-secret-EAI_AGAIN",
        cause: Object.assign(new Error("nested network-secret-EAI_AGAIN"), {
          code: "EAI_AGAIN",
        }),
      },
    ];
    for (const [index, failure] of failures.entries()) {
      const fake = new FakeGitHub();
      fake.getAuthenticated = async () => {
        throw failure;
      };
      await expectSafeGitHubFailure(
        new GitHubAdapter(GITHUB_CONFIG, fake).smokeReadiness(),
        true,
        `network-secret-${["ECONNRESET", "ETIMEDOUT", "timeout", "EAI_AGAIN"][index]}`,
      );
    }
  });

  it("uses the same retry classification at source-read, preparation, and PR-mutation boundaries", async () => {
    const source = new FakeGitHub();
    source.getCommit = async () => {
      throw {
        response: { status: 503, data: "source-read-secret" },
        message: "source-read-secret",
      };
    };
    await expectSafeGitHubFailure(
      githubAdapter(source).readCandidateSourceContext({
        sessionId: "session-github",
        commitSha: BASE_SHA,
        allowedPaths: [SOURCE_C_PATH, SOURCE_HEADER_PATH],
        maxBytes: 32 * 1024,
      }),
      true,
      "source-read-secret",
    );

    const preparation = new FakeGitHub();
    preparation.getTree = async () => {
      throw Object.assign(new Error("preparation-secret"), {
        code: "ECONNRESET",
      });
    };
    await expectSafeGitHubFailure(
      githubAdapter(preparation).prepareCandidatePublication({
        sessionId: "session-github",
        candidate: CANDIDATE,
        baseCommitSha: BASE_SHA,
        targetBaseCommitSha: BASE_SHA,
        expectedTreeSha: DAYTONA_TREE_SHA,
        committedAt: "2026-07-22T12:00:00.000Z",
      }),
      true,
      "preparation-secret",
    );

    const mutation = new FakeGitHub();
    mutation.getRepository = async () => {
      throw Object.assign(new Error("mutation-secret"), { code: "EAI_AGAIN" });
    };
    const request = createRequest();
    await expectSafeGitHubFailure(
      githubAdapter(mutation).createOrGetPullRequest(request),
      true,
      "mutation-secret",
    );
    await expect(
      githubAdapter(mutation).createOrGetPullRequest(request),
    ).rejects.toMatchObject({ code: "REPLAYED" });
  });

  it("keeps adapter consistency failures nonretryable", async () => {
    const fake = new FakeGitHub();
    fake.targetBaseHead = OLD_HEAD_SHA;
    const error = await expectSafeGitHubFailure(
      githubAdapter(fake).prepareCandidatePublication({
        sessionId: "session-github",
        candidate: CANDIDATE,
        baseCommitSha: BASE_SHA,
        targetBaseCommitSha: BASE_SHA,
        expectedTreeSha: DAYTONA_TREE_SHA,
        committedAt: "2026-07-22T12:00:00.000Z",
      }),
      false,
      GITHUB_CONFIG.token,
    );
    expect(error.message).toMatch(/base branch moved/u);
  });

  it("prepares exact candidate Git objects using only immutable GitHub reads", async () => {
    const fake = new FakeGitHub();
    const result = await githubAdapter(fake).prepareCandidatePublication({
      sessionId: "session-github",
      candidate: CANDIDATE,
      baseCommitSha: BASE_SHA,
      targetBaseCommitSha: BASE_SHA,
      expectedTreeSha: DAYTONA_TREE_SHA,
      committedAt: "2026-07-22T12:00:00.000Z",
    });
    expect(result.data).toEqual(PUBLICATION);
    expect(fake.calls.filter((call) => call === "commit")).toHaveLength(2);
    expect(fake.calls).toContain("tree");
    expect(fake.calls).toContain("blob");
    expect(fake.calls.some((call) => call.startsWith("create-"))).toBe(false);
    expect(fake.calls).not.toContain("update-ref");
    expect(fake.calls).not.toContain("create-pr");
    const identity = `${PUBLICATION.author.name} <${PUBLICATION.author.email}> ${Math.floor(
      Date.parse(PUBLICATION.committedAt) / 1_000,
    )} +0000`;
    const rawCommit = [
      `tree ${PUBLICATION.treeSha}`,
      `parent ${PUBLICATION.baseCommitSha}`,
      `author ${identity}`,
      `committer ${identity}`,
      "",
      PUBLICATION.commitMessage,
    ].join("\n");
    expect(
      execFileSync("git", ["hash-object", "-t", "commit", "--stdin"], {
        input: rawCommit,
        encoding: "utf8",
      }).trim(),
    ).toBe(PUBLICATION.commitSha);
  });

  it("refuses to publish a patch against symlink, gitlink, or non-100644 base paths", async () => {
    const unsafeTrees = [
      specialTouchedPathTree("100755", "blob", BASE_BLOB_SHA),
      specialTouchedPathTree("120000", "blob", BASE_BLOB_SHA),
      specialTouchedPathTree("160000", "commit", "9".repeat(40)),
    ];
    for (const tree of unsafeTrees) {
      const fake = new FakeGitHub();
      fake.baseTreeSha = tree.sha;
      fake.treeSnapshot = tree;
      await expect(
        githubAdapter(fake).prepareCandidatePublication({
          sessionId: "session-github",
          candidate: CANDIDATE,
          baseCommitSha: BASE_SHA,
          targetBaseCommitSha: BASE_SHA,
          expectedTreeSha: DAYTONA_TREE_SHA,
          committedAt: "2026-07-22T12:00:00.000Z",
        }),
      ).rejects.toThrow(/regular base-tree file/u);
      expect(fake.calls.some((call) => call.startsWith("create-"))).toBe(false);
      expect(fake.calls).not.toContain("update-ref");
    }
  });

  it("reads only server-registered exact-commit source context as verified UTF-8", async () => {
    const fake = new FakeGitHub();
    fake.baseTreeSha = SOURCE_ROOT_TREE;
    fake.treeSnapshot = SOURCE_TREE;
    const result = await githubAdapter(fake).readCandidateSourceContext({
      sessionId: "session-github",
      commitSha: BASE_SHA,
      allowedPaths: [SOURCE_C_PATH, SOURCE_HEADER_PATH],
      maxBytes: 32 * 1024,
    });
    expect(result.data.commitSha).toBe(BASE_SHA);
    expect(result.data.files.map((file) => file.path)).toEqual([
      SOURCE_HEADER_PATH,
      SOURCE_C_PATH,
    ]);
    expect(result.data.files).toEqual([
      {
        path: SOURCE_HEADER_PATH,
        content: SOURCE_HEADER_CONTENT,
        contentSha256: createHash("sha256")
          .update(SOURCE_HEADER_CONTENT)
          .digest("hex"),
      },
      {
        path: SOURCE_C_PATH,
        content: SOURCE_C_CONTENT,
        contentSha256: createHash("sha256").update(SOURCE_C_CONTENT).digest("hex"),
      },
    ]);
    expect(result.data.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(fake.calls).toEqual(["commit", "tree", "blob", "blob"]);
    expect(fake.calls.some((call) => call.startsWith("create-"))).toBe(false);

    const attacker = new FakeGitHub();
    await expect(
      githubAdapter(attacker).readCandidateSourceContext({
        sessionId: "session-github",
        commitSha: BASE_SHA,
        allowedPaths: [".env"],
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/server-owned P0 path/u);
    expect(attacker.calls).toEqual([]);
  });

  it("requires and verifies publish authorization before the first GitHub call", async () => {
    const request = createRequest();

    const missingConsumer = new FakeGitHub();
    await expect(
      new GitHubAdapter(GITHUB_CONFIG, missingConsumer).createOrGetPullRequest(
        request,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    expect(missingConsumer.calls).toEqual([]);

    const forgedConsumer = new FakeGitHub();
    const noOpConsumer = {
      consume: () => {
        throw new Error("forged consumer must never run");
      },
    } as unknown as PublishAuthorizationAuthority;
    await expect(
      new GitHubAdapter(
        GITHUB_CONFIG,
        forgedConsumer,
        () => new Date(),
        noOpConsumer,
      ).createOrGetPullRequest(createRequest()),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(forgedConsumer.calls).toEqual([]);

    const tampered = new FakeGitHub();
    const [prefix, payload, mac] = request.publishAuthorization.split(".") as [
      string,
      string,
      string,
    ];
    const tamperedMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    const tamperedToken = `${prefix}.${payload}.${tamperedMac}`;
    await expect(
      githubAdapter(tampered).createOrGetPullRequest({
        ...request,
        publishAuthorization: tamperedToken,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MAC",
    });
    expect(tampered.calls).toEqual([]);
  });

  it("publishes the frozen authorized snapshot when the caller mutates after the first await", async () => {
    const fake = new FakeGitHub();
    const request = createRequest();
    const authorizedTitle = request.title;
    const authorizedIncident = request.description.incident;
    fake.onFirstNetwork = () => {
      request.title = "ATTACKER TITLE";
      request.headBranch = "safeflash/attacker-race";
      request.description.incident = "ATTACKER INCIDENT";
    };

    const result = await githubAdapter(fake).createOrGetPullRequest(request);
    expect(result.data.headSha).toBe(HEAD_SHA);
    expect(fake.createdTitle).toBe(authorizedTitle);
    expect(fake.createdHead).toBe(PUBLICATION.headBranch);
    expect(fake.createdBody).toContain(authorizedIncident);
    expect(fake.createdBody).not.toContain("ATTACKER");
  });

  it("mints only from the authoritative live CREATING_PULL_REQUEST session", () => {
    const request = createUnsignedRequest();
    for (const session of [
      { ...PUBLISH_SESSION, state: "AWAITING_HUMAN_APPROVAL" as const },
      { ...PUBLISH_SESSION, approval: undefined },
      { ...PUBLISH_SESSION, lastRevalidation: undefined },
      { ...PUBLISH_SESSION, currentValidatedTreeSha: "f".repeat(40) },
      { ...PUBLISH_SESSION, revalidationSandboxIds: [] },
    ]) {
      expect(() =>
        mintPullRequestPublishAuthorization(
          PUBLISH_AUTHORIZATION,
          session,
          request,
          GITHUB_CONFIG,
        ),
      ).toThrow(PublishAuthorizationError);
    }
    expect(
      mintPullRequestPublishAuthorization(
        PUBLISH_AUTHORIZATION,
        PUBLISH_SESSION,
        request,
        GITHUB_CONFIG,
      ),
    ).toMatch(/^sfpa1\./u);
  });

  it("uses the candidate sandbox map for an initial-selection receipt", () => {
    const initialEvidence = {
      ...RECEIPT_EVIDENCE,
      validationPurpose: "initial-selection" as const,
      sandboxId: "daytona-initial-candidate",
      daytonaRunId: "initial-candidate-run",
      daytonaEvidenceRef:
        "daytona://sandbox/daytona-initial-candidate/runs/initial-candidate-run",
      braintrustExperimentId: "initial-candidate-experiment",
      braintrustExperimentName: "initial-candidate-experiment",
      braintrustExperimentRef:
        "https://www.braintrust.dev/app/safeflash/experiments/initial-candidate-experiment",
    };
    const initialReceipt: FullRevalidationReceipt = {
      ...initialEvidence,
      attestationDigest:
        computeFullRevalidationAttestationDigest(initialEvidence),
    };
    const baseRequest = createUnsignedRequest();
    const initialRequest = {
      ...baseRequest,
      description: {
        ...baseRequest.description,
        braintrustExperimentUrl: initialReceipt.braintrustExperimentRef,
        daytonaEvidenceRef: initialReceipt.daytonaEvidenceRef,
      },
      validationReceipt: initialReceipt,
    };
    const initialSession: ValidationSession = {
      ...PUBLISH_SESSION,
      lastRevalidation: initialReceipt,
      sandboxIdsByCandidate: {
        [CURRENT_BINDING.candidateId]: initialReceipt.sandboxId,
      },
      revalidationSandboxIds: [],
    };

    expect(
      mintPullRequestPublishAuthorization(
        PUBLISH_AUTHORIZATION,
        initialSession,
        initialRequest,
        GITHUB_CONFIG,
      ),
    ).toMatch(/^sfpa1\./u);
    expect(() =>
      mintPullRequestPublishAuthorization(
        PUBLISH_AUTHORIZATION,
        { ...initialSession, sandboxIdsByCandidate: {} },
        initialRequest,
        GITHUB_CONFIG,
      ),
    ).toThrow(PublishAuthorizationError);
  });

  it("consumes a publish authorization exactly once before network mutation", async () => {
    const fake = new FakeGitHub();
    const request = createRequest();
    await githubAdapter(fake).createOrGetPullRequest(request);
    const callsAfterFirstMutation = [...fake.calls];

    await expect(
      githubAdapter(fake).createOrGetPullRequest(request),
    ).rejects.toMatchObject({
      code: "REPLAYED",
    });
    expect(fake.calls).toEqual(callsAfterFirstMutation);
  });

  it("blocks PR creation without a current approval before any GitHub call", async () => {
    const fake = new FakeGitHub();
    const invalidApproval = { ...APPROVAL, evidenceDigest: "stale-evidence" };
    await expect(
      githubAdapter(fake).createOrGetPullRequest({
        ...createRequest(),
        approval: invalidApproval,
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(fake.calls).toEqual([]);
  });

  it("rejects an approval whose repository target differs from server config", async () => {
    const fake = new FakeGitHub();
    const attackerBinding: ApprovalBinding = {
      ...CURRENT_BINDING,
      pullRequestTarget: {
        provider: "github",
        owner: "attacker",
        repository: GITHUB_CONFIG.repository,
        baseBranch: GITHUB_CONFIG.baseBranch,
      },
    };
    const attackerApproval = createHumanApproval({
      id: "approval-attacker-target",
      sessionId: "session-github",
      approverId: "human-operator",
      decision: "approved",
      sourceVersion: "v1",
      actedAt: "2026-07-22T12:00:00.000Z",
      ...attackerBinding,
    });
    await expect(
      githubAdapter(fake).createOrGetPullRequest({
        ...createRequest(),
        approval: attackerApproval,
        currentBinding: attackerBinding,
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
      {
        description: {
          ...createRequest().description,
          braintrustExperimentUrl: "https://attacker.invalid/experiment/fake",
        },
      },
      {
        description: {
          ...createRequest().description,
          daytonaEvidenceRef: "daytona://sandbox/fake/runs/fake",
        },
      },
      { expectedHeadSha: OLD_HEAD_SHA },
      { headBranch: "safeflash/session-github/patch-v2" },
    ];

    for (const mutation of mutations) {
      const fake = new FakeGitHub();
      await expect(
        githubAdapter(fake).createOrGetPullRequest({
          ...createRequest(),
          ...mutation,
        }),
      ).rejects.toBeInstanceOf(ProviderResponseError);
      expect(fake.calls).toEqual([]);
    }
  });

  it("creates only an open unmerged PR at the exact approved head", async () => {
    const fake = new FakeGitHub();
    const result = await githubAdapter(
      fake,
      () => new Date("2026-07-22T12:30:00.000Z"),
    ).createOrGetPullRequest(createRequest());
    expect(fake.calls).toContain("create-blob");
    expect(fake.calls).toContain("create-tree");
    expect(fake.calls).toContain("create-commit");
    expect(fake.calls).toContain("create-ref");
    expect(fake.calls).not.toContain("update-ref");
    expect(fake.calls.indexOf("create-ref")).toBeLessThan(
      fake.calls.indexOf("create-pr"),
    );
    expect(result.data).toMatchObject({
      number: 42,
      headSha: HEAD_SHA,
      headTreeSha: TREE_SHA,
      status: "open",
    });
    expect("merge" in fake).toBe(false);
  });

  it("fast-forwards an existing stable branch without force before PR mutation", async () => {
    const fake = new FakeGitHub();
    fake.branchHead = BASE_SHA;
    const result = await githubAdapter(fake).createOrGetPullRequest(
      createRequest(),
    );
    expect(result.data.headSha).toBe(HEAD_SHA);
    expect(fake.calls).toContain("update-ref");
    expect(fake.calls).not.toContain("create-ref");
    expect(fake.calls.indexOf("update-ref")).toBeLessThan(
      fake.calls.indexOf("create-pr"),
    );
  });

  it("is idempotent and refuses a changed remote head", async () => {
    const fake = new FakeGitHub();
    fake.branchHead = HEAD_SHA;
    fake.existing = [
      {
        number: 42,
        htmlUrl: "https://github.com/safeflash-demo/public-firmware/pull/42",
        state: "open",
        merged: false,
        headSha: HEAD_SHA,
        headRef: "safeflash/session-github",
        baseRef: "main",
        baseSha: BASE_SHA,
      },
    ];
    await githubAdapter(fake).createOrGetPullRequest(
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
    changed.branchHead = OLD_HEAD_SHA;
    await expect(
      githubAdapter(changed).createOrGetPullRequest(
        createRequest(),
      ),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(changed.calls).not.toContain("create-blob");
    expect(changed.calls).not.toContain("create-pr");

    const changedTree = new FakeGitHub();
    changedTree.createdTreeSha = "f".repeat(40);
    await expect(
      githubAdapter(changedTree).createOrGetPullRequest(
        createRequest(),
      ),
    ).rejects.toThrow(/Daytona-validated tree/u);
    expect(changedTree.calls).toContain("create-tree");
    expect(changedTree.calls).not.toContain("create-commit");
    expect(changedTree.calls).not.toContain("create-ref");
    expect(changedTree.calls).not.toContain("create-pr");

    const branchMovedDuringMutation = new FakeGitHub();
    branchMovedDuringMutation.referenceSequence = [undefined, OLD_HEAD_SHA];
    await expect(
      githubAdapter(branchMovedDuringMutation).createOrGetPullRequest(
        createRequest(),
      ),
    ).rejects.toThrow(/changed during publication/u);
    expect(branchMovedDuringMutation.calls).toContain("create-commit");
    expect(branchMovedDuringMutation.calls).not.toContain("create-ref");
    expect(branchMovedDuringMutation.calls).not.toContain("update-ref");
    expect(branchMovedDuringMutation.calls).not.toContain("create-pr");
  });

  it("fails closed on configured base drift before any Git object or ref write", async () => {
    const fake = new FakeGitHub();
    fake.targetBaseHead = OLD_HEAD_SHA;
    await expect(
      githubAdapter(fake).createOrGetPullRequest(createRequest()),
    ).rejects.toThrow(/base branch moved/u);
    expect(fake.calls).not.toContain("create-blob");
    expect(fake.calls).not.toContain("create-tree");
    expect(fake.calls).not.toContain("create-commit");
    expect(fake.calls).not.toContain("create-ref");
    expect(fake.calls).not.toContain("update-ref");
    expect(fake.calls).not.toContain("create-pr");
  });

  it("rejects both the PR mutation response and final reread when their exact base SHA drifts", async () => {
    const driftedCreate = new FakeGitHub();
    driftedCreate.pullBaseSha = OLD_HEAD_SHA;
    await expect(
      githubAdapter(driftedCreate).createOrGetPullRequest(createRequest()),
    ).rejects.toThrow(/approved head SHA/u);

    const driftedReread = new FakeGitHub();
    driftedReread.finalPullBaseSha = OLD_HEAD_SHA;
    await expect(
      githubAdapter(driftedReread).createOrGetPullRequest(createRequest()),
    ).rejects.toThrow(/Daytona-validated tree/u);
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });
    expect(inspection.data).toMatchObject({ status: "blocked", passed: false });
    expect(inspection.data.findings[0]?.finding.reviewUrl).toContain("/runs/991");

    const receipt = createLiveIndependentReviewReceipt(
      officialCodeRabbitEnvelope(inspection.data),
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
      pullRequestTarget: {
        provider: "github",
        owner: GITHUB_CONFIG.owner,
        repository: GITHUB_CONFIG.repository,
        baseBranch: GITHUB_CONFIG.baseBranch,
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
      headTreeSha: TREE_SHA,
      baseBranch: GITHUB_CONFIG.baseBranch,
      baseSha: BASE_SHA,
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });

    expect(result.data).toMatchObject({
      status: "stale",
      passed: false,
      observedPrHeadSha: OLD_HEAD_SHA,
    });
    expect(result.data.exactHeadEvidenceIds).toEqual([]);
  });

  it("terminates review without polling when the initial PR base SHA has drifted", async () => {
    const fake = new FakeCodeRabbit();
    fake.pullBaseSha = OLD_HEAD_SHA;
    let waits = 0;
    const result = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      fake,
      () => 1_000,
      async () => {
        waits += 1;
      },
    ).waitForReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });

    expect(result.data).toMatchObject({
      status: "blocked",
      passed: false,
      timedOut: false,
      requiresFullRevalidation: true,
      expectedBaseSha: BASE_SHA,
      observedBaseSha: OLD_HEAD_SHA,
    });
    expect(waits).toBe(0);
    expect(() =>
      createLiveIndependentReviewReceipt(
        officialCodeRabbitEnvelope(result.data),
        CODERABBIT_CONFIG,
      ),
    ).toThrow(/exact current PR head/u);
  });

  it("invalidates a successful review when the PR base moves during the final reread", async () => {
    const fake = new FakeCodeRabbit();
    fake.pullBaseSequence = [BASE_SHA, OLD_HEAD_SHA];
    fake.checks = [
      {
        id: "check-before-base-drift",
        appSlug: "coderabbitai",
        name: "CodeRabbit Review",
        headSha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/safeflash-demo/public-firmware/runs/base-drift",
      },
    ];
    const result = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      fake,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });

    expect(result.data).toMatchObject({
      status: "blocked",
      passed: false,
      timedOut: false,
      requiresFullRevalidation: true,
      observedBaseSha: OLD_HEAD_SHA,
    });
  });

  it("blocks unknown inline findings but keeps unknown summaries informational", async () => {
    const successCheck = {
      id: "check-success-unknown-severity",
      appSlug: "coderabbitai",
      name: "CodeRabbit Review",
      headSha: HEAD_SHA,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/safeflash-demo/public-firmware/runs/unknown-severity",
    } as const;
    const inline = new FakeCodeRabbit();
    inline.comments = [
      {
        id: "comment-unlabelled",
        actorLogin: "coderabbitai[bot]",
        body: "This retry can restore charging after the fault latch opens.",
        commitId: HEAD_SHA,
        url: "https://github.com/safeflash-demo/public-firmware/pull/42#discussion-unknown",
        path: "fixtures/battery-controller/src/battery_controller.c",
        line: 40,
      },
    ];
    inline.checks = [successCheck];
    const blocked = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      inline,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });
    expect(blocked.data.status).toBe("blocked");
    expect(blocked.data.findings[0]).toMatchObject({
      rawSeverity: "unknown",
      sourceKind: "review-comment",
      finding: { severity: "high" },
    });

    const summary = new FakeCodeRabbit();
    summary.reviews = [
      {
        id: "summary-unlabelled",
        actorLogin: "coderabbitai[bot]",
        state: "COMMENTED",
        body: "Review completed with implementation notes.",
        commitId: HEAD_SHA,
        url: "https://github.com/safeflash-demo/public-firmware/pull/42#review-summary",
      },
    ];
    summary.checks = [successCheck];
    const passed = await new CodeRabbitAdapter(
      CODERABBIT_CONFIG,
      summary,
    ).inspectReview({
      sessionId: "session-github",
      pullNumber: 42,
      headSha: HEAD_SHA,
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });
    expect(passed.data.status).toBe("passed");
    expect(passed.data.findings[0]).toMatchObject({
      rawSeverity: "unknown",
      sourceKind: "review",
      finding: { severity: "info" },
    });
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
    });
    expect(passing.data.status).toBe("passed");
    expect(passing.data.passed).toBe(true);
    expect(passing.data.findings[0]).toMatchObject({
      rawSeverity: "minor",
      sourceKind: "review-comment",
      finding: { severity: "medium" },
    });

    expect(() =>
      createLiveIndependentReviewReceipt(passing, CODERABBIT_CONFIG),
    ).toThrow(ProviderResponseError);

    const receipt = createLiveIndependentReviewReceipt(
      officialCodeRabbitEnvelope(passing.data),
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
      expectedBaseRef: GITHUB_CONFIG.baseBranch,
      expectedBaseSha: BASE_SHA,
      observedBaseRef: GITHUB_CONFIG.baseBranch,
      observedBaseSha: BASE_SHA,
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
