import { randomUUID } from "node:crypto";

import {
  computeEvidenceDigest,
  type CandidateChangePlan,
  type DatabaseEvidence,
} from "@safeflash/domain";
import type { DatabaseGateEvaluation } from "@safeflash/safety-policy";

import {
  loadSafeCommitDatabaseProfile,
  type SafeCommitDatabaseProfile,
} from "./database-profile";
import {
  runLocalMysqlCandidate,
} from "./mysql-runner";

export interface DatabaseQualityScores {
  taskCompletion: number;
  minimality: number;
  explanationGroundedness: number;
  reproducibility: number;
  latency: number;
  cost: number;
}

export interface DatabaseCandidateRanking {
  candidateId: string;
  eligible: boolean;
  weightedScore: number;
  failedGateNames: readonly string[];
  evidenceDigest: string;
}

export interface DatabaseTournamentCandidate {
  plan: CandidateChangePlan;
  evidence: DatabaseEvidence;
  gates: DatabaseGateEvaluation;
  qualityScores: DatabaseQualityScores;
  weightedScore: number;
}

export interface DatabaseTournamentResult {
  sessionId: string;
  profileId: string;
  provenance: "local-test";
  fixtureKind: "OpenBoxes-derived executable fixture";
  sourceCommitSha: string;
  intentContractDigest: string;
  candidates: readonly DatabaseTournamentCandidate[];
  rankings: readonly DatabaseCandidateRanking[];
  winnerCandidateId: string | null;
  tournamentDigest: string;
}

const QUALITY_WEIGHTS = {
  taskCompletion: 0.35,
  minimality: 0.2,
  explanationGroundedness: 0.15,
  reproducibility: 0.15,
  latency: 0.1,
  cost: 0.05,
} as const;

function assertQualityScore(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

export function computeDatabaseWeightedScore(
  values: DatabaseQualityScores,
): number {
  for (const [name, value] of Object.entries(values)) {
    assertQualityScore(name, value);
  }
  return Number(
    Object.entries(QUALITY_WEIGHTS)
      .reduce(
        (sum, [name, weight]) =>
          sum + weight * values[name as keyof DatabaseQualityScores],
        0,
      )
      .toFixed(6),
  );
}

export function rankDatabaseCandidates(
  candidates: readonly DatabaseTournamentCandidate[],
): readonly DatabaseCandidateRanking[] {
  const seen = new Set<string>();
  return candidates
    .map((candidate) => {
      if (seen.has(candidate.plan.candidateId)) {
        throw new Error(`Duplicate database candidate ${candidate.plan.candidateId}`);
      }
      seen.add(candidate.plan.candidateId);
      return {
        candidateId: candidate.plan.candidateId,
        eligible: candidate.gates.eligible,
        weightedScore: candidate.weightedScore,
        failedGateNames: candidate.gates.failedGateNames,
        evidenceDigest: computeEvidenceDigest(candidate.evidence),
      };
    })
    .sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (left.weightedScore !== right.weightedScore) {
        return right.weightedScore - left.weightedScore;
      }
      const digestOrder = left.evidenceDigest.localeCompare(right.evidenceDigest);
      return digestOrder !== 0
        ? digestOrder
        : left.candidateId.localeCompare(right.candidateId);
    });
}

export function computeDatabaseQualityScores(
  plan: CandidateChangePlan,
  evidence: DatabaseEvidence,
  gates: DatabaseGateEvaluation,
): DatabaseQualityScores {
  const changedRows = evidence.rowDelta.length;
  const requestedEffects = plan.expectedEffects.length;
  const observedChangedTables = new Set(
    evidence.rowDelta.map((change) => change.table),
  );
  const expectedChangedTables = new Set(
    plan.expectedEffects.map((effect) => effect.table),
  );
  const matchedTables = [...expectedChangedTables].filter((table) =>
    observedChangedTables.has(table),
  ).length;
  const taskCompletion =
    expectedChangedTables.size === 0 ? 0 : matchedTables / expectedChangedTables.size;
  const minimality = Math.max(0, 1 - Math.max(0, changedRows - requestedEffects) / 24);
  const riskText = plan.risks.join(" ").toLowerCase();
  const failureTerms = gates.failedGateNames.flatMap((gate) => {
    if (gate === "WarehouseScope") return ["warehouse"];
    if (gate === "TenantIsolation") return ["tenant"];
    if (gate === "ProtectedOrderState") return ["shipped", "order"];
    return [gate.toLowerCase()];
  });
  const passedGates = new Set(
    gates.results
      .filter((result) => result.passed)
      .map((result) => result.name),
  );
  const explanationGroundedness =
    failureTerms.length === 0
      ? 0.75
      : failureTerms.every((term) => riskText.includes(term))
        ? 1
        : 0.5;
  return {
    taskCompletion,
    minimality,
    explanationGroundedness,
    reproducibility:
      passedGates.has("Idempotency") &&
      passedGates.has("RollbackVerified")
        ? 1
        : 0,
    latency: 1,
    cost: 1,
  };
}

export async function runLocalDatabaseTournament(options: {
  connectionUri: string;
  sourceCommitSha: string;
  sessionId?: string;
  profile?: SafeCommitDatabaseProfile;
}): Promise<DatabaseTournamentResult> {
  const profile = options.profile ?? (await loadSafeCommitDatabaseProfile());
  const sessionId = options.sessionId ?? `safecommit-local-${randomUUID()}`;
  const candidates: DatabaseTournamentCandidate[] = [];

  for (const [index, plan] of profile.candidates.entries()) {
    const run = await runLocalMysqlCandidate({
      connectionUri: options.connectionUri,
      profile,
      plan,
      intentContract: profile.intentContract,
      sessionId,
      sourceCommitSha: options.sourceCommitSha,
      sandboxId: `local-mysql-transaction-${index + 1}-${randomUUID()}`,
      runId: `local-mysql-run-${index + 1}-${randomUUID()}`,
    });
    const scores = computeDatabaseQualityScores(
      plan,
      run.evidence,
      run.gates,
    );
    candidates.push({
      plan,
      evidence: run.evidence,
      gates: run.gates,
      qualityScores: scores,
      weightedScore: computeDatabaseWeightedScore(scores),
    });
  }

  const sandboxIds = candidates.map(
    (candidate) => candidate.evidence.sandboxId,
  );
  const runIds = candidates.map((candidate) => candidate.evidence.runId);
  const beforeDigests = candidates.map(
    (candidate) => candidate.evidence.beforeStateDigest,
  );
  if (
    new Set(sandboxIds).size !== candidates.length ||
    new Set(runIds).size !== candidates.length ||
    new Set(beforeDigests).size !== 1
  ) {
    throw new Error(
      "Every candidate requires a unique execution identity and the same verified baseline",
    );
  }

  const rankings = rankDatabaseCandidates(candidates);
  const winnerCandidateId =
    rankings.find((candidate) => candidate.eligible)?.candidateId ?? null;
  const tournamentPayload = {
    sessionId,
    profileId: profile.profileId,
    provenance: "local-test" as const,
    fixtureKind: profile.fixtureKind,
    sourceCommitSha: options.sourceCommitSha,
    intentContractDigest: computeEvidenceDigest(profile.intentContract),
    candidates,
    rankings,
    winnerCandidateId,
  };
  return {
    ...tournamentPayload,
    tournamentDigest: computeEvidenceDigest(tournamentPayload),
  };
}

export { QUALITY_WEIGHTS as DATABASE_TOURNAMENT_QUALITY_WEIGHTS };
