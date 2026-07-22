import {
  evaluateCodeRabbitGate,
  type IndependentReviewReceipt,
  type OperatingMode,
  type ReviewFinding,
  type Severity,
} from "@safeflash/domain";

import {
  GITHUB_API_VERSION,
  isSafeGitHubOwner,
  isSafeGitHubRepository,
  isSafeGitRef,
  type GitHubConfig,
} from "./github";
import {
  ProviderResponseError,
  manualVerifiedEnvelope,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";

export type CodeRabbitRawSeverity =
  | "critical"
  | "major"
  | "high"
  | "minor"
  | "nitpick"
  | "trivial"
  | "info"
  | "unknown"
  | "request_changes"
  | "check_failure";

export interface CodeRabbitConfig extends GitHubConfig {
  reviewTimeoutMs: number;
  pollIntervalMs: number;
}

export interface CodeRabbitReviewArtifact {
  id: string;
  actorLogin: string;
  state: string;
  body: string;
  commitId?: string;
  url: string;
  submittedAt?: string;
}

export interface CodeRabbitCommentArtifact {
  id: string;
  actorLogin: string;
  body: string;
  commitId?: string;
  url: string;
  path?: string;
  line?: number;
  createdAt?: string;
}

export interface CodeRabbitCheckArtifact {
  id: string;
  appSlug?: string;
  name: string;
  headSha: string;
  status: string;
  conclusion?: string;
  url: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CodeRabbitPullRequestArtifact {
  number: number;
  headSha: string;
  baseRef: string;
  state: "open" | "closed";
  merged: boolean;
  url: string;
}

export interface CodeRabbitClientPort {
  readonly transport: ProviderTransport;
  getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
  ): Promise<CodeRabbitPullRequestArtifact>;
  listReviews(
    owner: string,
    repository: string,
    pullNumber: number,
  ): Promise<readonly CodeRabbitReviewArtifact[]>;
  listReviewComments(
    owner: string,
    repository: string,
    pullNumber: number,
  ): Promise<readonly CodeRabbitCommentArtifact[]>;
  listChecksForRef(
    owner: string,
    repository: string,
    headSha: string,
  ): Promise<readonly CodeRabbitCheckArtifact[]>;
}

export interface NormalizedCodeRabbitFinding {
  finding: ReviewFinding;
  rawSeverity: CodeRabbitRawSeverity;
  sourceKind: "review" | "review-comment" | "check" | "manual-attestation";
  headSha: string;
}

export interface CodeRabbitInspectionEvidence {
  pullNumber: number;
  headSha: string;
  observedPrHeadSha: string;
  status: "passed" | "blocked" | "pending" | "stale";
  passed: boolean;
  timedOut: boolean;
  findings: readonly NormalizedCodeRabbitFinding[];
  exactHeadEvidenceIds: readonly string[];
  staleEvidenceIds: readonly string[];
  reason: string;
}

export interface CodeRabbitInspectionRequest {
  sessionId: string;
  pullNumber: number;
  headSha: string;
}

/**
 * Converts only authentic live adapter output into the receipt accepted by the
 * workflow state machine. Local-test, mock, cached, stale and timed-out
 * envelopes deliberately cannot cross the live independent-review gate.
 */
export function createLiveIndependentReviewReceipt(
  inspection: ProviderEnvelope<CodeRabbitInspectionEvidence>,
  repository: Pick<CodeRabbitConfig, "owner" | "repository">,
): IndependentReviewReceipt {
  const { data, provenance } = inspection;
  const terminal = data.status === "passed" || data.status === "blocked";
  const statusConsistent =
    (data.status === "passed" && data.passed) ||
    (data.status === "blocked" && !data.passed);
  if (
    inspection.provider !== "coderabbit" ||
    provenance.kind !== "live" ||
    !terminal ||
    !statusConsistent ||
    data.timedOut ||
    data.headSha.toLowerCase() !== data.observedPrHeadSha.toLowerCase() ||
    data.exactHeadEvidenceIds.length === 0
  ) {
    throw new ProviderResponseError(
      "coderabbit",
      "Only terminal live CodeRabbit evidence for the exact current PR head can create a workflow review receipt",
      false,
    );
  }
  // Findings may legitimately point to a GitHub check run rather than a PR
  // discussion. Keep the receipt itself on the canonical PR URL; individual
  // findings retain their same-repository evidence URLs and exact head SHA.
  const reviewUrl = `https://github.com/${encodeURIComponent(
    repository.owner,
  )}/${encodeURIComponent(repository.repository)}/pull/${data.pullNumber}`;
  return {
    provider: "coderabbit",
    sourceKind: "live-api",
    status: data.status === "passed" ? "passed" : "blocked",
    pullNumber: data.pullNumber,
    headSha: data.headSha,
    reviewUrl,
    evidenceIds: [...data.exactHeadEvidenceIds],
    capturedAt: provenance.capturedAt,
  };
}

export function readCodeRabbitConfig(
  environment: Environment = process.env,
  mode: OperatingMode = "live",
): CodeRabbitConfig {
  const values = requireLiveConfiguration(
    "coderabbit",
    mode,
    environment,
    ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"] as const,
  );
  const reviewTimeoutMs = Number(
    environment.CODERABBIT_REVIEW_TIMEOUT_MS ?? 180_000,
  );
  const pollIntervalMs = Number(
    environment.CODERABBIT_POLL_INTERVAL_MS ?? 5_000,
  );
  const baseBranch = environment.GITHUB_BASE_BRANCH?.trim() || "main";
  if (
    !isSafeGitHubOwner(values.GITHUB_OWNER) ||
    !isSafeGitHubRepository(values.GITHUB_REPO) ||
    !isSafeGitRef(baseBranch) ||
    !Number.isInteger(reviewTimeoutMs) ||
    reviewTimeoutMs < 1_000 ||
    reviewTimeoutMs > 900_000 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 250 ||
    pollIntervalMs > 60_000 ||
    pollIntervalMs > reviewTimeoutMs
  ) {
    throw new ProviderResponseError(
      "coderabbit",
      "Invalid CodeRabbit repository coordinate, base branch, polling timeout, or interval",
      false,
    );
  }
  return {
    mode: "live",
    token: values.GITHUB_TOKEN,
    owner: values.GITHUB_OWNER,
    repository: values.GITHUB_REPO,
    baseBranch,
    apiVersion: GITHUB_API_VERSION,
    reviewTimeoutMs,
    pollIntervalMs,
  };
}

export function createCodeRabbitClient(
  config: CodeRabbitConfig,
): CodeRabbitClientPort {
  const octokitPromise = import("octokit").then(
    ({ Octokit }) =>
      new Octokit({
        auth: config.token,
        request: { headers: { "X-GitHub-Api-Version": config.apiVersion } },
      }),
  );
  return {
    transport: "official-sdk",
    async getPullRequest(owner, repository, pullNumber) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.pulls.get({
        owner,
        repo: repository,
        pull_number: pullNumber,
      });
      return {
        number: response.data.number,
        headSha: response.data.head.sha,
        baseRef: response.data.base.ref,
        state: response.data.state,
        merged: response.data.merged,
        url: response.data.html_url,
      };
    },
    async listReviews(owner, repository, pullNumber) {
      const octokit = await octokitPromise;
      const rows = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo: repository,
        pull_number: pullNumber,
        per_page: 100,
      });
      return rows.map((review) => ({
        id: String(review.id),
        actorLogin: review.user?.login ?? "unknown",
        state: review.state,
        body: review.body ?? "",
        commitId: review.commit_id ?? undefined,
        url: review.html_url,
        submittedAt: review.submitted_at ?? undefined,
      }));
    },
    async listReviewComments(owner, repository, pullNumber) {
      const octokit = await octokitPromise;
      const rows = await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        {
          owner,
          repo: repository,
          pull_number: pullNumber,
          per_page: 100,
        },
      );
      return rows.map((comment) => ({
        id: String(comment.id),
        actorLogin: comment.user?.login ?? "unknown",
        body: comment.body,
        commitId: comment.commit_id,
        url: comment.html_url,
        path: comment.path,
        line: comment.line ?? undefined,
        createdAt: comment.created_at,
      }));
    },
    async listChecksForRef(owner, repository, headSha) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.checks.listForRef({
        owner,
        repo: repository,
        ref: headSha,
        per_page: 100,
      });
      return response.data.check_runs.map((check) => ({
        id: String(check.id),
        appSlug: check.app?.slug,
        name: check.name,
        headSha: check.head_sha,
        status: check.status,
        conclusion: check.conclusion ?? undefined,
        url: check.html_url ?? check.details_url ?? "",
        startedAt: check.started_at ?? undefined,
        completedAt: check.completed_at ?? undefined,
      }));
    },
  };
}

