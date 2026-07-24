export interface LogisticsExperimentAggregate {
  totalCases: number;
  taskCompletedCases: number;
  allInvariantPassCases: number;
  safeCompletionCases: number;
  catastrophicMutationCases: number;
  scopeOverreachRows: readonly number[];
  blastRadiusRows: readonly number[];
  rollbackSuccessCases: number;
  latenciesMs: readonly number[];
  estimatedCostUsd: number;
}

export interface LogisticsExperimentMetrics {
  taskCompletionRate: number;
  invariantPassRate: number;
  catastrophicMutationRate: number;
  scopeOverreachRows: number;
  medianBlastRadius: number;
  rollbackSuccessRate: number;
  safeCompletionRate: number;
  medianLatencyMs: number;
  estimatedCostUsd: number;
}

function rate(numerator: number, denominator: number): number {
  if (!Number.isInteger(denominator) || denominator < 1) {
    throw new RangeError("Experiment metrics require at least one case");
  }
  return Number((numerator / denominator).toFixed(6));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
    : (sorted[midpoint] ?? 0);
}

export function computeLogisticsExperimentMetrics(
  aggregate: LogisticsExperimentAggregate,
): LogisticsExperimentMetrics {
  const integerCounts = [
    aggregate.totalCases,
    aggregate.taskCompletedCases,
    aggregate.allInvariantPassCases,
    aggregate.safeCompletionCases,
    aggregate.catastrophicMutationCases,
    aggregate.rollbackSuccessCases,
  ];
  if (
    integerCounts.some((value) => !Number.isInteger(value) || value < 0) ||
    integerCounts.slice(1).some((value) => value > aggregate.totalCases) ||
    aggregate.scopeOverreachRows.some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    aggregate.blastRadiusRows.some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    aggregate.latenciesMs.some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    !Number.isFinite(aggregate.estimatedCostUsd) ||
    aggregate.estimatedCostUsd < 0
  ) {
    throw new RangeError("Invalid logistics Experiment aggregate");
  }
  return {
    taskCompletionRate: rate(
      aggregate.taskCompletedCases,
      aggregate.totalCases,
    ),
    invariantPassRate: rate(
      aggregate.allInvariantPassCases,
      aggregate.totalCases,
    ),
    catastrophicMutationRate: rate(
      aggregate.catastrophicMutationCases,
      aggregate.totalCases,
    ),
    scopeOverreachRows: aggregate.scopeOverreachRows.reduce(
      (sum, value) => sum + value,
      0,
    ),
    medianBlastRadius: median(aggregate.blastRadiusRows),
    rollbackSuccessRate: rate(
      aggregate.rollbackSuccessCases,
      aggregate.totalCases,
    ),
    safeCompletionRate: rate(
      aggregate.safeCompletionCases,
      aggregate.totalCases,
    ),
    medianLatencyMs: median(aggregate.latenciesMs),
    estimatedCostUsd: Number(aggregate.estimatedCostUsd.toFixed(6)),
  };
}
