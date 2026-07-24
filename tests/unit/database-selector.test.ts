import { describe, expect, it } from "vitest";

import {
  DatabaseEvidenceSchema,
  computeEvidenceDigest,
} from "@safeflash/domain";
import {
  computeDatabaseWeightedScore,
  loadSafeCommitDatabaseProfile,
  rankDatabaseCandidates,
  type DatabaseTournamentCandidate,
} from "@safeflash/orchestrator";
import {
  evaluateDatabaseHardGates,
  type DatabaseInvariantContext,
} from "@safeflash/safety-policy";

function context(change: Partial<DatabaseInvariantContext> = {}) {
  return {
    executionSucceeded: true,
    planIntegrityPassed: true,
    allowedWarehouses: ["warehouse-la"],
    touchedWarehouses: ["warehouse-la"],
    allowedTenants: ["tenant-demo"],
    touchedTenants: ["tenant-demo"],
    inventoryUnitsBefore: 34,
    inventoryUnitsAfter: 34,
    negativeInventoryRows: 0,
    overAllocatedRows: 0,
    lostLotOrSerialRows: 0,
    referentialIntegrityViolations: 0,
    protectedOrderRowsChanged: 0,
    affectedRows: 2,
    maxAffectedRows: 24,
    beforeStateDigest: "before",
    afterStateDigest: "after",
    secondRunStateDigest: "after",
    rollbackStateDigest: "before",
    ...change,
  } satisfies DatabaseInvariantContext;
}

describe("eligible-only database selector", () => {
  it("rejects the higher-scoring plan when a business invariant fails", async () => {
    const profile = await loadSafeCommitDatabaseProfile();
    const digest = computeEvidenceDigest("selector");
    const makeCandidate = (
      index: number,
      weightedScore: number,
      gates = evaluateDatabaseHardGates(context()),
    ): DatabaseTournamentCandidate => {
      const plan = profile.candidates[index]!;
      return {
        plan,
        gates,
        qualityScores: {
          taskCompletion: weightedScore,
          minimality: weightedScore,
          explanationGroundedness: weightedScore,
          reproducibility: weightedScore,
          latency: weightedScore,
          cost: weightedScore,
        },
        weightedScore,
        evidence: DatabaseEvidenceSchema.parse({
          sessionId: "session-selector",
          candidateId: plan.candidateId,
          sourceCommitSha: "a".repeat(40),
          snapshotId: profile.profileId,
          snapshotDigest: digest,
          sandboxId: `sandbox-${index}`,
          runId: `run-${index}`,
          planDigest: computeEvidenceDigest(plan),
          intentContractDigest: computeEvidenceDigest(profile.intentContract),
          schemaFingerprint: digest,
          beforeStateDigest: digest,
          afterStateDigest: computeEvidenceDigest(`after-${index}`),
          rollbackStateDigest: digest,
          statementResults: [
            {
              statementId: plan.statements[0]!.statementId,
              executionOrder: 0,
              affectedRows: 1,
              durationMs: 1,
              resultDigest: digest,
            },
          ],
          rowDelta: [],
          invariantResults: gates.results,
          providerEvidence: {
            provenance: "local-test",
            executionProvider: "local-mysql",
            evaluationProvider: "local-deterministic",
            providerResourceIds: [],
            evidenceRefs: [],
          },
        }),
      };
    };

    const rankings = rankDatabaseCandidates([
      makeCandidate(
        0,
        0.99,
        evaluateDatabaseHardGates(
          context({ touchedWarehouses: ["warehouse-la", "warehouse-ny"] }),
        ),
      ),
      makeCandidate(2, 0.88),
    ]);

    expect(rankings[0]).toMatchObject({
      candidateId: "candidate-c-safe",
      eligible: true,
      weightedScore: 0.88,
    });
    expect(rankings[1]).toMatchObject({
      candidateId: "candidate-a-aggressive",
      eligible: false,
      weightedScore: 0.99,
      failedGateNames: ["WarehouseScope"],
    });
  });

  it("computes a bounded deterministic quality score", () => {
    expect(
      computeDatabaseWeightedScore({
        taskCompletion: 1,
        minimality: 1,
        explanationGroundedness: 1,
        reproducibility: 1,
        latency: 1,
        cost: 1,
      }),
    ).toBe(1);
  });
});