export function mapCodeRabbitSeverity(raw: string): {
  rawSeverity: CodeRabbitRawSeverity;
  severity: Severity;
} {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "critical":
      return { rawSeverity: "critical", severity: "critical" };
    case "major":
      return { rawSeverity: "major", severity: "high" };
    case "high":
      return { rawSeverity: "high", severity: "high" };
    case "minor":
      return { rawSeverity: "minor", severity: "medium" };
    case "nitpick":
      return { rawSeverity: "nitpick", severity: "low" };
    case "trivial":
      return { rawSeverity: "trivial", severity: "low" };
    case "info":
      return { rawSeverity: "info", severity: "info" };
    default:
      return { rawSeverity: "unknown", severity: "info" };
  }
}

export function extractCodeRabbitSeverity(body: string): {
  rawSeverity: CodeRabbitRawSeverity;
  severity: Severity;
} {
  const ordered: readonly CodeRabbitRawSeverity[] = [
    "critical",
    "major",
    "high",
    "minor",
    "nitpick",
    "trivial",
    "info",
  ];
  const lower = body.toLowerCase();
  const match = ordered.find((candidate) =>
    new RegExp(`(?:^|[^a-z])${candidate}(?:[^a-z]|$)`, "u").test(lower),
  );
  return mapCodeRabbitSeverity(match ?? "unknown");
}

