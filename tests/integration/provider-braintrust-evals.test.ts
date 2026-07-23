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
  evaluateBraintrustCandidateScorers,
  normalizeBraintrustReturnedResults,
  type BraintrustConfig,
  type BraintrustPreparedExperimentCase,
  type BraintrustReturnedExperimentResult,
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
  lastExperimentCases: readonly BraintrustPreparedExperimentCase[] = [];
  datasetId = "fake-contract-dataset-id";
  traceId = "fake-contract-trace-id";
  experimentId = "fake-contract-experiment-id";
  resultIdPrefix = "fake-contract-eval-result";
  malformedCandidateResult = false;
  seedFailure: unknown;

  async seedDataset(
    _config: BraintrustConfig,
    cases: readonly unknown[],
  ) {
    if (this.seedFailure !== undefined) throw this.seedFailure;
    this.seededCases = cases.length;
    return {
      datasetId: this.datasetId,
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
      traceId: this.traceId,
      spanId: "fake-contract-span-id",
      traceUrl: "https://www.braintrust.dev/app/fake-contract-trace",
    };
  }

  async runExperiment(
    _config: BraintrustConfig,
    experimentName: string,
    cases: readonly BraintrustPreparedExperimentCase[],
  ) {
    this.experiments += 1;
    this.lastExperimentCases = cases;
    return {
      projectName: CONFIG.projectName,
      experimentName,
      projectId: "fake-contract-project-id",
      experimentId: this.experimentId,
      experimentUrl: "https://www.braintrust.dev/app/fake-contract-experiment",
      resultCount: cases.length,
      candidateResults: this.malformedCandidateResult
        ? [null as never]
        : cases.map((testCase, index) => ({
            resultId: `${this.resultIdPrefix}-${index + 1}`,
            candidateId: testCase.candidateId,
            evidenceDigest: testCase.output.evidenceDigest,
            evaluationEvidence: structuredClone(testCase.evaluationEvidence),
            scores: [...testCase.output.scores],
            metadata: { ...testCase.metadata },
          })),
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

  it("accepts only error-free Braintrust-returned rows with exact scorer values", () => {
    const evaluated = evaluateDeterministicScorers(evidence());
    const testCase: BraintrustPreparedExperimentCase = {
      candidateId: "candidate-score",
      input: { incident: "sensor-disconnect" },
      evaluationEvidence: evidence(),
      output: {
        scores: evaluated.scores,
        evidenceDigest: "a".repeat(64),
      },
      expected: { safe: true },
      metadata: { sessionId: "session-braintrust" },
    };
    const returned: BraintrustReturnedExperimentResult = {
      input: testCase,
      output: testCase.output,
      expected: testCase.expected,
      metadata: {
        ...testCase.metadata,
        candidateId: testCase.candidateId,
      },
      error: null,
      scores: Object.fromEntries(
        evaluated.scores.map((score) => [score.name, score.score]),
      ),
    };
    const resultTraces = new Map([
      [
        testCase.candidateId,
        {
          object_type: "experiment",
          object_id: "experiment-contract-id",
          root_span_id: "eval-result-contract-id",
        },
      ],
    ]);

    expect(
      normalizeBraintrustReturnedResults(
        [testCase],
        [returned],
        "experiment-contract-id",
        resultTraces,
      ),
    ).toEqual([
      {
        resultId: "eval-result-contract-id",
        candidateId: testCase.candidateId,
        evidenceDigest: testCase.output.evidenceDigest,
        evaluationEvidence: testCase.evaluationEvidence,
        scores: testCase.output.scores,
        metadata: testCase.metadata,
      },
    ]);

    expect(() =>
      normalizeBraintrustReturnedResults(
        [testCase],
        [{ ...returned, error: new Error("remote scorer failed") }],
        "experiment-contract-id",
        resultTraces,
      ),
    ).toThrow(/errored/u);

    expect(() =>
      normalizeBraintrustReturnedResults(
        [testCase],
        [
          {
            ...returned,
            scores: { ...returned.scores, SafetyInvariant: 0 },
          },
        ],
        "experiment-contract-id",
        resultTraces,
      ),
    ).toThrow(/scorer results/u);

    expect(() =>
      normalizeBraintrustReturnedResults(
        [testCase],
        [
          returned,
        ],
        "experiment-contract-id",
        new Map([
          [
            testCase.candidateId,
            {
              object_type: "experiment",
              object_id: "different-experiment-id",
              root_span_id: "eval-result-contract-id",
            },
          ],
        ]),
      ),
    ).toThrow(/belongs to another Experiment/u);
  });

  it("recomputes scores server-side instead of accepting caller output", async () => {
    const fake = new FakeBraintrustSdk();
    const adapter = new BraintrustAdapter(CONFIG, fake);
    const unsafeEvidence = evidence({
      safetyTests: {
        passed: 0,
        total: 1,
        criticalFailures: ["actuator remained enabled"],
      },
    });
    await adapter.runCandidateExperiment("server-owned-scorers", [
      {
        candidateId: unsafeEvidence.candidateId,
        input: { incident: "sensor-disconnect" },
        evaluationEvidence: unsafeEvidence,
        evidenceDigest: "b".repeat(64),
        metadata: { sessionId: "session-braintrust" },
        output: {
          scores: evaluateDeterministicScorers(evidence()).scores,
          evidenceDigest: "b".repeat(64),
        },
      } as Parameters<BraintrustAdapter["runCandidateExperiment"]>[1][number] & {
        output: unknown;
      },
    ]);
    expect(
      fake.lastExperimentCases[0]?.output.scores.find(
        (score) => score.name === "SafetyInvariant",
      )?.score,
    ).toBe(0);
  });

  it("runs Braintrust scorers from raw evaluation evidence rather than echoing task output", () => {
    const rawEvidence = evidence({
      safetyTests: {
        passed: 0,
        total: 1,
        criticalFailures: ["actuator remained enabled"],
      },
    });
    const recomputed = evaluateDeterministicScorers(rawEvidence).scores;
    const testCase: BraintrustPreparedExperimentCase = {
      candidateId: rawEvidence.candidateId,
      input: { incident: "sensor-disconnect" },
      evaluationEvidence: rawEvidence,
      output: { scores: recomputed, evidenceDigest: "c".repeat(64) },
      metadata: { sessionId: "session-braintrust" },
    };

    expect(
      evaluateBraintrustCandidateScorers(testCase, testCase.output).find(
        (score) => score.name === "SafetyInvariant",
      )?.score,
    ).toBe(0);

    const forgedOutput = {
      ...testCase.output,
      scores: testCase.output.scores.map((score) =>
        score.name === "SafetyInvariant" ? { ...score, score: 1 } : score,
      ),
    };
    expect(() =>
      evaluateBraintrustCandidateScorers(testCase, forgedOutput),
    ).toThrow(/scorer-recomputed evidence/u);
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
    expect(result.data.experiment.candidateResults[0]?.resultId).toBe(
      "fake-contract-eval-result-1",
    );
    expect(fake.lastExperimentCases[0]?.output.scores).toHaveLength(8);
    expect(
      fake.lastExperimentCases[0]?.output.scores.find(
        (score) => score.name === "SafetyInvariant",
      )?.score,
    ).toBe(1);
  });

  it("rejects malformed Dataset, Trace, Experiment, and Eval result identifiers", async () => {
    const malformedDataset = new FakeBraintrustSdk();
    malformedDataset.datasetId = " dataset-id-with-padding ";
    await expect(
      new BraintrustAdapter(CONFIG, malformedDataset).seedFirmwareSafetyDataset(),
    ).rejects.toMatchObject({
      provider: "braintrust",
      retryable: false,
    });

    const malformedTrace = new FakeBraintrustSdk();
    malformedTrace.traceId = "trace-id\u0000suffix";
    await expect(
      new BraintrustAdapter(CONFIG, malformedTrace).traceStage({
        name: "contract-malformed-trace",
        input: {},
        output: {},
        metadata: {},
      }),
    ).rejects.toMatchObject({
      provider: "braintrust",
      retryable: false,
    });

    const malformedExperiment = new FakeBraintrustSdk();
    malformedExperiment.experimentId = "";
    await expect(
      new BraintrustAdapter(CONFIG, malformedExperiment).runCandidateExperiment(
        "contract-malformed-experiment",
        [
          {
            candidateId: "candidate-score",
            input: {},
            evaluationEvidence: evidence(),
            evidenceDigest: "d".repeat(64),
            metadata: {},
          },
        ],
      ),
    ).rejects.toMatchObject({
      provider: "braintrust",
      retryable: false,
    });

    const malformedResult = new FakeBraintrustSdk();
    malformedResult.resultIdPrefix = " ";
    await expect(
      new BraintrustAdapter(CONFIG, malformedResult).runCandidateExperiment(
        "contract-malformed-result",
        [
          {
            candidateId: "candidate-score",
            input: {},
            evaluationEvidence: evidence(),
            evidenceDigest: "e".repeat(64),
            metadata: {},
          },
        ],
      ),
    ).rejects.toMatchObject({
      provider: "braintrust",
      retryable: false,
    });

    const malformedShape = new FakeBraintrustSdk();
    malformedShape.malformedCandidateResult = true;
    await expect(
      new BraintrustAdapter(CONFIG, malformedShape).runCandidateExperiment(
        "contract-malformed-result-shape",
        [
          {
            candidateId: "candidate-score",
            input: {},
            evaluationEvidence: evidence(),
            evidenceDigest: "f".repeat(64),
            metadata: {},
          },
        ],
      ),
    ).rejects.toMatchObject({
      provider: "braintrust",
      retryable: false,
    });
  });

  it.each([
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 422, retryable: false },
    { status: 429, retryable: true },
  ])(
    "classifies Braintrust HTTP $status failures as retryable=$retryable",
    async ({ status, retryable }) => {
      const fake = new FakeBraintrustSdk();
      fake.seedFailure = Object.assign(new Error(`HTTP ${status}`), { status });
      await expect(
        new BraintrustAdapter(CONFIG, fake).seedFirmwareSafetyDataset(),
      ).rejects.toMatchObject({
        provider: "braintrust",
        retryable,
      });
    },
  );

  it("classifies Braintrust timeouts as retryable", async () => {
    const fake = new FakeBraintrustSdk();
    fake.seedFailure = Object.assign(new Error("request timed out"), {
      code: "ETIMEDOUT",
    });
    await expect(
      new BraintrustAdapter(CONFIG, fake).seedFirmwareSafetyDataset(),
    ).rejects.toMatchObject({
      provider: "braintrust",
      retryable: true,
    });
  });
});
