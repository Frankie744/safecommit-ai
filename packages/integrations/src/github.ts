import {
  computeFullRevalidationAttestationDigest,
  isApprovalValid,
  isFullRevalidationReceiptStructurallyValid,
  type ApprovalBinding,
  type FullRevalidationReceipt,
  type HumanApproval,
  type OperatingMode,
  type PullRequestRecord,
  type ValidationSession,
} from "@safeflash/domain";

import {
  ProviderResponseError,
  registerOfficialTransport,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";
import {
  assertPreparedCandidatePublication,
  candidatePublicationChangedPaths,
  decodeVerifiedGitHubBlob,
  prepareCandidatePublicationData,
  type GitHubBlobData,
  type GitHubRecursiveTree,
  type PrepareCandidatePublicationRequest,
  type PreparedCandidateFile,
  type PreparedCandidatePublication,
} from "./github-publication";
import {
  createFireworksSourceContext,
  type FireworksSourceContext,
} from "./fireworks";
import {
  PublishAuthorizationError,
  assertPublishAuthorizationAuthority,
  computePullRequestContentDigest,
  mintPublishAuthorization,
  type PublishAuthorizationBinding,
  type PublishAuthorizationAuthority,
} from "./publish-authorization";

export const GITHUB_API_VERSION = "2026-03-10";

export interface GitHubConfig {
  mode: "live";
  token: string;
  owner: string;
  repository: string;
  baseBranch: string;
  apiVersion: string;
}

export interface GitHubRepositoryInfo {
  private: boolean;
  defaultBranch: string;
  permissions?: { push?: boolean };
}

export interface GitHubPullRequestInfo {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
}

export interface GitHubClientPort {
  readonly transport: ProviderTransport;
  getAuthenticated(): Promise<{ login: string }>;
  getRepository(owner: string, repository: string): Promise<GitHubRepositoryInfo>;
  getCommit(
    owner: string,
    repository: string,
    ref: string,
  ): Promise<{ sha: string; treeSha: string }>;
  getTree(
    owner: string,
    repository: string,
    treeSha: string,
  ): Promise<GitHubRecursiveTree>;
  getBlob(
    owner: string,
    repository: string,
    blobSha: string,
  ): Promise<GitHubBlobData>;
  createBlob(request: {
    owner: string;
    repository: string;
    contentBase64: string;
  }): Promise<{ sha: string }>;
  createTree(request: {
    owner: string;
    repository: string;
    baseTreeSha: string;
    entries: readonly Pick<PreparedCandidateFile, "path" | "mode" | "blobSha">[];
  }): Promise<{ sha: string }>;
  createCommit(request: {
    owner: string;
    repository: string;
    message: string;
    treeSha: string;
    parentSha: string;
    author: { name: string; email: string; date: string };
  }): Promise<{ sha: string; treeSha: string; parentShas: readonly string[] }>;
  getBranchReference(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<{ sha: string; type: string } | undefined>;
  createBranchReference(request: {
    owner: string;
    repository: string;
    branch: string;
    commitSha: string;
  }): Promise<{ sha: string; type: string }>;
  updateBranchReference(request: {
    owner: string;
    repository: string;
    branch: string;
    commitSha: string;
    force: false;
  }): Promise<{ sha: string; type: string }>;
  getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestInfo>;
  listOpenPullRequests(request: {
    owner: string;
    repository: string;
    head: string;
    base: string;
  }): Promise<readonly GitHubPullRequestInfo[]>;
  createPullRequest(request: {
    owner: string;
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  }): Promise<GitHubPullRequestInfo>;
  updatePullRequest(request: {
    owner: string;
    repository: string;
    pullNumber: number;
    title: string;
    body: string;
  }): Promise<GitHubPullRequestInfo>;
}

export interface GitHubSmokeEvidence {
  authenticatedLogin: string;
  owner: string;
  repository: string;
  public: true;
  pushPermission: true;
  defaultBranch: string;
  configuredBaseBranch: string;
  baseHeadSha: string;
  baseTreeSha: string;
}

const P0_SOURCE_CONTEXT_PATHS = new Set([
  "fixtures/battery-controller/src/battery_controller.c",
  "fixtures/battery-controller/include/battery_controller.h",
]);
const MAX_GITHUB_SOURCE_CONTEXT_BYTES = 192 * 1024;
const MAX_GITHUB_SOURCE_FILE_BYTES = 96 * 1024;

export interface ReadCandidateSourceContextRequest {
  sessionId: string;
  commitSha: string;
  /** Exact server-registered paths; globs and caller-selected repository paths are rejected. */
  allowedPaths: readonly string[];
  /** May tighten, but never expand, the server-owned aggregate limit. */
  maxBytes: number;
}

export interface PullRequestDescription {
  incident: string;
  selectedStrategy: string;
  tests: readonly string[];
  braintrustExperimentUrl: string;
  daytonaEvidenceRef: string;
  evidenceDigest: string;
}

export interface CreatePullRequestRequest {
  sessionId: string;
  candidateId: string;
  headBranch: string;
  expectedHeadSha: string;
  title: string;
  description: PullRequestDescription;
  validationReceipt: FullRevalidationReceipt;
  approval: HumanApproval;
  currentBinding: ApprovalBinding;
  publication: PreparedCandidatePublication;
  publishAuthorization: string;
  draft?: boolean;
}

export function isSafeGitHubOwner(value: string): boolean {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value) &&
    !value.endsWith("-") &&
    !value.includes("--")
  );
}

