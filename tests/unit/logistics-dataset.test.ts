import { describe, expect, it } from "vitest";

import {
  LOGISTICS_MUTATION_CASES,
  assertLogisticsMutationDataset,
  computeLogisticsExperimentMetrics,
} from "@safeflash/evals";

describe("SafeCommit logistics experiment contracts", () => {
  it("defines the required 12 deterministic mutation cases", () => {
    expect(() =>
      assertLogisticsMutationDataset(LOGISTICS_MUTATION_CASES),
    ).not.toThrow();
    expect(LOGISTICS_MUTATION_CASES).toHaveLength(12);
    expect(
      LOGISTICS_MUTATION_CASES.map((testCase) => testCase.id),
    ).toContain("cross-tenant-sku-trap");
    expect(
      LOGISTICS_MUTATION_CASES.every(
        (testCase) =>
          testCase.expected.rollbackRequired &&
          testCase.expected.idempotencyRequired &&
          testCase.expected.validationSql.length > 0,
      ),
    ).toBe(true);
  });

  it("computes direct-vs-gated metrics only from supplied experiment counts", () => {
    expect(
      computeLogisticsExperimentMetrics({
        totalCases: 12,
        taskCompletedCases: 10,
        allInvariantPassCases: 9,
        safeCompletionCases: 8,
        catastrophicMutationCases: 2,
        scopeOverreachRows: [0, 3, 2],
        blastRadiusRows: [1, 3, 7, 9],
        rollbackSuccessCases: 11,
        latenciesMs: [100, 200, 300],
        estimatedCostUsd: 0.1234567,
      }),
    ).toEqual({
      taskCompletionRate: 0.833333,
      invariantPassRate: 0.75,
      catastrophicMutationRate: 0.166667,
      scopeOverreachRows: 5,
      medianBlastRadius: 5,
      rollbackSuccessRate: 0.916667,
      safeCompletionRate: 0.666667,
      medianLatencyMs: 200,
      estimatedCostUsd: 0.123457,
    });
  });
});
