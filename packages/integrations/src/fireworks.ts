import {
  CandidatePatchSchema,
  canonicalJson,
  type CandidatePatch,
  type CandidateStrategy,
  type OperatingMode,
} from "@safeflash/domain";
import OpenAI from "openai";

import {
  ProviderResponseError,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";

export const FIREWORKS_DEFAULT_BASE_URL =
  "https://api.fireworks.ai/inference/v1";

export const CANDIDATE_PATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "candidateId",
    "strategy",
    "hypothesis",
    "unifiedDiff",
    "expectedSafetyEffect",
    "risks",
    "testsToRun",
  ],
  properties: {
    candidateId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    },
    strategy: {
      type: "string",
      enum: ["fail-closed", "retry-and-latch", "range-validation"],
    },
    hypothesis: { type: "string", minLength: 1, maxLength: 2_000 },
    unifiedDiff: { type: "string", minLength: 1, maxLength: 100_000 },
    expectedSafetyEffect: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    risks: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    testsToRun: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
} as const;

export interface FireworksConfig {
  mode: "live";
  apiKey: string;
  baseURL: string;
  model: string;
  maxAttempts: number;
}

export interface FireworksCandidateRequest {
  sessionId: string;
  candidateId: string;
  strategy: CandidateStrategy;
  incident: {
    title: string;
    summary: string;
    evidence: readonly string[];
  };
  safetyPolicy: {
    policyVersion: string;
    invariants: readonly string[];
    allowedPatchPaths: readonly string[];
    protectedPaths: readonly string[];
    maxChangedFiles: number;
    maxChangedLines: number;
  };
  repository: {
    repoUrl: string;
    commitSha: string;
  };
  requestedTests: readonly string[];
  seed: number;
}

export interface FireworksCandidateEvidence {
  candidate: CandidatePatch;
  requestId?: string;
  model: string;
  latencyMs: number;
  finishReason: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  attemptCount: number;
}

export interface FireworksChatRequest {
  model: string;
  messages: readonly {
    role: "system" | "user";
    content: string;
  }[];
  temperature: number;
  seed: number;
  response_format: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: typeof CANDIDATE_PATCH_JSON_SCHEMA;
    };
  };
}