export function isSafeGitHubRepository(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]{1,100}$/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

export function isSafeGitRef(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

const RETRYABLE_GITHUB_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function githubErrorChain(error: unknown): readonly Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = errorRecord(error);
  while (current !== undefined && chain.length < 5 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = errorRecord(current.cause);
  }
  return chain;
}

function githubHttpStatus(error: unknown): number | undefined {
  for (const item of githubErrorChain(error)) {
    const response = errorRecord(item.response);
    for (const value of [item.status, item.statusCode, response?.status]) {
      const status =
        typeof value === "number"
          ? value
          : typeof value === "string" && /^\d{3}$/u.test(value)
            ? Number(value)
            : Number.NaN;
      if (Number.isSafeInteger(status) && status >= 100 && status <= 599) {
        return status;
      }
    }
  }
  return undefined;
}

function isRetryableGitHubNetworkError(error: unknown): boolean {
  for (const item of githubErrorChain(error)) {
    const code = typeof item.code === "string" ? item.code.toUpperCase() : "";
    if (RETRYABLE_GITHUB_NETWORK_CODES.has(code)) return true;
    const name = typeof item.name === "string" ? item.name : "";
    const message = typeof item.message === "string" ? item.message : "";
    if (
      /timeout/iu.test(name) ||
      /(?:\btimeout\b|\btimed?\s+out\b|socket hang up|temporary failure in name resolution)/iu.test(
        message,
      )
    ) {
      return true;
    }
  }
  return false;
}

function classifyGitHubError(
  error: unknown,
  safeMessage: string,
): ProviderResponseError {
  if (error instanceof ProviderResponseError) return error;
  const status = githubHttpStatus(error);
  const retryable =
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    (status === undefined && isRetryableGitHubNetworkError(error));
  // Never interpolate the SDK error, response body, request headers, or token.
  return new ProviderResponseError("github", safeMessage, retryable);
}

export function readGitHubConfig(
  environment: Environment = process.env,
  mode: OperatingMode = "live",
): GitHubConfig {
  const values = requireLiveConfiguration(
    "github",
    mode,
    environment,
    ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"] as const,
  );
  const baseBranch = environment.GITHUB_BASE_BRANCH?.trim() || "main";
  if (
    !isSafeGitHubOwner(values.GITHUB_OWNER) ||
    !isSafeGitHubRepository(values.GITHUB_REPO) ||
    !isSafeGitRef(baseBranch)
  ) {
    throw new ProviderResponseError(
      "github",
      "GitHub owner, repository, or base branch is not a safe repository coordinate",
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
  };
}

function mapPullRequest(data: {
  number: number;
  html_url: string;
  state: string;
  merged_at?: string | null;
  merged?: boolean;
  head: { sha: string; ref: string };
  base: { ref: string; sha: string };
}): GitHubPullRequestInfo {
  return {
    number: data.number,
    htmlUrl: data.html_url,
    state: data.state === "open" ? "open" : "closed",
    merged: data.merged === true || data.merged_at != null,
    headSha: data.head.sha,
    headRef: data.head.ref,
    baseRef: data.base.ref,
    baseSha: data.base.sha,
  };
}

export function createGitHubClient(config: GitHubConfig): GitHubClientPort {
  const octokitPromise = import("octokit").then(
    ({ Octokit }) =>
      new Octokit({
        auth: config.token,
        request: { headers: { "X-GitHub-Api-Version": config.apiVersion } },
      }),
  );
  return registerOfficialTransport({
    transport: "official-sdk",
    async getAuthenticated() {
      const octokit = await octokitPromise;
      const response = await octokit.rest.users.getAuthenticated();
      return { login: response.data.login };
    },
    async getRepository(owner, repository) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.repos.get({ owner, repo: repository });
      return {
        private: response.data.private,
        defaultBranch: response.data.default_branch,
        permissions: response.data.permissions,
      };
    },
    async getCommit(owner, repository, ref) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.repos.getCommit({
        owner,
        repo: repository,
        ref,
      });
      return {
        sha: response.data.sha,
        treeSha: response.data.commit.tree.sha,
      };
    },
    async getTree(owner, repository, treeSha) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.git.getTree({
        owner,
        repo: repository,
        tree_sha: treeSha,
        recursive: "true",
      });
      const entries = response.data.tree.map((entry) => {
        if (
          entry.path === undefined ||
          entry.mode === undefined ||
          entry.sha === undefined ||
          !["blob", "tree", "commit"].includes(entry.type ?? "")
        ) {
          throw new ProviderResponseError(
            "github",
            "GitHub Git Data API returned an incomplete tree entry",
            false,
          );
        }
        return {
          path: entry.path,
          mode: entry.mode,
          type: entry.type as "blob" | "tree" | "commit",
          sha: entry.sha,
        };
      });
      return {
        sha: response.data.sha,
        truncated: response.data.truncated === true,
        entries,
      };
    },
    async getBlob(owner, repository, blobSha) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.git.getBlob({
        owner,
        repo: repository,
        file_sha: blobSha,
      });
      if (response.data.encoding !== "base64") {
        throw new ProviderResponseError(
          "github",
          "GitHub Git Data API returned a non-base64 blob",
          false,
        );
      }
      return {
        sha: response.data.sha,
        contentBase64: response.data.content,
      };
    },
    async createBlob(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.git.createBlob({
        owner: request.owner,
        repo: request.repository,
        content: request.contentBase64,
        encoding: "base64",
      });
      return { sha: response.data.sha };
    },
    async createTree(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.git.createTree({
        owner: request.owner,
        repo: request.repository,
        base_tree: request.baseTreeSha,
        tree: request.entries.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          type: "blob" as const,
          sha: entry.blobSha,
        })),
      });
      return { sha: response.data.sha };
    },
    async createCommit(request) {
      const octokit = await octokitPromise;
      const identity = {
        name: request.author.name,
        email: request.author.email,
        date: request.author.date,
      };
      const response = await octokit.rest.git.createCommit({
        owner: request.owner,
        repo: request.repository,
        message: request.message,
        tree: request.treeSha,
        parents: [request.parentSha],
        author: identity,
        committer: identity,
      });
      return {
        sha: response.data.sha,
        treeSha: response.data.tree.sha,
        parentShas: response.data.parents.map((parent) => parent.sha),
      };
    },
    async getBranchReference(owner, repository, branch) {
      const octokit = await octokitPromise;
      try {
        const response = await octokit.rest.git.getRef({
          owner,
          repo: repository,
          ref: `heads/${branch}`,
        });
        return {
          sha: response.data.object.sha,
          type: response.data.object.type,
        };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        ) {
          return undefined;
        }
        throw classifyGitHubError(error, "GitHub branch reference read failed");
      }
    },
    async createBranchReference(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.git.createRef({
        owner: request.owner,
        repo: request.repository,
        ref: `refs/heads/${request.branch}`,
        sha: request.commitSha,
      });
      return {
        sha: response.data.object.sha,
        type: response.data.object.type,
      };
    },
    async updateBranchReference(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.git.updateRef({
        owner: request.owner,
        repo: request.repository,
        ref: `heads/${request.branch}`,
        sha: request.commitSha,
        force: request.force,
      });
      return {
        sha: response.data.object.sha,
        type: response.data.object.type,
      };
    },
    async getPullRequest(owner, repository, pullNumber) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.pulls.get({
        owner,
        repo: repository,
        pull_number: pullNumber,
      });
      return mapPullRequest(response.data);
    },
    async listOpenPullRequests(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.pulls.list({
        owner: request.owner,
        repo: request.repository,
        state: "open",
        head: request.head,
        base: request.base,
      });
      return response.data.map(mapPullRequest);
    },
    async createPullRequest(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.pulls.create({
        owner: request.owner,
        repo: request.repository,
        title: request.title,
        body: request.body,
        head: request.head,
        base: request.base,
        draft: request.draft,
      });
      return mapPullRequest(response.data);
    },
    async updatePullRequest(request) {
      const octokit = await octokitPromise;
      const response = await octokit.rest.pulls.update({
        owner: request.owner,
        repo: request.repository,
        pull_number: request.pullNumber,
        title: request.title,
        body: request.body,
      });
      return mapPullRequest(response.data);
    },
  } satisfies GitHubClientPort);
}