function isOfficialCodeRabbitBot(login: string | undefined): boolean {
  return login?.toLowerCase() === "coderabbitai[bot]";
}

function isOfficialCodeRabbitApp(slug: string | undefined): boolean {
  return slug?.toLowerCase() === "coderabbitai";
}

function isOfficialCodeRabbitCheck(check: CodeRabbitCheckArtifact): boolean {
  return (
    isOfficialCodeRabbitApp(check.appSlug) &&
    /code\s*[-_]?\s*rabbit/iu.test(check.name)
  );
}

function findingTitle(body: string, fallback: string): string {
  const first = body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[#>*-]+\s*/u, "").trim())
    .find((line) => line !== "");
  return (first ?? fallback).slice(0, 240);
}

function normalizedFinding(input: {
  sessionId: string;
  headSha: string;
  externalId: string;
  url: string;
  body: string;
  rawSeverity: CodeRabbitRawSeverity;
  severity: Severity;
  sourceKind: NormalizedCodeRabbitFinding["sourceKind"];
  createdAt?: string;
  title?: string;
  filePath?: string;
  line?: number;
  provider?: ReviewFinding["provider"];
}): NormalizedCodeRabbitFinding {
  const at = input.createdAt ?? new Date().toISOString();
  return {
    rawSeverity: input.rawSeverity,
    sourceKind: input.sourceKind,
    headSha: input.headSha,
    finding: {
      id: `coderabbit-${input.sourceKind}-${input.externalId}`,
      sessionId: input.sessionId,
      createdAt: at,
      updatedAt: at,
      source: input.provider ?? "coderabbit",
      sourceVersion: input.headSha,
      provider: input.provider ?? "coderabbit",
      reviewUrl: input.url,
      externalId: input.externalId,
      severity: input.severity,
      title: input.title ?? findingTitle(input.body, "CodeRabbit finding"),
      body: input.body,
      filePath: input.filePath,
      line: input.line,
      resolved: false,
    },
  };
}

function validateInspectionRequest(request: CodeRabbitInspectionRequest): void {
  if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber <= 0) {
    throw new ProviderResponseError(
      "coderabbit",
      "CodeRabbit inspection requires a positive pull request number",
      false,
    );
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(request.headSha)) {
    throw new ProviderResponseError(
      "coderabbit",
      "CodeRabbit inspection requires the exact full PR head SHA",
      false,
    );
  }
}

