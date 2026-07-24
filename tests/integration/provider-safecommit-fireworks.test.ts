import {
  SafeCommitFireworksAdapter,
  SAFECOMMIT_CHANGE_PLAN_JSON_SCHEMA,
  ProviderResponseError,
  readSafeCommitFireworksConfig,
  type SafeCommitFireworksChatRequest,
  type SafeCommitFireworksChatResponse,
  type SafeCommitFireworksClient,
  type SafeCommitFireworksRequest,
  type FireworksConfig,
} from "@safeflash/integrations";
import { computeEvidenceDigest } from "@safeflash/domain";
import { logisticsIntentContract } from "../fixtures/database";
import { describe, expect, it } from "vitest";

const CONFIG: FireworksConfig = {
  mode: "live",
  apiKey: "contract-test-only",
  baseURL: "https://api.fireworks.ai/inference/v1",
  model: "accounts/fireworks/models/contract-test",
  maxAttempts: 2,
};

function request(): SafeCommitFireworksRequest {
  const schemaSql =
    "CREATE TABLE product (id VARCHAR(64), tenant_id VARCHAR(64), canonical_product_id VARCHAR(64));";
  const seedSql =
    "INSERT INTO product (id, tenant_id, canonical_product_id) VALUES ('product-duplicate', 'tenant-demo', NULL);";
  return {
    sessionId: "safecommit-test",
    candidateId: "candidate-live-c",
    strategy: "relationship-preserving",
    seed: 19,
    candidateScenario: {
      hypothesis: "Link only the intended duplicate product.",
      requiredPreconditions: [
        {
          checkId: "check-product",
          sql: "SELECT id FROM product WHERE id = 'product-duplicate'",
          expectation: "one-row",
          purpose: "Confirm the intended product exists.",
        },
      ],
      expectedEffects: [
        {
          effectId: "link-product",
          table: "product",
          operation: "update",
          predicate: "product-duplicate",
          expectedRowDelta: 1,
          explanation: "Preserve the row and relationships.",
        },
      ],
      risks: ["Historical rows remain intentionally preserved."],
    },
    intentContract: logisticsIntentContract(),
    databaseProfile: {
      profileId: "openboxes-mysql-v1",
      fixtureKind: "OpenBoxes-derived executable fixture",
      mysqlVersion: "8.0.36",
      fixtureSourceDigest: computeEvidenceDigest({ schemaSql, seedSql }),
      schemaFingerprint: computeEvidenceDigest(schemaSql),
      schemaSql,
      seedSql,
      sourceRevision: "b".repeat(40),
      tables: ["product", "allocation", "order_line", "order_header"],
    },
  };
}

function response(sql: string): SafeCommitFireworksChatResponse {
  return {
    id: "fireworks-provider-request-1",
    model: CONFIG.model,
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            candidateId: "candidate-live-c",
            strategy: "relationship-preserving",
            hypothesis: "Update only the intended product relationship.",
            preconditions: [
              {
                checkId: "check-product",
                sql: "SELECT id FROM product WHERE id = 'product-duplicate'",
                expectation: "one-row",
                purpose: "Confirm the intended product exists.",
              },
            ],
            statements: [
              {
                statementId: "link-product",
                operation: "update",
                sql,
                purpose: "Link the intended duplicate only.",
                maxAffectedRows: 1,
              },
            ],
            expectedEffects: [
              {
                effectId: "link-product",
                table: "product",
                operation: "update",
                predicate: "product-duplicate",
                expectedRowDelta: 1,
                explanation: "Preserve the row and relationships.",
              },
            ],
            rollbackPlan: [
              {
                statementId: "unlink-product",
                operation: "update",
                sql: "UPDATE product SET canonical_product_id = NULL WHERE id = 'product-duplicate' AND tenant_id = 'tenant-demo'",
                purpose: "Restore the original relationship.",
                maxAffectedRows: 1,
              },
            ],
            risks: ["Historical rows remain intentionally preserved."],
            requestedValidations: [
              "TenantIsolation",
              "ReferentialIntegrity",
              "RollbackVerified",
            ],
          }),
        },
      },
    ],
    usage: { total_tokens: 321 },
  };
}

