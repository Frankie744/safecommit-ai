import {
  FIRMWARE_SAFETY_DATASET_NAME,
  FIRMWARE_SAFETY_DATASET_VERSION,
  FIRMWARE_SAFETY_INCIDENTS,
  assertFirmwareSafetyDataset,
  evaluateDeterministicScorers,
  type CandidateEvaluationEvidence,
  type DeterministicScore,
  type FirmwareSafetyIncidentCase,
} from "@safeflash/evals";
import type { OperatingMode } from "@safeflash/domain";
import {
  Eval,
  initDataset,
  initLogger,
  type ExperimentSummary,
  type Logger,
  type Span,
} from "braintrust";

import {
  ProviderResponseError,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";

export interface BraintrustConfig {
  mode: "live";
  apiKey: string;
  projectName: string;
  datasetName: string;
}

export interface BraintrustDatasetEvidence {
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  datasetUrl: string;
  rowIds: readonly string[];
  totalRecords: number;
}

export interface BraintrustTraceEvidence {
  traceId: string;
  spanId: string;
  traceUrl: string;
}

export interface BraintrustExperimentCase {
  candidateId: string;
  input: Record<string, unknown>;
  output: {
    scores: readonly DeterministicScore[];
    evidenceDigest: string;
  };
  expected?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface BraintrustExperimentEvidence {
  projectName: string;
  experimentName: string;
  projectId: string;
  experimentId: string;
  experimentUrl: string;
  resultCount: number;
}

export interface BraintrustSmokeEvidence {
  dataset: BraintrustDatasetEvidence;
  trace: BraintrustTraceEvidence;
  experiment: BraintrustExperimentEvidence;
}

export interface BraintrustSdkPort {
  readonly transport: ProviderTransport;
  seedDataset(
    config: BraintrustConfig,
    cases: readonly FirmwareSafetyIncidentCase[],
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
    cases: readonly BraintrustExperimentCase[],
  ): Promise<BraintrustExperimentEvidence>;
}

export function readBraintrustConfig(
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
    projectName: environment.BRAINTRUST_PROJECT_NAME?.trim() || "SafeFlash",
    datasetName:
      environment.BRAINTRUST_DATASET_NAME?.trim() ||
      FIRMWARE_SAFETY_DATASET_NAME,
  };
}

function assertRemoteIdentifier(label: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new ProviderResponseError(
      "braintrust",
      `Braintrust did not return a real ${label}`,
      false,
    );
  }
  return value;
}

function createLogger(config: BraintrustConfig): Logger<true> {
  return initLogger({
    apiKey: config.apiKey,
    projectName: config.projectName,
    asyncFlush: true,
    setCurrent: false,
    noExitFlush: true,
  });
}