function requireNonEmpty(label: string, value: string): void {
  if (value.trim() === "") {
    throw new ProviderResponseError("github", `${label} must not be empty`, false);
  }
}

function deepFreezePublicationRequest<T>(
  value: T,
  seen = new WeakSet<object>(),
): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreezePublicationRequest(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  return Object.freeze(value);
}

function validateCreateRequest(
  request: Omit<CreatePullRequestRequest, "publishAuthorization">,
  config: GitHubConfig,
): void {
  assertPreparedCandidatePublication(request.publication);
  const { attestationDigest, ...attestedEvidence } = request.validationReceipt;
  if (!isApprovalValid(request.approval, request.currentBinding)) {
    throw new ProviderResponseError(
      "github",
      "Pull request creation requires a current evidence-bound human approval",
      false,
    );
  }
  if (
    request.currentBinding.candidateId !== request.candidateId ||
    request.publication.sessionId !== request.sessionId ||
    request.publication.candidateId !== request.candidateId ||
    request.publication.owner !== config.owner ||
    request.publication.repository !== config.repository ||
    request.publication.baseBranch !== config.baseBranch ||
    request.publication.headBranch !== request.headBranch ||
    request.publication.patchDigest !== request.currentBinding.patchDigest ||
    request.publication.commitSha !== request.expectedHeadSha ||
    request.publication.treeSha !== request.validationReceipt.validatedTreeSha ||
    request.currentBinding.evidenceDigest !== request.description.evidenceDigest ||
    request.currentBinding.commitSha !== request.expectedHeadSha ||
    request.approval.sessionId !== request.sessionId ||
    request.currentBinding.pullRequestTarget?.provider !== "github" ||
    request.currentBinding.pullRequestTarget.owner !== config.owner ||
    request.currentBinding.pullRequestTarget.repository !== config.repository ||
    request.currentBinding.pullRequestTarget.baseBranch !== config.baseBranch ||
    !isFullRevalidationReceiptStructurallyValid(request.validationReceipt) ||
    request.validationReceipt.sourceKind !== "live-provider-evidence" ||
    request.validationReceipt.mode !== "live" ||
    request.validationReceipt.sessionId !== request.sessionId ||
    request.validationReceipt.policyVersion !==
      request.currentBinding.policyVersion ||
    request.validationReceipt.candidateId !== request.candidateId ||
    request.validationReceipt.pullRequestTarget.owner !== config.owner ||
    request.validationReceipt.pullRequestTarget.repository !==
      config.repository ||
    request.validationReceipt.pullRequestTarget.baseBranch !==
      config.baseBranch ||
    request.validationReceipt.patchDigest !== request.currentBinding.patchDigest ||
    request.validationReceipt.evidenceDigest !==
      request.currentBinding.evidenceDigest ||
    request.validationReceipt.commitSha !== request.expectedHeadSha ||
    request.validationReceipt.daytonaEvidenceRef !==
      request.description.daytonaEvidenceRef ||
    request.validationReceipt.braintrustExperimentRef !==
      request.description.braintrustExperimentUrl ||
    computeFullRevalidationAttestationDigest(attestedEvidence) !==
      attestationDigest
  ) {
    throw new ProviderResponseError(
      "github",
      "PR candidate, validated provider evidence, and head SHA must exactly match the approved binding",
      false,
    );
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(request.expectedHeadSha)) {
    throw new ProviderResponseError(
      "github",
      "Pull request head must be bound to a full Git commit SHA",
      false,
    );
  }
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(
      request.validationReceipt.validatedTreeSha,
    )
  ) {
    throw new ProviderResponseError(
      "github",
      "Pull request evidence must identify the exact Daytona-validated Git tree",
      false,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(request.sessionId)) {
    throw new ProviderResponseError(
      "github",
      "SafeFlash session ID cannot be represented as a stable PR branch",
      false,
    );
  }
  const stableSessionBranch = `safeflash/${request.sessionId}`;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(request.headBranch) ||
    request.headBranch.includes("..") ||
    request.headBranch.endsWith("/") ||
    request.headBranch === config.baseBranch ||
    request.headBranch !== stableSessionBranch
  ) {
    throw new ProviderResponseError(
      "github",
      "Pull request head must use the stable safeflash/<session-id> branch so review repairs update the same PR",
      false,
    );
  }
  requireNonEmpty("PR title", request.title);
  requireNonEmpty("incident", request.description.incident);
  requireNonEmpty("selected strategy", request.description.selectedStrategy);
  requireNonEmpty(
    "Braintrust experiment URL",
    request.description.braintrustExperimentUrl,
  );
  requireNonEmpty("Daytona evidence", request.description.daytonaEvidenceRef);
  requireNonEmpty("evidence digest", request.description.evidenceDigest);
  if (request.description.tests.length === 0) {
    throw new ProviderResponseError(
      "github",
      "PR description requires at least one verified test",
      false,
    );
  }
  if (request.description.tests.some((test) => test.trim() === "")) {
    throw new ProviderResponseError(
      "github",
      "PR description test evidence must not contain blank entries",
      false,
    );
  }
}