export interface FireworksChatResponse {
  id?: string;
  model: string;
  choices: readonly {
    finish_reason: string | null;
    message: { content: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  _request_id?: string | null;
}

export interface FireworksClient {
  readonly transport: ProviderTransport;
  createChatCompletion(request: FireworksChatRequest): Promise<FireworksChatResponse>;
}

export function readFireworksConfig(
  environment: Environment = process.env,
  mode: OperatingMode = "live",
): FireworksConfig {
  const values = requireLiveConfiguration(
    "fireworks",
    mode,
    environment,
    ["FIREWORKS_API_KEY", "FIREWORKS_MODEL"] as const,
  );
  const baseURL =
    environment.FIREWORKS_BASE_URL?.trim() || FIREWORKS_DEFAULT_BASE_URL;
  const parsed = new URL(baseURL);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "api.fireworks.ai" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !["/inference/v1", "/inference/v1/"].includes(parsed.pathname) ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ProviderResponseError(
      "fireworks",
      "FIREWORKS_BASE_URL must be the official https://api.fireworks.ai/inference/v1 endpoint",
      false,
    );
  }
  return {
    mode: "live",
    apiKey: values.FIREWORKS_API_KEY,
    model: values.FIREWORKS_MODEL,
    baseURL,
    maxAttempts: 2,
  };
}

export function createFireworksClient(config: FireworksConfig): FireworksClient {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  return {
    transport: "official-sdk",
    async createChatCompletion(request) {
      return (await client.chat.completions.create(
        request as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      )) as FireworksChatResponse;
    },
  };
}

function promptForCandidate(request: FireworksCandidateRequest): string {
  return canonicalJson({
    instruction:
      "Return only JSON matching CandidatePatch. Produce a minimal unified diff for the exact requested strategy. Do not modify protected paths, tests, CI, hidden files, safety thresholds, or validation tooling. testsToRun contains identifiers only, never shell commands.",
    requiredCandidateId: request.candidateId,
    requiredStrategy: request.strategy,
    incident: request.incident,
    safetyPolicy: request.safetyPolicy,
    repository: request.repository,
    requestedTests: request.requestedTests,
  });
}

function isRetryableProviderFailure(error: unknown): boolean {
  if (error instanceof ProviderResponseError) return error.retryable;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  return (
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export class FireworksAdapter {
  constructor(
    private readonly config: FireworksConfig,
    private readonly client: FireworksClient = createFireworksClient(config),
    private readonly now: () => number = Date.now,
  ) {}

  async generateCandidate(
    request: FireworksCandidateRequest,
  ): Promise<ProviderEnvelope<FireworksCandidateEvidence>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const startedAt = this.now();
      try {
        const response = await this.client.createChatCompletion({
          model: this.config.model,
          messages: [
            {
              role: "system",
              content:
                "You are a firmware safety repair generator. Output JSON only; never emit prose outside the schema.",
            },
            { role: "user", content: promptForCandidate(request) },
          ],
          temperature: 0,
          seed: request.seed,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "CandidatePatch",
              schema: CANDIDATE_PATCH_JSON_SCHEMA,
            },
          },
        });
        const choice = response.choices[0];
        if (choice === undefined) {
          throw new ProviderResponseError(
            "fireworks",
            "Fireworks returned no completion choice",
            true,
          );
        }
        if (choice.finish_reason === "length") {
          throw new ProviderResponseError(
            "fireworks",
            "Fireworks structured response was truncated",
            true,
          );
        }
        if (choice.finish_reason !== "stop") {
          throw new ProviderResponseError(
            "fireworks",
            `Unexpected Fireworks finish_reason: ${choice.finish_reason ?? "null"}`,
            false,
          );
        }
        if (choice.message.content === null) {
          throw new ProviderResponseError(
            "fireworks",
            "Fireworks returned an empty structured response",
            true,
          );
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(choice.message.content);
        } catch (error) {
          throw new ProviderResponseError(
            "fireworks",
            "Fireworks returned invalid JSON",
            true,
            { cause: error },
          );
        }
        const parsed = CandidatePatchSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new ProviderResponseError(
            "fireworks",
            `CandidatePatch failed local validation: ${parsed.error.issues
              .map((issue) => issue.message)
              .join("; ")}`,
            true,
          );
        }
        if (
          parsed.data.candidateId !== request.candidateId ||
          parsed.data.strategy !== request.strategy
        ) {
          throw new ProviderResponseError(
            "fireworks",
            "Candidate identity or strategy did not match the requested tournament slot",
            false,
          );
        }

        return transportEnvelope("fireworks", this.client.transport, {
          candidate: parsed.data,
          requestId: response._request_id ?? response.id,
          model: response.model,
          latencyMs: Math.max(0, this.now() - startedAt),
          finishReason: choice.finish_reason,
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens,
          attemptCount: attempt,
        });
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.maxAttempts || !isRetryableProviderFailure(error)) {
          if (error instanceof ProviderResponseError) throw error;
          throw new ProviderResponseError(
            "fireworks",
            "Fireworks candidate generation failed",
            isRetryableProviderFailure(error),
            { cause: error },
          );
        }
      }
    }
    throw new ProviderResponseError(
      "fireworks",
      "Fireworks exhausted structured-output attempts",
      false,
      { cause: lastError },
    );
  }

  async generateTournament(
    requests: readonly FireworksCandidateRequest[],
  ): Promise<readonly ProviderEnvelope<FireworksCandidateEvidence>[]> {
    const strategies = new Set(requests.map((request) => request.strategy));
    const candidateIds = new Set(requests.map((request) => request.candidateId));
    if (
      requests.length !== 3 ||
      strategies.size !== 3 ||
      candidateIds.size !== 3
    ) {
      throw new ProviderResponseError(
        "fireworks",
        "Tournament generation requires exactly three unique candidate IDs and strategies",
        false,
      );
    }
    const results = await Promise.all(
      requests.map((request) => this.generateCandidate(request)),
    );
    if (new Set(results.map((result) => result.data.candidate.candidateId)).size !== 3) {
      throw new ProviderResponseError(
        "fireworks",
        "Fireworks returned duplicate candidate IDs",
        false,
      );
    }
    return results;
  }
}
