import {
  LOGISTICS_MUTATION_CASES,
  LOGISTICS_MUTATION_DATASET_VERSION,
  assertLogisticsMutationDataset,
  type LogisticsMutationCase,
} from "@safeflash/evals";
import {
  DatabaseEvidenceSchema,
  canonicalJson,
  computeEvidenceDigest,
  type CandidateChangePlan,
  type DatabaseEvidence,
  type OperatingMode,
} from "@safeflash/domain";
import {
  DATABASE_HARD_GATE_NAMES,
  type DatabaseGateEvaluation,
} from "@safeflash/safety-policy";
import {
  Eval,
  initDataset,
  initLogger,
  type ExperimentSummary,
  type Logger,
  type Span,
} from "braintrust";

import type {
  BraintrustConfig,
  BraintrustDatasetEvidence,
  BraintrustTraceEvidence,
} from "./braintrust";
import {
  ProviderResponseError,
  registerOfficialTransport,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";

export interface SafeCommitBraintrustScore {
  name: string;
  score: number;
  metadata: {
    deterministic: true;
    hardGate: boolean;
    evidenceDigest: string;
  };
}

export interface SafeCommitBraintrustExperimentCase {
  candidateId: string;
  plan: CandidateChangePlan;
  evidence: DatabaseEvidence;
  gates: DatabaseGateEvaluation;
  weightedScore: number;
  metadata: Record<string, unknown>;
}

interface PreparedCase extends SafeCommitBraintrustExperimentCase {
  output: {
    evidenceDigest: string;
    scores: readonly SafeCommitBraintrustScore[];
  };
}

export interface SafeCommitBraintrustExperimentEvidence {
  projectName: string;
  experimentName: string;
  projectId: string;
  experimentId: string;
  experimentUrl: string;
  resultCount: number;
  results: readonly {
    resultId: string;
    candidateId: string;
    evidenceDigest: string;
    scores: readonly SafeCommitBraintrustScore[];
  }[];
}

export interface SafeCommitBraintrustPort {
  readonly transport: ProviderTransport;
  seedDataset(
    config: BraintrustConfig,
    cases: readonly LogisticsMutationCase[],
  ): Promise<BraintrustDatasetEvidence>;
  writeTrace(
    config: BraintrustConfig,
    event: {
      name: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
  ): Promise<BraintrustTraceEvidence>;
  runExperiment(
    config: BraintrustConfig,
    experimentName: string,
    cases: readonly PreparedCase[],
  ): Promise<SafeCommitBraintrustExperimentEvidence>;
}

function assertRemote(label: string, value: unknown, url = false): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ProviderResponseError(
      "braintrust",
      `Braintrust did not return a real ${label}`,
      false,
    );
  }
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ProviderResponseError(
        "braintrust",
        `Braintrust did not return a real ${label}`,
        false,
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new ProviderResponseError(
        "braintrust",
        `Braintrust did not return a real ${label}`,
        false,
      );
    }
  }
  return value;
}

export function readSafeCommitBraintrustConfig(
  environment: Environment = process.env,
  mode: OperatingMode = "live",
): BraintrustConfig {
  const values = requireLiveConfiguration(
    "braintrust",
    mode,
    environment,
    ["BRAINTRUST_API_KEY"] as const,
  );
  return {
    mode: "live",
    apiKey: values.BRAINTRUST_API_KEY,
    projectName:
      environment.BRAINTRUST_PROJECT_NAME?.trim() || "SafeCommit",
    datasetName:
      environment.BRAINTRUST_DATASET_NAME?.trim() ||
      "SafeCommit Logistics Mutations",
  };
}

export function scoreSafeCommitDatabaseCase(
  testCase: SafeCommitBraintrustExperimentCase,
): readonly SafeCommitBraintrustScore[] {
  const evidence = DatabaseEvidenceSchema.parse(testCase.evidence);
  if (
    evidence.candidateId !== testCase.candidateId ||
    testCase.plan.candidateId !== testCase.candidateId ||
    !Number.isFinite(testCase.weightedScore) ||
    testCase.weightedScore < 0 ||
    testCase.weightedScore > 1
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "SafeCommit Braintrust case is not bound to one candidate",
      false,
    );
  }
  const evidenceResults = new Map(
    evidence.invariantResults.map((result) => [result.name, result]),
  );
  if (
    testCase.gates.results.length !== DATABASE_HARD_GATE_NAMES.length ||
    canonicalJson(testCase.gates.results) !==
      canonicalJson(evidence.invariantResults) ||
    testCase.gates.eligible !==
      testCase.gates.results.every((result) => result.passed)
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "SafeCommit Braintrust gates do not match database evidence",
      false,
    );
  }
  const hardGateScores = DATABASE_HARD_GATE_NAMES.map((name) => {
    const result = evidenceResults.get(name);
    if (result === undefined) {
      throw new ProviderResponseError(
        "braintrust",
        `SafeCommit evidence omitted hard gate ${name}`,
        false,
      );
    }
    return {
      name,
      score: result.passed ? 1 : 0,
      metadata: {
        deterministic: true as const,
        hardGate: true,
        evidenceDigest: result.evidenceDigest,
      },
    };
  });
  return [
    ...hardGateScores,
    {
      name: "Eligible",
      score: testCase.gates.eligible ? 1 : 0,
      metadata: {
        deterministic: true,
        hardGate: true,
        evidenceDigest: computeEvidenceDigest({
          eligible: testCase.gates.eligible,
          failedGateNames: testCase.gates.failedGateNames,
        }),
      },
    },
    {
      name: "QualityScore",
      score: testCase.weightedScore,
      metadata: {
        deterministic: true,
        hardGate: false,
        evidenceDigest: computeEvidenceDigest({
          candidateId: testCase.candidateId,
          weightedScore: testCase.weightedScore,
        }),
      },
    },
  ];
}

