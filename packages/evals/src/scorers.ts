import type { ScorerValues } from "@safeflash/domain";

export interface CandidateEvaluationEvidence {
  candidateId: string;
  build: { exitCode: number | null };
  unitTests: { passed: number; total: number };
  safetyTests: {
    passed: number;
    total: number;
    criticalFailures: readonly string[];
  };
  regressionTests: { passed: number; total: number };
  integrity: { passed: boolean; violations: readonly string[] };
  patch: {
    changedFiles: number;
    changedLines: number;
    maxChangedFiles: number;
    maxChangedLines: number;
    binaryFiles: number;
    dependenciesAdded: number;
  };
  explanation: { supportedClaims: number; totalClaims: number };
  reproduction: {
    attempted: boolean;
    sameCommit: boolean;
    sameConfiguration: boolean;
    artifactHashesMatch: boolean;
  };
}

export interface DeterministicScore {
  name:
    | "BuildSuccess"
    | "UnitTestPassRate"
    | "SafetyInvariant"
    | "RegressionProtection"
    | "PatchIntegrity"
    | "PatchMinimality"
    | "ExplanationGroundedness"
    | "Reproducibility";
  score: number;
  metadata: {
    explanation: string;
    hardGate: boolean;
    deterministic: true;
  };
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function checkedRate(name: string, passed: number, total: number): number {
  assertCount(`${name}.passed`, passed);
  assertCount(`${name}.total`, total);
  if (passed > total) throw new RangeError(`${name}.passed cannot exceed total`);
  return total === 0 ? 0 : passed / total;
}

function score(
  name: DeterministicScore["name"],
  value: number,
  explanation: string,
  hardGate = false,
): DeterministicScore {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} produced a score outside [0, 1]`);
  }
  return {
    name,
    score: Number(value.toFixed(6)),
    metadata: { explanation, hardGate, deterministic: true },
  };
}

export function buildSuccess(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const passed = evidence.build.exitCode === 0;
  return score(
    "BuildSuccess",
    passed ? 1 : 0,
    passed
      ? "The trusted build command exited with code 0."
      : `Build did not succeed (exit code ${evidence.build.exitCode ?? "missing"}).`,
    true,
  );
}

export function unitTestPassRate(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const value = checkedRate(
    "unitTests",
    evidence.unitTests.passed,
    evidence.unitTests.total,
  );
  return score(
    "UnitTestPassRate",
    value,
    evidence.unitTests.total === 0
      ? "No unit-test evidence was supplied, so the fail-closed score is 0."
      : `${evidence.unitTests.passed}/${evidence.unitTests.total} trusted unit tests passed.`,
    true,
  );
}

export function safetyInvariant(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const rate = checkedRate(
    "safetyTests",
    evidence.safetyTests.passed,
    evidence.safetyTests.total,
  );
  const passed =
    evidence.safetyTests.total > 0 &&
    rate === 1 &&
    evidence.safetyTests.criticalFailures.length === 0;
  return score(
    "SafetyInvariant",
    passed ? 1 : 0,
    passed
      ? `All ${evidence.safetyTests.total} safety invariants passed.`
      : `Safety gate failed: ${evidence.safetyTests.criticalFailures.join(", ") || "missing or failed safety evidence"}.`,
    true,
  );
}

export function regressionProtection(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const value = checkedRate(
    "regressionTests",
    evidence.regressionTests.passed,
    evidence.regressionTests.total,
  );
  return score(
    "RegressionProtection",
    value,
    evidence.regressionTests.total === 0
      ? "No regression-test evidence was supplied, so the fail-closed score is 0."
      : `${evidence.regressionTests.passed}/${evidence.regressionTests.total} regression checks passed.`,
  );
}

export function patchIntegrity(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const passed =
    evidence.integrity.passed && evidence.integrity.violations.length === 0;
  return score(
    "PatchIntegrity",
    passed ? 1 : 0,
    passed
      ? "The patch passed protected-path, threshold, test, CI, and binary integrity checks."
      : `Patch integrity violations: ${evidence.integrity.violations.join(", ") || "integrity check did not pass"}.`,
    true,
  );
}

export function patchMinimality(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const patch = evidence.patch;
  for (const [name, value] of Object.entries(patch)) {
    assertCount(`patch.${name}`, value);
  }
  if (patch.maxChangedFiles === 0 || patch.maxChangedLines === 0) {
    return score(
      "PatchMinimality",
      0,
      "Patch limits are missing, so minimality cannot be established.",
    );
  }
  if (
    patch.changedFiles === 0 ||
    patch.changedLines === 0 ||
    patch.changedFiles > patch.maxChangedFiles ||
    patch.changedLines > patch.maxChangedLines ||
    patch.binaryFiles > 0
  ) {
    return score(
      "PatchMinimality",
      0,
      "The patch is empty, exceeds its declared bounds, or contains binary files.",
    );
  }
  const footprint =
    0.4 * (patch.changedFiles / patch.maxChangedFiles) +
    0.6 * (patch.changedLines / patch.maxChangedLines);
  const dependencyPenalty = Math.min(0.5, patch.dependenciesAdded * 0.25);
  const value = Math.max(0, 1 - footprint - dependencyPenalty);
  return score(
    "PatchMinimality",
    value,
    `${patch.changedFiles} file(s), ${patch.changedLines} changed line(s), and ${patch.dependenciesAdded} new dependency/dependencies were measured against policy limits.`,
  );
}

export function explanationGroundedness(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const value = checkedRate(
    "explanation",
    evidence.explanation.supportedClaims,
    evidence.explanation.totalClaims,
  );
  return score(
    "ExplanationGroundedness",
    value,
    evidence.explanation.totalClaims === 0
      ? "No explanation claims were supplied, so groundedness is 0."
      : `${evidence.explanation.supportedClaims}/${evidence.explanation.totalClaims} claims are linked to diff or test evidence.`,
  );
}

export function reproducibility(
  evidence: CandidateEvaluationEvidence,
): DeterministicScore {
  const reproduction = evidence.reproduction;
  const passed =
    reproduction.attempted &&
    reproduction.sameCommit &&
    reproduction.sameConfiguration &&
    reproduction.artifactHashesMatch;
  return score(
    "Reproducibility",
    passed ? 1 : 0,
    passed
      ? "A repeat run used the same commit and configuration and produced matching artifact hashes."
      : "A matching repeat run was not demonstrated.",
  );
}

export function evaluateDeterministicScorers(
  evidence: CandidateEvaluationEvidence,
): {
  scores: readonly DeterministicScore[];
  values: ScorerValues;
  explanations: Record<keyof ScorerValues, string>;
} {
  const scores = [
    buildSuccess(evidence),
    unitTestPassRate(evidence),
    safetyInvariant(evidence),
    regressionProtection(evidence),
    patchIntegrity(evidence),
    patchMinimality(evidence),
    explanationGroundedness(evidence),
    reproducibility(evidence),
  ] as const;
  const byName = Object.fromEntries(scores.map((result) => [result.name, result]));
  return {
    scores,
    values: {
      buildSuccess: byName.BuildSuccess!.score,
      unitTestPassRate: byName.UnitTestPassRate!.score,
      safetyInvariant: byName.SafetyInvariant!.score,
      regressionProtection: byName.RegressionProtection!.score,
      patchIntegrity: byName.PatchIntegrity!.score,
      patchMinimality: byName.PatchMinimality!.score,
      explanationGroundedness: byName.ExplanationGroundedness!.score,
      reproducibility: byName.Reproducibility!.score,
    },
    explanations: {
      buildSuccess: byName.BuildSuccess!.metadata.explanation,
      unitTestPassRate: byName.UnitTestPassRate!.metadata.explanation,
      safetyInvariant: byName.SafetyInvariant!.metadata.explanation,
      regressionProtection:
        byName.RegressionProtection!.metadata.explanation,
      patchIntegrity: byName.PatchIntegrity!.metadata.explanation,
      patchMinimality: byName.PatchMinimality!.metadata.explanation,
      explanationGroundedness:
        byName.ExplanationGroundedness!.metadata.explanation,
      reproducibility: byName.Reproducibility!.metadata.explanation,
    },
  };
}
