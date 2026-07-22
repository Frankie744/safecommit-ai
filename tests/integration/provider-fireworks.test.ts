import { describe, expect, it } from "vitest";

import {
  FireworksAdapter,
  ProviderResponseError,
  readFireworksConfig,
  type FireworksCandidateRequest,
  type FireworksChatRequest,
  type FireworksChatResponse,
  type FireworksClient,
  type FireworksConfig,
} from "@safeflash/integrations";

const CONFIG: FireworksConfig = {
  mode: "live",
  apiKey: "test-only-not-a-live-key",
  baseURL: "https://api.fireworks.ai/inference/v1",
  model: "accounts/fireworks/models/test-contract-model",
  maxAttempts: 2,
};

function request(
  candidateId = "candidate-a",
  strategy: FireworksCandidateRequest["strategy"] = "fail-closed",
): FireworksCandidateRequest {
  return {
    sessionId: "session-contract",
    candidateId,
    strategy,
    incident: {
      title: "stale current sample",
      summary: "timeout reused stale measurement",
      evidence: ["ADC_TIMEOUT", "charge enabled"],
    },
    safetyPolicy: {
      policyVersion: "v1",
      invariants: ["timeout disables charge"],
      allowedPatchPaths: ["fixtures/battery-controller/src/**"],
      protectedPaths: ["fixtures/battery-controller/tests/**"],
      maxChangedFiles: 2,
      maxChangedLines: 50,
    },
    repository: {
      repoUrl: "https://github.com/example/safeflash.git",
      commitSha: "a".repeat(40),
    },
    requestedTests: ["battery_unit_tests", "battery_safety_tests"],
    seed: 7,
  };
}

function validResponse(
  candidateId = "candidate-a",
  strategy: FireworksCandidateRequest["strategy"] = "fail-closed",
): FireworksChatResponse {
  return {
    id: "provider-request-contract",
    model: CONFIG.model,
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            candidateId,
            strategy,
            hypothesis: "Fail closed when the current sample is invalid.",
            unifiedDiff:
              "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -1 +1 @@\n-old\n+new\n",
            expectedSafetyEffect: ["charge output is disabled on timeout"],
            risks: ["fault recovery requires an explicit clear"],
            testsToRun: ["battery_unit_tests", "battery_safety_tests"],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

class FakeFireworksClient implements FireworksClient {
  readonly transport = "local-test" as const;
  readonly requests: FireworksChatRequest[] = [];

  constructor(private readonly responses: FireworksChatResponse[]) {}

  async createChatCompletion(
    requestValue: FireworksChatRequest,
  ): Promise<FireworksChatResponse> {
    this.requests.push(requestValue);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake response configured");
    return response;
  }
}

describe("Fireworks structured candidate contract", () => {
  it("allows live credentials only for the official Fireworks endpoint", () => {
    expect(
      readFireworksConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "configured-for-contract-test",
        FIREWORKS_MODEL: CONFIG.model,
      }),
    ).toMatchObject({
      baseURL: "https://api.fireworks.ai/inference/v1",
      model: CONFIG.model,
    });
    expect(() =>
      readFireworksConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "configured-for-contract-test",
        FIREWORKS_MODEL: CONFIG.model,
        FIREWORKS_BASE_URL: "https://credential-collector.example/v1",
      }),
    ).toThrow(ProviderResponseError);
    expect(() =>
      readFireworksConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "configured-for-contract-test",
        FIREWORKS_MODEL: CONFIG.model,
        FIREWORKS_BASE_URL:
          "https://embedded:credential@api.fireworks.ai/inference/v1",
      }),
    ).toThrow(ProviderResponseError);
    expect(() =>
      readFireworksConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "configured-for-contract-test",
        FIREWORKS_MODEL: CONFIG.model,
        FIREWORKS_BASE_URL: "https://api.fireworks.ai/not-the-inference-api",
      }),
    ).toThrow(ProviderResponseError);
  });

  it("uses JSON schema and validates the response locally", async () => {
    const client = new FakeFireworksClient([validResponse()]);
    let now = 1_000;
    const adapter = new FireworksAdapter(CONFIG, client, () => (now += 25));
    const result = await adapter.generateCandidate(request());

    expect(result.provenance.kind).toBe("local-test");
    expect(result.data.candidate.candidateId).toBe("candidate-a");
    expect(result.data.finishReason).toBe("stop");
    expect(result.data.totalTokens).toBe(30);
    expect(client.requests[0]?.response_format.type).toBe("json_schema");
    expect(client.requests[0]?.response_format.json_schema.schema).toMatchObject({
      additionalProperties: false,
    });
    expect(client.requests[0]?.messages[1]?.content).toContain(
      "fixtures/battery-controller/tests/**",
    );
  });

  it("retries a malformed structured response but rejects identity drift", async () => {
    const retryClient = new FakeFireworksClient([
      {
        model: CONFIG.model,
        choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
      },
      validResponse(),
    ]);
    const retried = await new FireworksAdapter(CONFIG, retryClient).generateCandidate(
      request(),
    );
    expect(retried.data.attemptCount).toBe(2);
    expect(retryClient.requests).toHaveLength(2);

    const driftClient = new FakeFireworksClient([
      validResponse("candidate-other", "fail-closed"),
    ]);
    await expect(
      new FireworksAdapter(CONFIG, driftClient).generateCandidate(request()),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(driftClient.requests).toHaveLength(1);
  });

  it("requires exactly three unique tournament strategies", async () => {
    const client = new FakeFireworksClient([]);
    const adapter = new FireworksAdapter(CONFIG, client);
    await expect(
      adapter.generateTournament([
        request("a", "fail-closed"),
        request("b", "fail-closed"),
        request("c", "range-validation"),
      ]),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(client.requests).toHaveLength(0);
  });
});