function logger(config: BraintrustConfig): Logger<true> {
  return initLogger({
    apiKey: config.apiKey,
    projectName: config.projectName,
    asyncFlush: true,
    setCurrent: false,
    noExitFlush: true,
  });
}

export function createSafeCommitBraintrustPort(): SafeCommitBraintrustPort {
  return registerOfficialTransport({
    transport: "official-sdk",
    async seedDataset(config, cases) {
      assertLogisticsMutationDataset(cases);
      const dataset = initDataset({
        apiKey: config.apiKey,
        project: config.projectName,
        dataset: config.datasetName,
        description:
          "SafeCommit logistics mutations with explicit intent, effect, scope, rollback, and idempotency oracles.",
        metadata: {
          application: "SafeCommit",
          schemaVersion: LOGISTICS_MUTATION_DATASET_VERSION,
        },
        noExitFlush: true,
      });
      const rowIds = cases.map((testCase) =>
        dataset.insert({
          id: testCase.id,
          input: testCase.input,
          expected: testCase.expected,
          metadata: testCase.metadata,
          tags: [testCase.metadata.category, testCase.metadata.severity],
        }),
      );
      await dataset.flush();
      const [datasetId, version, summary] = await Promise.all([
        dataset.id,
        dataset.version(),
        dataset.summarize({ summarizeData: true }),
      ]);
      if (
        summary.dataSummary === undefined ||
        summary.dataSummary.totalRecords < cases.length
      ) {
        throw new ProviderResponseError(
          "braintrust",
          "Braintrust did not confirm all SafeCommit Dataset rows",
          false,
        );
      }
      return {
        datasetId: assertRemote("dataset ID", datasetId),
        datasetName: assertRemote("dataset name", summary.datasetName),
        datasetVersion: assertRemote("dataset version", version),
        datasetUrl: assertRemote("dataset URL", summary.datasetUrl, true),
        rowIds: rowIds.map((id) => assertRemote("Dataset row ID", id)),
        totalRecords: summary.dataSummary.totalRecords,
      };
    },

    async writeTrace(config, event) {
      const instance = logger(config);
      let captured: Span | undefined;
      await instance.traced(
        async (span) => {
          captured = span;
          span.log({
            input: event.input,
            output: event.output,
            metadata: event.metadata,
          });
        },
        { name: event.name, type: "task" },
      );
      await instance.flush();
      if (captured === undefined) {
        throw new ProviderResponseError(
          "braintrust",
          "Braintrust did not expose the SafeCommit trace span",
          false,
        );
      }
      return {
        traceId: assertRemote("trace ID", captured.rootSpanId),
        spanId: assertRemote("span ID", captured.spanId),
        traceUrl: assertRemote(
          "trace URL",
          await captured.permalink(),
          true,
        ),
      };
    },

    async runExperiment(config, experimentName, cases) {
      if (cases.length === 0) {
        throw new ProviderResponseError(
          "braintrust",
          "SafeCommit Experiment requires at least one candidate",
          false,
        );
      }
      const instance = logger(config);
      const traceByCandidate = new Map<
        string,
        { object_type: string; object_id: string; root_span_id: string }
      >();
      let started:
        | Omit<ExperimentSummary, "scores" | "metrics">
        | undefined;
      const result = await Eval(
        config.projectName,
        {
          experimentName,
          data: cases.map((testCase) => ({
            input: testCase,
            expected: { eligible: testCase.gates.eligible },
            metadata: {
              ...testCase.metadata,
              candidateId: testCase.candidateId,
            },
          })),
          task: (testCase) => testCase.output,
          scores: [
            ({ input, output, trace }) => {
              if (
                trace === undefined ||
                canonicalJson(output) !== canonicalJson(input.output)
              ) {
                throw new ProviderResponseError(
                  "braintrust",
                  "Braintrust SafeCommit scorer lost its candidate binding",
                  false,
                );
              }
              traceByCandidate.set(
                input.candidateId,
                trace.getConfiguration(),
              );
              return scoreSafeCommitDatabaseCase(input).map((score) => ({
                name: score.name,
                score: score.score,
                metadata: score.metadata,
              }));
            },
          ],
          metadata: {
            application: "SafeCommit",
            evaluationType: "database-safety-tournament",
          },
          maxConcurrency: 3,
          state: instance.loggingState,
          flushBeforeScoring: true,
        },
        {
          onStart(metadata) {
            started = metadata;
          },
          returnResults: true,
        },
      );
      await instance.flush();
      const summary = result.summary;
      const experimentId = assertRemote(
        "experiment ID",
        summary.experimentId ?? started?.experimentId,
      );
      if (result.results.length !== cases.length) {
        throw new ProviderResponseError(
          "braintrust",
          "Braintrust returned an incomplete SafeCommit Experiment",
          false,
        );
      }
      const expected = new Map(
        cases.map((testCase) => [testCase.candidateId, testCase]),
      );
      const normalized = result.results.map((remote) => {
        const candidateId = remote.input?.candidateId;
        const original = expected.get(candidateId);
        const trace = traceByCandidate.get(candidateId);
        if (
          original === undefined ||
          remote.error !== null && remote.error !== undefined ||
          trace === undefined ||
          trace.object_type !== "experiment" ||
          trace.object_id !== experimentId
        ) {
          throw new ProviderResponseError(
            "braintrust",
            "Braintrust returned an unbound SafeCommit result",
            false,
          );
        }
        return {
          resultId: assertRemote("Eval result ID", trace.root_span_id),
          candidateId,
          evidenceDigest: original.output.evidenceDigest,
          scores: scoreSafeCommitDatabaseCase(original),
        };
      });
      return {
        projectName: assertRemote("project name", summary.projectName),
        experimentName: assertRemote(
          "experiment name",
          summary.experimentName,
        ),
        projectId: assertRemote(
          "project ID",
          summary.projectId ?? started?.projectId,
        ),
        experimentId,
        experimentUrl: assertRemote(
          "experiment URL",
          summary.experimentUrl ?? started?.experimentUrl,
          true,
        ),
        resultCount: normalized.length,
        results: normalized,
      };
    },
  } satisfies SafeCommitBraintrustPort);
}