class FakeClient implements SafeCommitFireworksClient {
  readonly transport = "local-test" as const;
  readonly requests: SafeCommitFireworksChatRequest[] = [];

  constructor(private readonly result: SafeCommitFireworksChatResponse) {}

  async createChatCompletion(
    value: SafeCommitFireworksChatRequest,
  ): Promise<SafeCommitFireworksChatResponse> {
    this.requests.push(value);
    return this.result;
  }
}

class RetryClient implements SafeCommitFireworksClient {
  readonly transport = "local-test" as const;
  readonly requests: SafeCommitFireworksChatRequest[] = [];

  constructor(
    private readonly result: SafeCommitFireworksChatResponse,
    private remainingFailures: number,
  ) {}

  async createChatCompletion(
    value: SafeCommitFireworksChatRequest,
  ): Promise<SafeCommitFireworksChatResponse> {
    this.requests.push(value);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("Connection error.");
    }
    return this.result;
  }
}

describe("SafeCommit Fireworks plan adapter", () => {
  it("uses structured output and validates SQL with the server policy", async () => {
    const client = new FakeClient(
      response(
        "UPDATE product SET canonical_product_id = 'product-canonical' WHERE id = 'product-duplicate' AND tenant_id = 'tenant-demo'",
      ),
    );
    let now = 1_000;
    const result = await new SafeCommitFireworksAdapter(
      CONFIG,
      client,
      () => (now += 10),
    ).generateCandidate(request());

    expect(result.provenance.kind).toBe("local-test");
    expect(result.data.requestId).toBe("fireworks-provider-request-1");
    expect(result.data.totalTokens).toBe(321);
    expect(result.data.candidate.candidateId).toBe("candidate-live-c");
    expect(
      client.requests[0]?.response_format.json_schema.schema,
    ).toEqual(SAFECOMMIT_CHANGE_PLAN_JSON_SCHEMA);
    expect(client.requests[0]?.messages[0]?.content).toContain(
      "Never emit DDL",
    );
    expect(client.requests[0]?.messages[1]?.content).toContain(
      '"candidateChangePlanJsonSchema"',
    );
    expect(client.requests[0]?.messages[1]?.content).toContain(
      "explicit bounded predicate",
    );
    expect(client.requests[0]?.messages[1]?.content).toContain(
      '"candidateScenario"',
    );
    expect(client.requests[0]?.messages[1]?.content).toContain(
      '"requiredPreconditions"',
    );
    expect(client.requests[0]?.max_completion_tokens).toBe(8_192);
    expect(client.requests[0]?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1_024,
    });
  });

  it("retries one transient provider connection failure", async () => {
    const client = new RetryClient(
      response(
        "UPDATE product SET canonical_product_id = 'product-canonical' WHERE id = 'product-duplicate' AND tenant_id = 'tenant-demo'",
      ),
      1,
    );
    const result = await new SafeCommitFireworksAdapter(
      CONFIG,
      client,
    ).generateCandidate(request());

    expect(result.data.candidate.candidateId).toBe("candidate-live-c");
    expect(client.requests).toHaveLength(2);
  });

  it("fails closed on an unbounded provider plan", async () => {
    const client = new FakeClient(
      response(
        "UPDATE product SET canonical_product_id = 'product-canonical'",
      ),
    );
    await expect(
      new SafeCommitFireworksAdapter(CONFIG, client).generateCandidate(
        request(),
      ),
    ).rejects.toThrow(ProviderResponseError);
  });

  it("requires explicit live authorization and the official endpoint", () => {
    expect(() =>
      readSafeCommitFireworksConfig({
        FIREWORKS_API_KEY: "configured",
        FIREWORKS_MODEL: CONFIG.model,
      }),
    ).toThrow();
    expect(() =>
      readSafeCommitFireworksConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "configured",
        FIREWORKS_MODEL: CONFIG.model,
        FIREWORKS_BASE_URL: "https://collector.example/v1",
      }),
    ).toThrow(ProviderResponseError);
  });
});