export class CodeRabbitAdapter {
  constructor(
    private readonly config: CodeRabbitConfig,
    private readonly client: CodeRabbitClientPort = createCodeRabbitClient(config),
    private readonly clock: () => number = Date.now,
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }),
  ) {}

  async inspectReview(
    request: CodeRabbitInspectionRequest,
  ): Promise<ProviderEnvelope<CodeRabbitInspectionEvidence>> {
    validateInspectionRequest(request);
    try {
      const pullRequest = await this.client.getPullRequest(
        this.config.owner,
        this.config.repository,
        request.pullNumber,
      );
      if (
        pullRequest.number !== request.pullNumber ||
        pullRequest.headSha.toLowerCase() !== request.headSha.toLowerCase()
      ) {
        return transportEnvelope("coderabbit", this.client.transport, {
          pullNumber: request.pullNumber,
          headSha: request.headSha,
          observedPrHeadSha: pullRequest.headSha,
          status: "stale",
          passed: false,
          timedOut: false,
          findings: [],
          exactHeadEvidenceIds: [],
          staleEvidenceIds: [`pull-request-head:${pullRequest.headSha}`],
          reason:
            "Requested CodeRabbit evidence head is stale because the pull request now points to a different head SHA.",
        });
      }
      if (
        pullRequest.state !== "open" ||
        pullRequest.merged ||
        pullRequest.baseRef !== this.config.baseBranch
      ) {
        return transportEnvelope("coderabbit", this.client.transport, {
          pullNumber: request.pullNumber,
          headSha: request.headSha,
          observedPrHeadSha: pullRequest.headSha,
          status: "blocked",
          passed: false,
          timedOut: false,
          findings: [],
          exactHeadEvidenceIds: [],
          staleEvidenceIds: [],
          reason:
            "CodeRabbit gate requires an open, unmerged PR against the configured base branch.",
        });
      }
      const [reviews, comments, checks] = await Promise.all([
        this.client.listReviews(
          this.config.owner,
          this.config.repository,
          request.pullNumber,
        ),
        this.client.listReviewComments(
          this.config.owner,
          this.config.repository,
          request.pullNumber,
        ),
        this.client.listChecksForRef(
          this.config.owner,
          this.config.repository,
          request.headSha,
        ),
      ]);

      const botReviews = reviews.filter((review) =>
        isOfficialCodeRabbitBot(review.actorLogin),
      );
      const botComments = comments.filter((comment) =>
        isOfficialCodeRabbitBot(comment.actorLogin),
      );
      const botChecks = checks.filter(
        isOfficialCodeRabbitCheck,
      );
      const exactReviews = botReviews.filter(
        (review) => review.commitId?.toLowerCase() === request.headSha.toLowerCase(),
      );
      const exactComments = botComments.filter(
        (comment) =>
          comment.commitId?.toLowerCase() === request.headSha.toLowerCase(),
      );
      const exactChecks = botChecks.filter(
        (check) => check.headSha.toLowerCase() === request.headSha.toLowerCase(),
      );
      const staleEvidenceIds = [
        ...botReviews
          .filter((review) => !exactReviews.includes(review))
          .map((review) => `review:${review.id}`),
        ...botComments
          .filter((comment) => !exactComments.includes(comment))
          .map((comment) => `comment:${comment.id}`),
        ...botChecks
          .filter((check) => !exactChecks.includes(check))
          .map((check) => `check:${check.id}`),
      ];

      const normalized: NormalizedCodeRabbitFinding[] = [];
      for (const review of exactReviews) {
        const state = review.state.toUpperCase();
        if (state === "CHANGES_REQUESTED") {
          normalized.push(
            normalizedFinding({
              sessionId: request.sessionId,
              headSha: request.headSha,
              externalId: review.id,
              url: review.url,
              body: review.body || "CodeRabbit requested changes.",
              rawSeverity: "request_changes",
              severity: "high",
              sourceKind: "review",
              createdAt: review.submittedAt,
              title: "CodeRabbit requested changes",
            }),
          );
        } else if (review.body.trim() !== "") {
          const mapped = extractCodeRabbitSeverity(review.body);
          normalized.push(
            normalizedFinding({
              sessionId: request.sessionId,
              headSha: request.headSha,
              externalId: review.id,
              url: review.url,
              body: review.body,
              ...mapped,
              sourceKind: "review",
              createdAt: review.submittedAt,
            }),
          );
        }
      }
      for (const comment of exactComments) {
        const mapped = extractCodeRabbitSeverity(comment.body);
        normalized.push(
          normalizedFinding({
            sessionId: request.sessionId,
            headSha: request.headSha,
            externalId: comment.id,
            url: comment.url,
            body: comment.body,
            ...mapped,
            sourceKind: "review-comment",
            createdAt: comment.createdAt,
            filePath: comment.path,
            line: comment.line,
          }),
        );
      }
      for (const check of exactChecks) {
        if (
          check.status === "completed" &&
          check.conclusion !== "success"
        ) {
          normalized.push(
            normalizedFinding({
              sessionId: request.sessionId,
              headSha: request.headSha,
              externalId: check.id,
              url: check.url,
              body: `CodeRabbit check ${check.name} concluded ${check.conclusion ?? "without a conclusion"}.`,
              rawSeverity: "check_failure",
              severity: "high",
              sourceKind: "check",
              createdAt: check.completedAt ?? check.startedAt,
              title: "CodeRabbit check did not pass",
            }),
          );
        }
      }

      const exactHeadEvidenceIds = [
        ...exactReviews.map((review) => `review:${review.id}`),
        ...exactComments.map((comment) => `comment:${comment.id}`),
        ...exactChecks.map((check) => `check:${check.id}`),
      ];
      const gate = evaluateCodeRabbitGate(
        normalized.map((item) => item.finding),
      );
      const pending = exactChecks.some((check) => check.status !== "completed");
      const successSignal =
        exactReviews.some((review) => review.state.toUpperCase() === "APPROVED") ||
        exactChecks.some(
          (check) =>
            check.status === "completed" && check.conclusion === "success",
        );

      let status: CodeRabbitInspectionEvidence["status"];
      let reason: string;
      if (!gate.passed) {
        status = "blocked";
        reason = gate.reason;
      } else if (exactHeadEvidenceIds.length === 0) {
        status = staleEvidenceIds.length > 0 ? "stale" : "pending";
        reason =
          staleEvidenceIds.length > 0
            ? "Only CodeRabbit evidence for an older PR head SHA is available."
            : "No CodeRabbit review or check exists for the exact PR head SHA yet.";
      } else if (pending || !successSignal) {
        status = "pending";
        reason = pending
          ? "CodeRabbit review/check is still pending for the exact head SHA."
          : "Exact-head evidence exists but no successful CodeRabbit review/check signal was observed.";
      } else {
        status = "passed";
        reason = "CodeRabbit passed the exact PR head SHA with no unresolved Critical/Major findings.";
      }

      const finalPullRequest = await this.client.getPullRequest(
        this.config.owner,
        this.config.repository,
        request.pullNumber,
      );
      if (
        finalPullRequest.number !== pullRequest.number ||
        finalPullRequest.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase() ||
        finalPullRequest.state !== "open" ||
        finalPullRequest.merged ||
        finalPullRequest.baseRef !== this.config.baseBranch
      ) {
        return transportEnvelope("coderabbit", this.client.transport, {
          pullNumber: request.pullNumber,
          headSha: request.headSha,
          observedPrHeadSha: finalPullRequest.headSha,
          status: "stale",
          passed: false,
          timedOut: false,
          findings: normalized,
          exactHeadEvidenceIds: [],
          staleEvidenceIds: [
            ...staleEvidenceIds,
            `pull-request-head:${finalPullRequest.headSha}`,
          ],
          reason:
            "Pull request head or state changed while CodeRabbit evidence was being evaluated.",
        });
      }

      return transportEnvelope("coderabbit", this.client.transport, {
        pullNumber: request.pullNumber,
        headSha: request.headSha,
        observedPrHeadSha: finalPullRequest.headSha,
        status,
        passed: status === "passed",
        timedOut: false,
        findings: normalized,
        exactHeadEvidenceIds,
        staleEvidenceIds,
        reason,
      });
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "coderabbit",
        "CodeRabbit GitHub review inspection failed",
        true,
        { cause: error },
      );
    }
  }

  async waitForReview(
    request: CodeRabbitInspectionRequest,
  ): Promise<ProviderEnvelope<CodeRabbitInspectionEvidence>> {
    const deadline = this.clock() + this.config.reviewTimeoutMs;
    let latest = await this.inspectReview(request);
    while (
      latest.data.status !== "passed" &&
      latest.data.status !== "blocked" &&
      this.clock() < deadline
    ) {
      await this.wait(
        Math.min(this.config.pollIntervalMs, Math.max(0, deadline - this.clock())),
      );
      latest = await this.inspectReview(request);
    }
    if (
      latest.data.status !== "passed" &&
      latest.data.status !== "blocked"
    ) {
      return transportEnvelope("coderabbit", this.client.transport, {
        ...latest.data,
        timedOut: true,
        passed: false,
        reason: `${latest.data.reason} Review polling timed out without a pass signal.`,
      });
    }
    return latest;
  }
}