function validateDataset(
  evidence: BraintrustDatasetEvidence,
): BraintrustDatasetEvidence {
  assertRemote("dataset ID", evidence.datasetId);
  assertRemote("dataset URL", evidence.datasetUrl, true);
  if (
    evidence.datasetVersion !== LOGISTICS_MUTATION_DATASET_VERSION ||
    evidence.totalRecords < LOGISTICS_MUTATION_CASES.length ||
    evidence.rowIds.length < LOGISTICS_MUTATION_CASES.length ||
    new Set(evidence.rowIds).size !== evidence.rowIds.length
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust Dataset evidence does not cover the SafeCommit corpus",
      false,
    );
  }
  return evidence;
}

function validateTrace(
  evidence: BraintrustTraceEvidence,
): BraintrustTraceEvidence {
  assertRemote("trace ID", evidence.traceId);
  assertRemote("span ID", evidence.spanId);
  assertRemote("trace URL", evidence.traceUrl, true);
  return evidence;
}

function validateExperiment(
  evidence: SafeCommitBraintrustExperimentEvidence,
  expectedCount: number,
): SafeCommitBraintrustExperimentEvidence {
  assertRemote("experiment ID", evidence.experimentId);
  assertRemote("experiment URL", evidence.experimentUrl, true);
  if (
    evidence.resultCount !== expectedCount ||
    evidence.results.length !== expectedCount ||
    new Set(evidence.results.map((result) => result.resultId)).size !==
      expectedCount ||
    new Set(evidence.results.map((result) => result.candidateId)).size !==
      expectedCount
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust Experiment evidence is incomplete or duplicated",
      false,
    );
  }
  return evidence;
}

export class SafeCommitBraintrustAdapter {
  constructor(
    private readonly config: BraintrustConfig,
    private readonly port: SafeCommitBraintrustPort =
      createSafeCommitBraintrustPort(),
  ) {}

  async seedLogisticsDataset(
    cases: readonly LogisticsMutationCase[] = LOGISTICS_MUTATION_CASES,
  ): Promise<ProviderEnvelope<BraintrustDatasetEvidence>> {
    assertLogisticsMutationDataset(cases);
    return transportEnvelope(
      "braintrust",
      this.port,
      validateDataset(await this.port.seedDataset(this.config, cases)),
    );
  }

  async traceTournament(event: {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<ProviderEnvelope<BraintrustTraceEvidence>> {
    return transportEnvelope(
      "braintrust",
      this.port,
      validateTrace(
        await this.port.writeTrace(this.config, {
          name: "safecommit.database-tournament",
          ...event,
        }),
      ),
    );
  }

  async runDatabaseExperiment(
    experimentName: string,
    cases: readonly SafeCommitBraintrustExperimentCase[],
  ): Promise<ProviderEnvelope<SafeCommitBraintrustExperimentEvidence>> {
    const prepared: PreparedCase[] = cases.map((testCase) => ({
      ...structuredClone(testCase),
      output: {
        evidenceDigest: computeEvidenceDigest(testCase.evidence),
        scores: scoreSafeCommitDatabaseCase(testCase),
      },
    }));
    return transportEnvelope(
      "braintrust",
      this.port,
      validateExperiment(
        await this.port.runExperiment(
          this.config,
          experimentName,
          prepared,
        ),
        prepared.length,
      ),
    );
  }
}
