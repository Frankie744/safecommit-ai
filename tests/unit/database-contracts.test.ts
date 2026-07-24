import { describe, expect, it } from "vitest";

import {
  CandidateChangePlanSchema,
  DatabaseEvidenceSchema,
  IntentContractSchema,
  computeEvidenceDigest,
} from "@safeflash/domain";
import {
  logisticsCandidatePlan,
  logisticsIntentContract,
} from "../fixtures/database";

describe("SafeCommit database contracts", () => {
  it("strictly validates intent and candidate plans", () => {
    expect(IntentContractSchema.parse(logisticsIntentContract()).databaseProfile).toBe(
      "openboxes-mysql-v1",
    );
    expect(
      CandidateChangePlanSchema.parse(logisticsCandidatePlan()).strategy,
    ).toBe("relationship-preserving");

    expect(
      IntentContractSchema.safeParse({
        ...logisticsIntentContract(),
        maxAffectedRows: 0,
      }).success,
    ).toBe(false);
    expect(
      IntentContractSchema.safeParse({
        ...logisticsIntentContract(),
        allowedWarehouses: ["warehouse-la", "WAREHOUSE-LA"],
      }).success,
    ).toBe(false);
    expect(
      CandidateChangePlanSchema.safeParse({
        ...logisticsCandidatePlan(),
        databasePassword: "must-never-be-model-controlled",
      }).success,
    ).toBe(false);
  });

  it("validates complete database evidence and rejects unknown fields", () => {
    const digest = computeEvidenceDigest("fixture");
    const evidence = {
      sessionId: "session-database-1",
      candidateId: "candidate-relationship-preserving",
      sourceCommitSha: "a".repeat(40),
      snapshotId: "safecommit-openboxes-mysql-v1",
      snapshotDigest: digest,
      sandboxId: "local-mysql-candidate-c",
      runId: "run-candidate-c",
      planDigest: digest,
      intentContractDigest: digest,
      schemaFingerprint: digest,
      beforeStateDigest: digest,
      afterStateDigest: computeEvidenceDigest("after"),
      rollbackStateDigest: digest,
      statementResults: [
        {
          statementId: "release-cancelled-allocation",
          executionOrder: 0,
          affectedRows: 1,
          durationMs: 8,
          resultDigest: digest,
        },
      ],
      rowDelta: [
        {
          table: "allocation",
          primaryKey: { id: "allocation-cancelled-la" },
          changeKind: "updated",
          before: { quantity: 3 },
          after: { quantity: 0 },
        },
      ],
      invariantResults: [
        {
          name: "WarehouseScope",
          passed: true,
          explanation: "Only warehouse-la changed.",
          evidenceDigest: digest,
        },
      ],
      providerEvidence: {
        provenance: "local-test",
        executionProvider: "local-mysql",
        evaluationProvider: "local-deterministic",
        providerResourceIds: [],
        evidenceRefs: [],
      },
    };

    expect(DatabaseEvidenceSchema.parse(evidence).snapshotDigest).toBe(digest);
    expect(
      DatabaseEvidenceSchema.safeParse({ ...evidence, apiKey: "forbidden" })
        .success,
    ).toBe(false);
  });
});
