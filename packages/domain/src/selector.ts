import type {
  CandidateDecision,
  CandidateRanking,
  DomainEntity,
  ScorerValues,
} from "./types";

export interface CandidateEvaluationInput {
  candidateId: string;
  values: ScorerValues;
  evidenceDigest: string;
}

export interface SelectionMetadata
  extends Pick<DomainEntity, "id" | "sessionId" | "source" | "sourceVersion"> {
  at: string;
  selectionPolicyVersion: string;
}

const WEIGHTS = {
  regressionProtection: 0.3,
  unitTestPassRate: 0.25,
  patchMinimality: 0.2,
  explanationGroundedness: 0.15,
  reproducibility: 0.1,
} as const;

function assertScore(name: keyof ScorerValues, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite score between 0 and 1`);
  }
}

export function evaluateEligibility(values: ScorerValues): readonly string[] {
  for (const [name, value] of Object.entries(values) as [
    keyof ScorerValues,
    number,
  ][]) {
    assertScore(name, value);
  }

  const failures: string[] = [];
  if (values.buildSuccess !== 1) failures.push("BuildSuccess must equal 1");
  if (values.safetyInvariant !== 1)
    failures.push("SafetyInvariant hard gate failed");
  if (values.patchIntegrity !== 1)
    failures.push("PatchIntegrity hard gate failed");
  if (values.unitTestPassRate < 0.95)
    failures.push("UnitTestPassRate is below 0.95");
  return failures;
}

export function computeWeightedScore(values: ScorerValues): number {
  for (const [name, value] of Object.entries(values) as [
    keyof ScorerValues,
    number,
  ][]) {
    assertScore(name, value);
  }

  return Number(
    (
      WEIGHTS.regressionProtection * values.regressionProtection +
      WEIGHTS.unitTestPassRate * values.unitTestPassRate +
      WEIGHTS.patchMinimality * values.patchMinimality +
      WEIGHTS.explanationGroundedness * values.explanationGroundedness +
      WEIGHTS.reproducibility * values.reproducibility
    ).toFixed(6),
  );
}

export function rankCandidates(
  candidates: readonly CandidateEvaluationInput[],
): readonly CandidateRanking[] {
  const seen = new Set<string>();
  const rankings = candidates.map((candidate) => {
    if (seen.has(candidate.candidateId)) {
      throw new Error(`Duplicate candidateId: ${candidate.candidateId}`);
    }
    seen.add(candidate.candidateId);
    const hardGateFailures = evaluateEligibility(candidate.values);
    return {
      candidateId: candidate.candidateId,
      eligible: hardGateFailures.length === 0,
      weightedScore: computeWeightedScore(candidate.values),
      hardGateFailures,
      evidenceDigest: candidate.evidenceDigest,
    } satisfies CandidateRanking;
  });

  return rankings.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    if (left.weightedScore !== right.weightedScore)
      return right.weightedScore - left.weightedScore;
    const evidenceOrder = left.evidenceDigest.localeCompare(right.evidenceDigest);
    if (evidenceOrder !== 0) return evidenceOrder;
    return left.candidateId.localeCompare(right.candidateId);
  });
}

export function selectCandidate(
  candidates: readonly CandidateEvaluationInput[],
  metadata: SelectionMetadata,
): CandidateDecision {
  if (candidates.length === 0) {
    throw new Error("At least one candidate evaluation is required");
  }

  const rankings = rankCandidates(candidates);
  const winner = rankings.find((candidate) => candidate.eligible);

  return {
    id: metadata.id,
    sessionId: metadata.sessionId,
    createdAt: metadata.at,
    updatedAt: metadata.at,
    source: metadata.source,
    sourceVersion: metadata.sourceVersion,
    winnerCandidateId: winner?.candidateId ?? null,
    rankings,
    rationale: winner
      ? `${winner.candidateId} is the highest-scoring candidate that passed every non-negotiable gate.`
      : "No candidate passed every non-negotiable safety gate.",
    selectionPolicyVersion: metadata.selectionPolicyVersion,
  };
}

export { WEIGHTS as SAFETY_TOURNAMENT_WEIGHTS };