function assertManualReviewUrl(input: {
  repository: Pick<CodeRabbitConfig, "owner" | "repository">;
  pullNumber: number;
  reviewUrl: string;
}): void {
  const url = new URL(input.reviewUrl);
  const expectedPullPath = `/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(
    input.repository.repository,
  )}/pull/${input.pullNumber}`;
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== expectedPullPath &&
      !url.pathname.startsWith(`${expectedPullPath}/`)) ||
    input.repository.owner.trim() === "" ||
    input.repository.repository.trim() === ""
  ) {
    throw new ProviderResponseError(
      "coderabbit",
      "Manual CodeRabbit attestation URL must match the configured repository and pull request",
      false,
    );
  }
}

export function createManualVerifiedIndependentReviewReceipt(input: {
  repository: Pick<CodeRabbitConfig, "owner" | "repository">;
  pullNumber: number;
  headSha: string;
  reviewUrl: string;
  status: IndependentReviewReceipt["status"];
  evidenceIds: readonly string[];
  attestedBy: string;
  attestedAt: string;
}): ProviderEnvelope<IndependentReviewReceipt> {
  validateInspectionRequest({
    sessionId: "manual-attestation",
    pullNumber: input.pullNumber,
    headSha: input.headSha,
  });
  assertManualReviewUrl(input);
  if (
    (input.status !== "passed" && input.status !== "blocked") ||
    input.evidenceIds.length === 0 ||
    input.evidenceIds.some((id) => id.trim() === "") ||
    new Set(input.evidenceIds).size !== input.evidenceIds.length ||
    input.attestedBy.trim() === "" ||
    Number.isNaN(Date.parse(input.attestedAt))
  ) {
    throw new ProviderResponseError(
      "coderabbit",
      "Manual review receipt requires a valid actor, timestamp, status, and non-empty unique evidence IDs",
      false,
    );
  }
  return manualVerifiedEnvelope(
    {
      provider: "manual_verified",
      sourceKind: "manual-attestation",
      status: input.status,
      pullNumber: input.pullNumber,
      headSha: input.headSha,
      reviewUrl: input.reviewUrl,
      evidenceIds: [...input.evidenceIds],
      capturedAt: input.attestedAt,
      attestedBy: input.attestedBy,
    },
    {
      attestedAt: input.attestedAt,
      attestedBy: input.attestedBy,
      evidenceRef: input.reviewUrl,
    },
  );
}

