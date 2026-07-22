import {
  isApprovalValid,
  type ApprovalBinding,
  type HumanApproval,
  type OperatingMode,
  type PullRequestRecord,
} from "@safeflash/domain";

import {
  ProviderResponseError,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";

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
}

export interface GitHubClientPort {
  readonly transport: ProviderTransport;
  getAuthenticated(): Promise<{ login: string }>;
  getRepository(owner: string, repository: string): Promise<GitHubRepositoryInfo>;
  getCommit(
    owner: string,
    repository: string,
    ref: string,
  ): Promise<{ sha: string }>;
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
}

export interface GitHubSmokeEvidence {
  authenticatedLogin: string;
  owner: string;
  repository: string;
  public: true;
  pushPermission: true;
  defaultBranch: string;
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
  approval: HumanApproval;
  currentBinding: ApprovalBinding;
  draft?: boolean;
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
  return {
    mode: "live",
    token: values.GITHUB_TOKEN,
    owner: values.GITHUB_OWNER,
    repository: values.GITHUB_REPO,
    baseBranch: environment.GITHUB_BASE_BRANCH?.trim() || "main",
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
  base: { ref: string };
}): GitHubPullRequestInfo {
  return {
    number: data.number,
    htmlUrl: data.html_url,
    state: data.state === "open" ? "open" : "closed",
    merged: data.merged === true || data.merged_at != null,
    headSha: data.head.sha,
    headRef: data.head.ref,
    baseRef: data.base.ref,
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
  return {
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
      return { sha: response.data.sha };
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
  };
}

function requireNonEmpty(label: string, value: string): void {
  if (value.trim() === "") {
    throw new ProviderResponseError("github", `${label} must not be empty`, false);
  }
}

function validateCreateRequest(
  request: CreatePullRequestRequest,
  config: GitHubConfig,
): void {
  if (!isApprovalValid(request.approval, request.currentBinding)) {
    throw new ProviderResponseError(
      "github",
      "Pull request creation requires a current evidence-bound human approval",
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
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(request.headBranch) ||
    request.headBranch.includes("..") ||
    request.headBranch.endsWith("/") ||
    request.headBranch === config.baseBranch
  ) {
    throw new ProviderResponseError(
      "github",
      "Pull request head branch is invalid or equals the base branch",
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

export class GitHubAdapter {
  constructor(
    private readonly config: GitHubConfig,
    private readonly client: GitHubClientPort = createGitHubClient(config),
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
      return transportEnvelope("github", this.client.transport, {
        authenticatedLogin: identity.login,
        owner: this.config.owner,
        repository: this.config.repository,
        public: true,
        pushPermission: true,
        defaultBranch: repository.defaultBranch,
      });
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "github",
        "GitHub authentication/repository smoke failed",
        false,
        { cause: error },
      );
    }
  }

  /** Creates a PR or returns the exact existing open PR. No merge API exists. */
  async createOrGetPullRequest(
    request: CreatePullRequestRequest,
  ): Promise<ProviderEnvelope<PullRequestRecord>> {
    validateCreateRequest(request, this.config);
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
      const remoteHead = await this.client.getCommit(
        this.config.owner,
        this.config.repository,
        request.headBranch,
      );
      if (
        remoteHead.sha.toLowerCase() !== request.expectedHeadSha.toLowerCase()
      ) {
        throw new ProviderResponseError(
          "github",
          "Remote branch head does not match the approval-bound expected SHA",
          false,
        );
      }

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
          pullRequest.baseRef !== this.config.baseBranch
        ) {
          throw new ProviderResponseError(
            "github",
            "Existing PR does not match the exact approved head/base revision",
            false,
          );
        }
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
        pullRequest.headSha.toLowerCase() !== request.expectedHeadSha.toLowerCase()
      ) {
        throw new ProviderResponseError(
          "github",
          "GitHub PR response was not an open, unmerged PR at the approved head SHA",
          false,
        );
      }
      const at = this.clock().toISOString();
      return transportEnvelope("github", this.client.transport, {
        id: `github-pr-${pullRequest.number}`,
        sessionId: request.sessionId,
        createdAt: at,
        updatedAt: at,
        source: "github",
        sourceVersion: this.config.apiVersion,
        candidateId: request.candidateId,
        provider: "github",
        owner: this.config.owner,
        repository: this.config.repository,
        number: pullRequest.number,
        url: pullRequest.htmlUrl,
        headSha: pullRequest.headSha,
        baseBranch: pullRequest.baseRef,
        status: "open",
      });
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "github",
        "GitHub pull request creation failed",
        false,
        { cause: error },
      );
    }
  }
}