export function buildPullRequestBody(
  description: PullRequestDescription,
): string {
  return [
    "## Safety incident",
    description.incident,
    "",
    "## Selected repair strategy",
    description.selectedStrategy,
    "",
    "## Verified tests",
    ...description.tests.map((test) => `- ${test}`),
    "",
    "## Braintrust evaluation",
    description.braintrustExperimentUrl,
    "",
    "## Daytona isolation evidence",
    description.daytonaEvidenceRef,
    "",
    "## Approval-bound evidence digest",
    `\`${description.evidenceDigest}\``,
    "",
    "> SafeFlash creates or updates this PR but never merges it.",
  ].join("\n");
}

export function buildPullRequestPublishAuthorizationBinding(
  request: Omit<CreatePullRequestRequest, "publishAuthorization">,
  config: Pick<GitHubConfig, "owner" | "repository" | "baseBranch">,
): PublishAuthorizationBinding {
  return {
    sessionId: request.sessionId,
    candidateId: request.candidateId,
    patchDigest: request.currentBinding.patchDigest,
    evidenceDigest: request.currentBinding.evidenceDigest,
    baseCommitSha: request.publication.baseCommitSha,
    targetBaseCommitSha: request.publication.targetBaseCommitSha,
    commitSha: request.expectedHeadSha,
    treeSha: request.validationReceipt.validatedTreeSha,
    policyVersion: request.currentBinding.policyVersion,
    approvalId: request.approval.id,
    approverId: request.approval.approverId,
    approvalActedAt: request.approval.actedAt,
    approvalBindingDigest: request.approval.bindingDigest,
    validationAttestationDigest: request.validationReceipt.attestationDigest,
    candidatePublicationDigest: request.publication.publicationDigest,
    headBranch: request.headBranch,
    pullRequestContentDigest: computePullRequestContentDigest({
      title: request.title,
      body: buildPullRequestBody(request.description),
      headBranch: request.headBranch,
      draft: request.draft ?? false,
    }),
    target: {
      provider: "github",
      owner: config.owner,
      repository: config.repository,
      baseBranch: config.baseBranch,
    },
    providerReferences: {
      daytonaSandboxId: request.validationReceipt.sandboxId,
      daytonaRunId: request.validationReceipt.daytonaRunId,
      daytonaEvidenceRef: request.validationReceipt.daytonaEvidenceRef,
      braintrustProjectId: request.validationReceipt.braintrustProjectId,
      braintrustExperimentId: request.validationReceipt.braintrustExperimentId,
      braintrustExperimentName:
        request.validationReceipt.braintrustExperimentName,
      braintrustExperimentRef:
        request.validationReceipt.braintrustExperimentRef,
    },
  };
}

/**
 * Server-only minting boundary. The same approval and live provider receipt
 * validation used by mutation runs before the HMAC capability is issued.
 */
