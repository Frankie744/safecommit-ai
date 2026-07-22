import { describe, expect, it } from "vitest";

import {
  selectCandidate,
  type CandidateEvaluationInput,
  type ScorerValues,
} from "../../packages/domain/src/index";

const passingScores: ScorerValues = {
  buildSuccess: 1,
  unitTestPassRate: 1,
  safetyInvariant: 1,
  regressionProtection: 1,
  patchIntegrity: 1,
  patchMinimality: 0.8,
  explanationGroundedness: 0.8,
  reproducibility: 1,
};

function candidate(
  candidateId: string,
  changes: Partial<ScorerValues> = {},
): CandidateEvaluationInput {
  return {
    candidateId,
    evidenceDigest: `${candidateId}-evidence`,
    values: { ...passingScores, ...changes },
  };
}

const metadata = {
  id: "decision-1",
  sessionId: "session-1",
  source: "braintrust",
  sourceVersion: "selector-v1",
  at: "2026-07-22T12:00:00.000Z",
  selectionPolicyVersion: "safety-v1",
} as const;

describe("hard-gate candidate selector", () => {
  it("failed_build_is_ineligible", () => {
    const decision = selectCandidate(
      [candidate("broken-build", { buildSuccess: 0 })],
      metadata,
    );

    expect(decision.winnerCandidateId).toBeNull();
    expect(decision.rankings[0]).toMatchObject({
      candidateId: "broken-build",
      eligible: false,
    });
    expect(decision.rankings[0]?.hardGateFailures).toContain(
      "BuildSuccess must equal 1",
    );
  });

  it("failed_safety_gate_cannot_be_compensated_by_high_average_score", () => {
    const unsafeButHighAverage = candidate("unsafe-high-score", {
      safetyInvariant: 0,
      regressionProtection: 1,
      patchMinimality: 1,
      explanationGroundedness: 1,
      reproducibility: 1,
    });
    const safe = candidate("safe", {
      regressionProtection: 0.8,
      patchMinimality: 0.7,
      explanationGroundedness: 0.7,
    });

    const decision = selectCandidate([unsafeButHighAverage, safe], metadata);

    expect(decision.winnerCandidateId).toBe("safe");
    expect(
      decision.rankings.find((ranking) => ranking.candidateId === "unsafe-high-score"),
    ).toMatchObject({ eligible: false });
  });

  it("highest_eligible_candidate_is_selected", () => {
    const decision = selectCandidate(
      [
        candidate("eligible-lower", { patchMinimality: 0.2 }),
        candidate("eligible-higher", { patchMinimality: 1 }),
        candidate("ineligible-high", {
          patchIntegrity: 0,
          patchMinimality: 1,
        }),
      ],
      metadata,
    );

    expect(decision.winnerCandidateId).toBe("eligible-higher");
    expect(decision.rankings[0]?.candidateId).toBe("eligible-higher");
    expect(decision.rankings.at(-1)?.candidateId).toBe("ineligible-high");
  });
});

