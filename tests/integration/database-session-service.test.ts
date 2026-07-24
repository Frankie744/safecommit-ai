import { afterEach, describe, expect, it } from "vitest";

import { authorizeDatabaseMutation } from "../../apps/web/server/database-auth";
import {
  DatabaseSessionService,
  DatabaseSessionServiceError,
} from "../../apps/web/server/database-session-service";

const originalToken = process.env.SAFECOMMIT_OPERATOR_TOKEN;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.SAFECOMMIT_OPERATOR_TOKEN;
  } else {
    process.env.SAFECOMMIT_OPERATOR_TOKEN = originalToken;
  }
});

describe("SafeCommit database session service", () => {
  it("keeps the higher-scoring unsafe plans outside the approval boundary", async () => {
    const service = new DatabaseSessionService({
      sourceCommitSha: "a".repeat(40),
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });
    const session = await service.create({ mode: "mock" });

    expect(session.provenance).toBe("MOCK");
    expect(session.providerVerified).toBe(false);
    expect(session.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(session.winnerCandidateId).toBe("candidate-c-safe");
    expect(session.candidates[0]).toMatchObject({
      candidateId: "candidate-a-aggressive",
      weightedScore: 0.96,
      eligible: false,
      failedGateNames: ["WarehouseScope", "TenantIsolation"],
    });
    expect(session.candidates[2]).toMatchObject({
      candidateId: "candidate-c-safe",
      weightedScore: 0.88,
      eligible: true,
    });
  });

  it("binds human approval and visibly invalidates it after evidence changes", async () => {
    let now = Date.parse("2026-07-24T00:00:00.000Z");
    const service = new DatabaseSessionService({
      sourceCommitSha: "b".repeat(40),
      now: () => new Date(now),
    });
    const created = await service.create({ mode: "mock" });
    now += 1_000;
    const approved = service.decide(created.sessionId, {
      decision: "approved",
    });

    expect(approved.state).toBe("SAFE_TO_COMMIT");
    expect(approved.approval).toMatchObject({ decision: "approved" });
    expect(approved.approval).not.toHaveProperty("invalidatedAt");
    const approvedDigest = approved.currentEvidenceDigest;

    now += 1_000;
    const revalidated = service.revalidate(created.sessionId);
    expect(revalidated.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(revalidated.currentEvidenceDigest).not.toBe(approvedDigest);
    expect(revalidated.approval?.invalidatedAt).toBe(
      "2026-07-24T00:00:02.000Z",
    );
    expect(revalidated.auditEvents.map((event) => event.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(revalidated.auditEvents[2]?.previousEventHash).toBe(
      revalidated.auditEvents[1]?.eventHash,
    );
  });

  it("fails closed when LOCAL_TEST has no server-side MySQL URL", async () => {
    const previous = process.env.SAFECOMMIT_MYSQL_URL;
    delete process.env.SAFECOMMIT_MYSQL_URL;
    try {
      await expect(
        new DatabaseSessionService().create({ mode: "local-test" }),
      ).rejects.toMatchObject({
        code: "CONFIGURATION_BLOCKED",
      });
    } finally {
      if (previous === undefined) delete process.env.SAFECOMMIT_MYSQL_URL;
      else process.env.SAFECOMMIT_MYSQL_URL = previous;
    }
  });
});

describe("database mutation authorization", () => {
  it("requires server configuration, exact same origin, and operator token", async () => {
    delete process.env.SAFECOMMIT_OPERATOR_TOKEN;
    expect(
      authorizeDatabaseMutation(
        new Request("http://127.0.0.1:3018/api/database-sessions", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:3018" },
        }),
      )?.status,
    ).toBe(503);

    process.env.SAFECOMMIT_OPERATOR_TOKEN =
      "safecommit-test-operator-token-123456";
    expect(
      authorizeDatabaseMutation(
        new Request("http://127.0.0.1:3018/api/database-sessions", {
          method: "POST",
          headers: {
            origin: "https://attacker.invalid",
            "x-safecommit-operator-token":
              "safecommit-test-operator-token-123456",
          },
        }),
      )?.status,
    ).toBe(403);
    expect(
      authorizeDatabaseMutation(
        new Request("http://127.0.0.1:3018/api/database-sessions", {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:3018",
            "x-safecommit-operator-token": "wrong",
          },
        }),
      )?.status,
    ).toBe(401);
    expect(
      authorizeDatabaseMutation(
        new Request("http://127.0.0.1:3018/api/database-sessions", {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:3018",
            "x-safecommit-operator-token":
              "safecommit-test-operator-token-123456",
          },
        }),
      ),
    ).toBeUndefined();
  });
});