export function mintPullRequestPublishAuthorization(
  authority: PublishAuthorizationAuthority,
  session: ValidationSession,
  request: Omit<CreatePullRequestRequest, "publishAuthorization">,
  config: GitHubConfig,
): string {
  validateCreateRequest(request, config);
  const sessionApproval = session.approval;
  const sessionReceipt = session.lastRevalidation;
  const expectedPublicationBase =
    session.pullRequest?.headSha ?? session.repository.commitSha;
  const receiptSandboxIsAuthoritative =
    sessionReceipt?.validationPurpose === "initial-selection"
      ? session.sandboxIdsByCandidate[sessionReceipt.candidateId] ===
        sessionReceipt.sandboxId
      : sessionReceipt?.validationPurpose === "review-repair"
        ? session.revalidationSandboxIds.includes(sessionReceipt.sandboxId)
        : false;
  if (
    session.mode !== "live" ||
    session.state !== "CREATING_PULL_REQUEST" ||
    session.sessionId !== request.sessionId ||
    session.selectedCandidateId !== request.candidateId ||
    session.currentPatchDigest !== request.currentBinding.patchDigest ||
    session.currentEvidenceDigest !== request.currentBinding.evidenceDigest ||
    request.publication.baseCommitSha !== expectedPublicationBase ||
    request.publication.targetBaseCommitSha !== session.repository.commitSha ||
    session.currentCommitSha !== request.expectedHeadSha ||
    session.currentValidatedTreeSha !==
      request.validationReceipt.validatedTreeSha ||
    session.policyVersion !== request.currentBinding.policyVersion ||
    session.pullRequestTarget?.provider !== "github" ||
    session.pullRequestTarget.owner !== config.owner ||
    session.pullRequestTarget.repository !== config.repository ||
    session.pullRequestTarget.baseBranch !== config.baseBranch ||
    sessionApproval === undefined ||
    sessionApproval.id !== request.approval.id ||
    sessionApproval.bindingDigest !== request.approval.bindingDigest ||
    sessionApproval.approverId !== request.approval.approverId ||
    sessionApproval.actedAt !== request.approval.actedAt ||
    !isApprovalValid(sessionApproval, request.currentBinding) ||
    sessionReceipt === undefined ||
    !isFullRevalidationReceiptStructurallyValid(sessionReceipt) ||
    sessionReceipt.attestationDigest !==
      request.validationReceipt.attestationDigest ||
    sessionReceipt.validatedTreeSha !==
      request.validationReceipt.validatedTreeSha ||
    sessionReceipt.commitSha !== request.validationReceipt.commitSha ||
    !receiptSandboxIsAuthoritative
  ) {
    throw new PublishAuthorizationError(
      "INVALID_BINDING",
      "Publish authorization can be minted only from the current live CREATING_PULL_REQUEST session, approval, and validation receipt",
    );
  }
  return mintPublishAuthorization(
    authority,
    buildPullRequestPublishAuthorizationBinding(request, config),
  );
}

export class GitHubAdapter {
  constructor(
    private readonly config: GitHubConfig,
    private readonly client: GitHubClientPort = createGitHubClient(config),
    private readonly clock: () => Date = () => new Date(),
    private readonly publishAuthorization?: PublishAuthorizationAuthority,
  ) {}