export function createBraintrustSdkPort(): BraintrustSdkPort {
  return {
    transport: "official-sdk",
    async seedDataset(config, cases) {
      assertFirmwareSafetyDataset(cases);
      const dataset = initDataset({
        apiKey: config.apiKey,
        project: config.projectName,
        dataset: config.datasetName,
        description:
          "Deterministic firmware incidents with physical-safety behavior oracles.",
        metadata: {
          schemaVersion: FIRMWARE_SAFETY_DATASET_VERSION,
          owner: "SafeFlash",
        },
        noExitFlush: true,
      });
      const rowIds = cases.map((incident) =>
        dataset.insert({
          id: incident.id,
          input: incident.input,
          expected: incident.expected,
          metadata: {
            ...incident.metadata,
            severity: incident.severity,
            sourceId: incident.id,
          },
          tags: [incident.severity, incident.metadata.category],
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
          "Braintrust dataset summary did not confirm the seeded rows",
          true,
        );
      }
      return {
        datasetId: assertRemoteIdentifier("dataset ID", datasetId),
        datasetName: summary.datasetName,
        datasetVersion: assertRemoteIdentifier("dataset version", version),
        datasetUrl: assertRemoteIdentifier("dataset URL", summary.datasetUrl),
        rowIds,
        totalRecords: summary.dataSummary.totalRecords,
      };
    },

    async writeTrace(config, event) {
      const logger = createLogger(config);
      let capturedSpan: Span | undefined;
      await logger.traced(
        async (span) => {
          capturedSpan = span;
          span.log({
            input: event.input,
            output: event.output,
            metadata: event.metadata,
          });
        },
        { name: event.name, type: "task" },
      );
      await logger.flush();
      if (capturedSpan === undefined) {
        throw new ProviderResponseError(
          "braintrust",
          "Braintrust trace callback did not provide a span",
          false,
        );
      }
      const traceUrl = await capturedSpan.permalink();
      return {
        traceId: assertRemoteIdentifier(
          "trace ID",
          capturedSpan.rootSpanId,
        ),
        spanId: assertRemoteIdentifier("span ID", capturedSpan.spanId),
        traceUrl: assertRemoteIdentifier("trace URL", traceUrl),
      };
    },

    async runExperiment(config, experimentName, cases) {
      if (cases.length === 0) {
        throw new ProviderResponseError(
          "braintrust",
          "At least one candidate is required for a Braintrust Experiment",
          false,
        );
      }
      const logger = createLogger(config);
      let startedSummary:
        | Omit<ExperimentSummary, "scores" | "metrics">
        | undefined;
      const result = await Eval(
        config.projectName,
        {
          experimentName,
          data: cases.map((testCase) => ({
            input: testCase,
            expected: testCase.expected,
            metadata: {
              ...testCase.metadata,
              candidateId: testCase.candidateId,
            },
          })),
          task: (testCase) => testCase.output,
          scores: [
            ({ output }) =>
              output.scores.map((resultScore) => ({
                name: resultScore.name,
                score: resultScore.score,
                metadata: resultScore.metadata,
              })),
          ],
          metadata: {
            application: "SafeFlash",
            evaluationType: "candidate-safety-tournament",
          },
          maxConcurrency: 3,
          state: logger.loggingState,
          flushBeforeScoring: true,
        },
        {
          onStart(metadata) {
            startedSummary = metadata;
          },
          returnResults: true,
        },
      );
      await logger.flush();
      const summary = result.summary;
      const experimentId = assertRemoteIdentifier(
        "experiment ID",
        summary.experimentId ?? startedSummary?.experimentId,
      );
      return {
        projectName: summary.projectName,
        experimentName: summary.experimentName,
        projectId: assertRemoteIdentifier(
          "project ID",
          summary.projectId ?? startedSummary?.projectId,
        ),
        experimentId,
        experimentUrl: assertRemoteIdentifier(
          "experiment URL",
          summary.experimentUrl ?? startedSummary?.experimentUrl,
        ),
        resultCount: result.results.length,
      };
    },
  };
}

export class BraintrustAdapter {
  constructor(
    private readonly config: BraintrustConfig,
    private readonly sdk: BraintrustSdkPort = createBraintrustSdkPort(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async seedFirmwareSafetyDataset(
    cases: readonly FirmwareSafetyIncidentCase[] = FIRMWARE_SAFETY_INCIDENTS,
  ): Promise<ProviderEnvelope<BraintrustDatasetEvidence>> {
    try {
      return transportEnvelope(
        "braintrust",
        this.sdk.transport,
        await this.sdk.seedDataset(this.config, cases),
      );
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust dataset seed/verification failed",
        true,
        { cause: error },
      );
    }
  }

  async traceStage(event: {
    name: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<ProviderEnvelope<BraintrustTraceEvidence>> {
    try {
      return transportEnvelope(
        "braintrust",
        this.sdk.transport,
        await this.sdk.writeTrace(this.config, event),
      );
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust trace write/flush failed",
        true,
        { cause: error },
      );
    }
  }

  async runCandidateExperiment(
    experimentName: string,
    cases: readonly BraintrustExperimentCase[],
  ): Promise<ProviderEnvelope<BraintrustExperimentEvidence>> {
    try {
      return transportEnvelope(
        "braintrust",
        this.sdk.transport,
        await this.sdk.runExperiment(this.config, experimentName, cases),
      );
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust Experiment failed",
        true,
        { cause: error },
      );
    }
  }

  async smoke(): Promise<ProviderEnvelope<BraintrustSmokeEvidence>> {
    const capturedAt = this.clock();
    const dataset = await this.seedFirmwareSafetyDataset();
    const smokeEvidence: CandidateEvaluationEvidence = {
      candidateId: "braintrust-contract-smoke",
      build: { exitCode: 0 },
      unitTests: { passed: 1, total: 1 },
      safetyTests: { passed: 1, total: 1, criticalFailures: [] },
      regressionTests: { passed: 1, total: 1 },
      integrity: { passed: true, violations: [] },
      patch: {
        changedFiles: 1,
        changedLines: 1,
        maxChangedFiles: 4,
        maxChangedLines: 100,
        binaryFiles: 0,
        dependenciesAdded: 0,
      },
      explanation: { supportedClaims: 1, totalClaims: 1 },
      reproduction: {
        attempted: true,
        sameCommit: true,
        sameConfiguration: true,
        artifactHashesMatch: true,
      },
    };
    const deterministic = evaluateDeterministicScorers(smokeEvidence);
    const trace = await this.traceStage({
      name: "safeflash.external-smoke",
      input: { provider: "braintrust", dataset: this.config.datasetName },
      output: { scorerCount: deterministic.scores.length },
      metadata: { smoke: true, datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION },
    });
    const experiment = await this.runCandidateExperiment(
      `safeflash-smoke-${capturedAt.toISOString().replace(/[:.]/gu, "-")}`,
      [
        {
          candidateId: smokeEvidence.candidateId,
          input: { smoke: true },
          output: {
            scores: deterministic.scores,
            evidenceDigest: "contract-smoke-no-candidate-patch",
          },
          expected: { deterministicScores: 8 },
          metadata: { smoke: true },
        },
      ],
    );
    return transportEnvelope(
      "braintrust",
      this.sdk.transport,
      {
        dataset: dataset.data,
        trace: trace.data,
        experiment: experiment.data,
      },
      capturedAt.toISOString(),
    );
  }
}