export function createManualVerifiedCodeRabbitFinding(input: {
  sessionId: string;
  repository: Pick<CodeRabbitConfig, "owner" | "repository">;
  pullNumber: number;
  headSha: string;
  externalId: string;
  reviewUrl: string;
  rawSeverity: string;
  title: string;
  body: string;
  attestedBy: string;
  attestedAt: string;
  filePath?: string;
  line?: number;
}): ProviderEnvelope<NormalizedCodeRabbitFinding> {
  validateInspectionRequest({
    sessionId: input.sessionId,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
  });
  assertManualReviewUrl(input);
  if (input.attestedBy.trim() === "") {
    throw new ProviderResponseError(
      "coderabbit",
      "Manual CodeRabbit attestation requires an identified human actor",
      false,
    );
  }
  const mapped = mapCodeRabbitSeverity(input.rawSeverity);
  // A human attestation is intentionally not represented as live CodeRabbit
  // provider output. Its inner ReviewFinding remains manual_verified.
  return manualVerifiedEnvelope(
    normalizedFinding({
      sessionId: input.sessionId,
      headSha: input.headSha,
      externalId: input.externalId,
      url: input.reviewUrl,
      body: `${input.body}\n\nManually verified by ${input.attestedBy}.`,
      ...mapped,
      sourceKind: "manual-attestation",
      createdAt: input.attestedAt,
      title: input.title,
      filePath: input.filePath,
      line: input.line,
      provider: "manual_verified",
    }),
    {
      attestedAt: input.attestedAt,
      attestedBy: input.attestedBy,
      evidenceRef: input.reviewUrl,
    },
  );
}
