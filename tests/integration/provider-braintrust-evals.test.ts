import { describe, expect, it } from "vitest";

import {
  FIRMWARE_SAFETY_DATASET_NAME,
  FIRMWARE_SAFETY_INCIDENTS,
  assertFirmwareSafetyDataset,
  evaluateDeterministicScorers,
  type CandidateEvaluationEvidence,
} from "@safeflash/evals";
import {
  BraintrustAdapter,
  type BraintrustConfig,
  type BraintrustSdkPort,
} from "@safeflash/integrations";

const CONFIG: BraintrustConfig = {
  mode: "live",
  apiKey: "test-only-not-a-live-key",
  projectName: "SafeFlash Contract Tests",
  datasetName: FIRMWARE_SAFETY_DATASET_NAME,
};

function evidence(
  overrides: Partial<CandidateEvaluationEvidence> = {},
): CandidateEvaluationEvidence {
  return {
    candidateId: "candidate-score",
    build: { exitCode: 0 },
    unitTests: { passed: 19, total: 20 },
    safetyTests: { passed: 4, total: 4, criticalFailures: [] },
    regressionTests: { passed: 9, total: 10 },
    integrity: { passed: true, violations: [] },
    patch: {
      changedFiles: 1,
      changedLines: 20,
      maxChangedFiles: 4,
      maxChangedLines: 100,
      binaryFiles: 0,
      dependenciesAdded: 0,
    },
    explanation: { supportedClaims: 3, totalClaims: 4 },
    reproduction: {
      attempted: true,
      sameCommit: true,
      sameConfiguration: true,
      artifactHashesMatch: true,
    },
    ...overrides,
  };
}

class FakeBraintrustSdk implements BraintrustSdkPort {
  readonly transport = "local-test" as const;
  seededCases = 0;
  traces = 0;
  experiments = 0;

  async seedDataset(
    _config: BraintrustConfig,
    cases: readonly unknown[],
  ) {
    this.seededCases = cases.length;
    return {
      datasetId: "fake-contract-dataset-id",
      datasetName: FIRMWARE_SAFETY_DATASET_NAME,
      datasetVersion: "fake-contract-version",
      datasetUrl: "https://www.braintrust.dev/app/fake-contract-dataset",
      rowIds: FIRMWARE_SAFETY_INCIDENTS.map((incident) => incident.id),
      totalRecords: cases.length,
    };
  }

  async writeTrace() {
    this.traces += 1;
    return {
      traceId: "fake-contract-trace-id",
      spanId: "fake-contract-span-id",
      traceUrl: "https://www.braintrust.dev/app/fake-contract-trace",
    };
  }

  async runExperiment(
    _config: BraintrustConfig,
    experimentName: string,
    cases: readonly unknown[],
  ) {
    this.experiments += 1;
    return {
      projectName: CONFIG.projectName,
      experimentName,
      projectId: "fake-contract-project-id",
      experimentId: "fake-contract-experiment-id",
      experimentUrl: "https://www.braintrust.dev/app/fake-contract-experiment",
      resultCount: cases.length,
    };
  }
}

describe("Braintrust dataset and deterministic scorers", () => {
  it("defines ten complete, stable Firmware Safety Incidents", () => {
    expect(() => assertFirmwareSafetyDataset()).not.toThrow();
    expect(FIRMWARE_SAFETY_INCIDENTS).toHaveLength(10);
    expect(new Set(FIRMWARE_SAFETY_INCIDENTS.map((item) => item.id)).size).toBe(
      10,
    );
    for (const incident of FIRMWARE_SAFETY_INCIDENTS) {
      expect(incident.severity).toBe(incident.metadata.severity);
      expect(incident.expected.safetyBehavior.length).toBeGreaterThan(0);
      expect(incident.metadata.deterministicOracle.length).toBeGreaterThan(0);
    }
  });

  it("returns all eight deterministic scores with hard gates fail-closed", () => {
    const passing = evaluateDeterministicScorers(evidence());
    expect(passing.scores.map((item) => item.name)).toEqual([
      "BuildSuccess",
      "UnitTestPassRate",
      "SafetyInvariant",
      "RegressionProtection",
      "PatchIntegrity",
      "PatchMinimality",
      "ExplanationGroundedness",
      "Reproducibility",
    ]);
    expect(passing.values).toMatchObject({
      buildSuccess: 1,
      unitTestPassRate: 0.95,
      safetyInvariant: 1,
      patchIntegrity: 1,
      reproducibility: 1,
    });
    expect(
      passing.scores.find((item) => item.name === "SafetyInvariant")?.metadata
        .hardGate,
    ).toBe(true);

    const missingEvidence = evaluateDeterministicScorers(
      evidence({
        unitTests: { passed: 0, total: 0 },
        safetyTests: { passed: 0, total: 0, criticalFailures: [] },
        integrity: { passed: false, violations: [] },
      }),
    );
    expect(missingEvidence.values.unitTestPassRate).toBe(0);
    expect(missingEvidence.values.safetyInvariant).toBe(0);
    expect(missingEvidence.values.patchIntegrity).toBe(0);
  });

  it("uses the final dataset, trace, and Experiment ports in a smoke run", async () => {
    const fake = new FakeBraintrustSdk();
    const adapter = new BraintrustAdapter(
      CONFIG,
      fake,
      () => new Date("2026-07-22T12:00:00.000Z"),
    );
    const result = await adapter.smoke();
    expect(result.provenance.kind).toBe("local-test");
    expect(fake.seededCases).toBe(10);
    expect(fake.traces).toBe(1);
    expect(fake.experiments).toBe(1);
    expect(result.data.dataset.totalRecords).toBe(10);
    expect(result.data.experiment.resultCount).toBe(1);
  });
});