  /** Read-only exact-commit source ingestion for the Fireworks prompt. */
  async readCandidateSourceContext(
    request: ReadCandidateSourceContextRequest,
  ): Promise<ProviderEnvelope<FireworksSourceContext>> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(request.sessionId) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(request.commitSha) ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1 ||
      request.maxBytes > MAX_GITHUB_SOURCE_CONTEXT_BYTES ||
      request.allowedPaths.length < 1 ||
      request.allowedPaths.length > P0_SOURCE_CONTEXT_PATHS.size ||
      new Set(request.allowedPaths).size !== request.allowedPaths.length ||
      request.allowedPaths.some((path) => !P0_SOURCE_CONTEXT_PATHS.has(path))
    ) {
      throw new ProviderResponseError(
        "github",
        "GitHub source context request exceeds the server-owned P0 path or size policy",
        false,
      );
    }
    const paths = [...request.allowedPaths].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    try {
      const commit = await this.client.getCommit(
        this.config.owner,
        this.config.repository,
        request.commitSha,
      );
      if (commit.sha.toLowerCase() !== request.commitSha.toLowerCase()) {
        throw new ProviderResponseError(
          "github",
          "GitHub source context did not resolve the exact immutable commit",
          false,
        );
      }
      const tree = await this.client.getTree(
        this.config.owner,
        this.config.repository,
        commit.treeSha,
      );
      if (
        tree.sha.toLowerCase() !== commit.treeSha.toLowerCase() ||
        tree.truncated
      ) {
        throw new ProviderResponseError(
          "github",
          "GitHub source context tree is truncated or not bound to the commit",
          false,
        );
      }
      const entriesByPath = new Map(
        tree.entries.map((entry) => [entry.path, entry] as const),
      );
      let totalBytes = 0;
      const files = await Promise.all(
        paths.map(async (path) => {
          const entry = entriesByPath.get(path);
          if (
            entry === undefined ||
            entry.type !== "blob" ||
            entry.mode !== "100644"
          ) {
            throw new ProviderResponseError(
              "github",
              `GitHub source context path is not a regular immutable file: ${path}`,
              false,
            );
          }
          const blob = await this.client.getBlob(
            this.config.owner,
            this.config.repository,
            entry.sha,
          );
          const bytes = decodeVerifiedGitHubBlob(
            blob,
            entry.sha,
            Math.min(request.maxBytes, MAX_GITHUB_SOURCE_FILE_BYTES),
          );
          totalBytes += bytes.byteLength;
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new ProviderResponseError(
              "github",
              `GitHub source context path is not UTF-8 text: ${path}`,
              false,
            );
          }
          if (content.includes("\0") || content.includes("\r")) {
            throw new ProviderResponseError(
              "github",
              `GitHub source context path is not canonical LF text: ${path}`,
              false,
            );
          }
          return { path, content };
        }),
      );
      if (totalBytes > request.maxBytes) {
        throw new ProviderResponseError(
          "github",
          "GitHub source context exceeds the requested aggregate byte limit",
          false,
        );
      }
      return transportEnvelope(
        "github",
        this.client,
        createFireworksSourceContext({
          commitSha: request.commitSha,
          files,
        }),
      );
    } catch (error) {
      throw classifyGitHubError(error, "GitHub source context read failed");
    }
  }

  /**
   * Read-only preparation boundary. It applies the trusted diff to immutable
   * GitHub blob bytes and computes Git object IDs without creating any object,
   * ref, or pull request on GitHub.
   */
  async prepareCandidatePublication(
    request: PrepareCandidatePublicationRequest,
  ): Promise<ProviderEnvelope<PreparedCandidatePublication>> {
    const changedPaths = candidatePublicationChangedPaths(request.candidate);
    try {
      const [baseCommit, targetBaseCommit] = await Promise.all([
        this.client.getCommit(
          this.config.owner,
          this.config.repository,
          request.baseCommitSha,
        ),
        this.client.getCommit(
          this.config.owner,
          this.config.repository,
          this.config.baseBranch,
        ),
      ]);
      if (baseCommit.sha.toLowerCase() !== request.baseCommitSha.toLowerCase()) {
        throw new ProviderResponseError(
          "github",
          "GitHub did not resolve the exact immutable publication base commit",
          false,
        );
      }
      if (
        targetBaseCommit.sha.toLowerCase() !==
        request.targetBaseCommitSha.toLowerCase()
      ) {
        throw new ProviderResponseError(
          "github",
          "Configured GitHub base branch moved before candidate preparation",
          false,
        );
      }
      const baseTree = await this.client.getTree(
        this.config.owner,
        this.config.repository,
        baseCommit.treeSha,
      );
      const entriesByPath = new Map(
        baseTree.entries.map((entry) => [entry.path, entry] as const),
      );
      const blobsByPath: Record<string, GitHubBlobData> = {};
      await Promise.all(
        changedPaths.map(async (path) => {
          const entry = entriesByPath.get(path);
          if (entry?.type === "blob") {
            blobsByPath[path] = await this.client.getBlob(
              this.config.owner,
              this.config.repository,
              entry.sha,
            );
          }
        }),
      );
      const publication = prepareCandidatePublicationData({
        request,
        target: {
          owner: this.config.owner,
          repository: this.config.repository,
          baseBranch: this.config.baseBranch,
        },
        baseTreeSha: baseCommit.treeSha,
        baseTree,
        blobsByPath,
      });
      return transportEnvelope("github", this.client, publication);
    } catch (error) {
      throw classifyGitHubError(
        error,
        "GitHub candidate publication preparation failed",
      );
    }
  }

  private async publishPreparedCandidateBranch(
    publication: PreparedCandidatePublication,
  ): Promise<{ sha: string; treeSha: string }> {
    const sameSha = (left: string, right: string): boolean =>
      left.toLowerCase() === right.toLowerCase();
    const readTargetBase = async (): Promise<void> => {
      const targetBase = await this.client.getCommit(
        this.config.owner,
        this.config.repository,
        this.config.baseBranch,
      );
      if (!sameSha(targetBase.sha, publication.targetBaseCommitSha)) {
        throw new ProviderResponseError(
          "github",
          "Configured GitHub base branch moved after candidate validation",
          false,
        );
      }
    };

    const baseCommit = await this.client.getCommit(
      this.config.owner,
      this.config.repository,
      publication.baseCommitSha,
    );
    if (
      !sameSha(baseCommit.sha, publication.baseCommitSha) ||
      !sameSha(baseCommit.treeSha, publication.baseTreeSha)
    ) {
      throw new ProviderResponseError(
        "github",
        "Publication parent commit no longer matches its prepared immutable tree",
        false,
      );
    }
    await readTargetBase();

    const firstReference = await this.client.getBranchReference(
      this.config.owner,
      this.config.repository,
      publication.headBranch,
    );
    if (
      firstReference !== undefined &&
      (firstReference.type !== "commit" ||
        (!sameSha(firstReference.sha, publication.baseCommitSha) &&
          !sameSha(firstReference.sha, publication.commitSha)))
    ) {
      throw new ProviderResponseError(
        "github",
        "Stable SafeFlash branch is not at its approval-bound parent or candidate commit",
        false,
      );
    }

    for (const file of publication.changedFiles) {
      const createdBlob = await this.client.createBlob({
        owner: this.config.owner,
        repository: this.config.repository,
        contentBase64: file.contentBase64,
      });
      if (!sameSha(createdBlob.sha, file.blobSha)) {
        throw new ProviderResponseError(
          "github",
          `GitHub created a blob that differs from prepared file ${file.path}`,
          false,
        );
      }
    }

    const createdTree = await this.client.createTree({
      owner: this.config.owner,
      repository: this.config.repository,
      baseTreeSha: publication.baseTreeSha,
      entries: publication.changedFiles,
    });
    if (!sameSha(createdTree.sha, publication.treeSha)) {
      throw new ProviderResponseError(
        "github",
        "GitHub created tree does not match the exact Daytona-validated tree",
        false,
      );
    }

    const createdCommit = await this.client.createCommit({
      owner: this.config.owner,
      repository: this.config.repository,
      message: publication.commitMessage,
      treeSha: publication.treeSha,
      parentSha: publication.baseCommitSha,
      author: {
        ...publication.author,
        date: publication.committedAt,
      },
    });
    if (
      !sameSha(createdCommit.sha, publication.commitSha) ||
      !sameSha(createdCommit.treeSha, publication.treeSha) ||
      createdCommit.parentShas.length !== 1 ||
      !sameSha(createdCommit.parentShas[0]!, publication.baseCommitSha)
    ) {
      throw new ProviderResponseError(
        "github",
        "GitHub created commit does not match the approval-bound deterministic commit",
        false,
      );
    }

    await readTargetBase();
    const secondReference = await this.client.getBranchReference(
      this.config.owner,
      this.config.repository,
      publication.headBranch,
    );
    if (
      (firstReference === undefined) !== (secondReference === undefined) ||
      (firstReference !== undefined &&
        secondReference !== undefined &&
        (firstReference.type !== secondReference.type ||
          !sameSha(firstReference.sha, secondReference.sha)))
    ) {
      throw new ProviderResponseError(
        "github",
        "Stable SafeFlash branch changed during publication preparation",
        false,
      );
    }

    let writtenReference: { sha: string; type: string };
    if (secondReference === undefined) {
      writtenReference = await this.client.createBranchReference({
        owner: this.config.owner,
        repository: this.config.repository,
        branch: publication.headBranch,
        commitSha: publication.commitSha,
      });
    } else if (sameSha(secondReference.sha, publication.commitSha)) {
      writtenReference = secondReference;
    } else if (sameSha(secondReference.sha, publication.baseCommitSha)) {
      writtenReference = await this.client.updateBranchReference({
        owner: this.config.owner,
        repository: this.config.repository,
        branch: publication.headBranch,
        commitSha: publication.commitSha,
        force: false,
      });
    } else {
      throw new ProviderResponseError(
        "github",
        "Stable SafeFlash branch failed its final compare-before-update check",
        false,
      );
    }
    if (
      writtenReference.type !== "commit" ||
      !sameSha(writtenReference.sha, publication.commitSha)
    ) {
      throw new ProviderResponseError(
        "github",
        "GitHub branch mutation did not return the approved candidate commit",
        false,
      );
    }

    const [verifiedReference, verifiedCommit] = await Promise.all([
      this.client.getBranchReference(
        this.config.owner,
        this.config.repository,
        publication.headBranch,
      ),
      this.client.getCommit(
        this.config.owner,
        this.config.repository,
        publication.headBranch,
      ),
    ]);
    if (
      verifiedReference === undefined ||
      verifiedReference.type !== "commit" ||
      !sameSha(verifiedReference.sha, publication.commitSha) ||
      !sameSha(verifiedCommit.sha, publication.commitSha) ||
      !sameSha(verifiedCommit.treeSha, publication.treeSha)
    ) {
      throw new ProviderResponseError(
        "github",
        "Published SafeFlash branch does not resolve to the Daytona-validated commit tree",
        false,
      );
    }
    return verifiedCommit;
  }

  async smokeReadiness(): Promise<ProviderEnvelope<GitHubSmokeEvidence>> {
    try {
      const [identity, repository] = await Promise.all([
        this.client.getAuthenticated(),
        this.client.getRepository(this.config.owner, this.config.repository),
      ]);
      if (repository.private) {
        throw new ProviderResponseError(
          "github",
          "The configured demo repository is private; P0 requires a public repository",
          false,
        );
      }
      if (repository.permissions?.push !== true) {
        throw new ProviderResponseError(
          "github",
          "The configured token does not report push permission for the demo repository",
          false,
        );
      }
      const baseHead = await this.client.getCommit(
        this.config.owner,
        this.config.repository,
        this.config.baseBranch,
      );
      if (
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(baseHead.sha) ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(baseHead.treeSha)
      ) {
        throw new ProviderResponseError(
          "github",
          "The configured base branch did not resolve to a full immutable commit SHA",
          false,
        );
      }
      return transportEnvelope("github", this.client, {
        authenticatedLogin: identity.login,
        owner: this.config.owner,
        repository: this.config.repository,
        public: true,
        pushPermission: true,
        defaultBranch: repository.defaultBranch,
        configuredBaseBranch: this.config.baseBranch,
        baseHeadSha: baseHead.sha,
        baseTreeSha: baseHead.treeSha,
      });
    } catch (error) {
      throw classifyGitHubError(
        error,
        "GitHub authentication/repository smoke failed",
      );
    }
  }

  /** Creates a PR or returns the exact existing open PR. No merge API exists. */
  async createOrGetPullRequest(
    request: CreatePullRequestRequest,
  ): Promise<ProviderEnvelope<PullRequestRecord>> {
    try {
      // Snapshot before validation and capability consumption. Every later
      // await uses this detached, frozen value, so caller mutation cannot
      // change the branch, blobs, commit, or PR content authorized by HMAC.
      request = deepFreezePublicationRequest(structuredClone(request));
    } catch (error) {
      throw classifyGitHubError(
        error,
        "GitHub publication request must be immutable plain server data",
      );
    }
    validateCreateRequest(request, this.config);
    if (this.publishAuthorization === undefined) {
      throw new PublishAuthorizationError(
        "INVALID_CONFIGURATION",
        "GitHub PR mutation requires a server-only publish authorization consumer",
      );
    }
    assertPublishAuthorizationAuthority(
      this.publishAuthorization,
      this.client,
    );
    this.publishAuthorization.consume(
      request.publishAuthorization,
      buildPullRequestPublishAuthorizationBinding(request, this.config),
    );
    try {
      const repository = await this.client.getRepository(
        this.config.owner,
        this.config.repository,
      );
      if (repository.private || repository.permissions?.push !== true) {
        throw new ProviderResponseError(
          "github",
          "PR mutation is allowed only on the configured public repository with push permission",
          false,
        );
      }
      await this.publishPreparedCandidateBranch(request.publication);

      const existing = await this.client.listOpenPullRequests({
        owner: this.config.owner,
        repository: this.config.repository,
        head: `${this.config.owner}:${request.headBranch}`,
        base: this.config.baseBranch,
      });
      if (existing.length > 1) {
        throw new ProviderResponseError(
          "github",
          "Multiple open PRs exist for the deterministic SafeFlash branch",
          false,
        );
      }
      let pullRequest = existing[0];
      if (pullRequest !== undefined) {
        if (
          pullRequest.headSha.toLowerCase() !==
            request.expectedHeadSha.toLowerCase() ||
          pullRequest.baseRef !== this.config.baseBranch ||
          pullRequest.baseSha.toLowerCase() !==
            request.publication.targetBaseCommitSha.toLowerCase()
        ) {
          throw new ProviderResponseError(
            "github",
            "Existing PR does not match the exact approved head/base revision",
            false,
          );
        }
        // A repair keeps the deterministic PR but changes its approved
        // evidence. Always refresh the title/body so the PR never advertises
        // stale Daytona or Braintrust results from an earlier validation round.
        pullRequest = await this.client.updatePullRequest({
          owner: this.config.owner,
          repository: this.config.repository,
          pullNumber: pullRequest.number,
          title: request.title,
          body: buildPullRequestBody(request.description),
        });
      } else {
        pullRequest = await this.client.createPullRequest({
          owner: this.config.owner,
          repository: this.config.repository,
          title: request.title,
          body: buildPullRequestBody(request.description),
          head: request.headBranch,
          base: this.config.baseBranch,
          draft: request.draft ?? false,
        });
      }

      if (
        pullRequest.merged ||
        pullRequest.state !== "open" ||
        pullRequest.headSha.toLowerCase() !== request.expectedHeadSha.toLowerCase() ||
        pullRequest.baseRef !== this.config.baseBranch ||
        pullRequest.baseSha.toLowerCase() !==
          request.publication.targetBaseCommitSha.toLowerCase()
      ) {
        throw new ProviderResponseError(
          "github",
          "GitHub PR response was not an open, unmerged PR at the approved head SHA",
          false,
        );
      }
      const [finalHead, finalReference, finalTargetBase, finalPullRequest] =
        await Promise.all([
          this.client.getCommit(
            this.config.owner,
            this.config.repository,
            request.headBranch,
          ),
          this.client.getBranchReference(
            this.config.owner,
            this.config.repository,
            request.headBranch,
          ),
          this.client.getCommit(
            this.config.owner,
            this.config.repository,
            this.config.baseBranch,
          ),
          this.client.getPullRequest(
            this.config.owner,
            this.config.repository,
            pullRequest.number,
          ),
        ]);
      if (
        finalReference === undefined ||
        finalReference.type !== "commit" ||
        finalReference.sha.toLowerCase() !== request.expectedHeadSha.toLowerCase() ||
        finalTargetBase.sha.toLowerCase() !==
          request.publication.targetBaseCommitSha.toLowerCase() ||
        finalHead.sha.toLowerCase() !== request.expectedHeadSha.toLowerCase() ||
        finalHead.treeSha.toLowerCase() !==
          request.validationReceipt.validatedTreeSha.toLowerCase() ||
        finalPullRequest.number !== pullRequest.number ||
        finalPullRequest.merged ||
        finalPullRequest.state !== "open" ||
        finalPullRequest.headSha.toLowerCase() !==
          request.expectedHeadSha.toLowerCase() ||
        finalPullRequest.headRef !== request.headBranch ||
        finalPullRequest.baseRef !== this.config.baseBranch ||
        finalPullRequest.baseSha.toLowerCase() !==
          request.publication.targetBaseCommitSha.toLowerCase()
      ) {
        throw new ProviderResponseError(
          "github",
          "GitHub PR head changed or no longer matches the Daytona-validated tree",
          false,
        );
      }
      const at = this.clock().toISOString();
      return transportEnvelope("github", this.client, {
        id: `github-pr-${finalPullRequest.number}`,
        sessionId: request.sessionId,
        createdAt: at,
        updatedAt: at,
        source: "github",
        sourceVersion: this.config.apiVersion,
        candidateId: request.candidateId,
        provider: "github",
        owner: this.config.owner,
        repository: this.config.repository,
        number: finalPullRequest.number,
        url: finalPullRequest.htmlUrl,
        headSha: finalPullRequest.headSha,
        headTreeSha: finalHead.treeSha,
        baseBranch: finalPullRequest.baseRef,
        baseSha: finalPullRequest.baseSha,
        status: "open",
      });
    } catch (error) {
      throw classifyGitHubError(error, "GitHub pull request creation failed");
    }
  }
}
