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
import {
  canonicalJson,
  computeEvidenceDigest,
  type OperatingMode,
} from "@safeflash/domain";
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
  registerOfficialTransport,
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
  evaluationEvidence: CandidateEvaluationEvidence;
  evidenceDigest: string;
  expected?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface BraintrustPreparedExperimentCase {
  candidateId: string;
  input: Record<string, unknown>;
  evaluationEvidence: CandidateEvaluationEvidence;
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
  candidateResults: readonly {
    /**
     * Braintrust's immutable Eval root/result ID from the scorer trace
     * (`Trace.getConfiguration().root_span_id`).
     * Braintrust does not expose a distinct provider ID for each named score,
     * so the result row is the provider-owned provenance boundary for scores.
     */
    resultId: string;
    candidateId: string;
    evidenceDigest: string;
    evaluationEvidence: CandidateEvaluationEvidence;
    scores: readonly DeterministicScore[];
    metadata: Record<string, unknown>;
  }[];
}

export interface BraintrustReturnedExperimentResult {
  input: BraintrustPreparedExperimentCase;
  output: BraintrustPreparedExperimentCase["output"];
  expected?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error: unknown;
  scores: Record<string, number | null>;
}

export interface BraintrustResultTraceConfiguration {
  object_type: string;
  object_id: string;
  root_span_id: string;
}

/**
 * Braintrust's scorer callback recomputes the eight deterministic scores from
 * the raw evaluation evidence. The task output is only a comparison oracle;
 * it cannot make an unsafe candidate score as safe by supplying numbers.
 */
export function evaluateBraintrustCandidateScorers(
  input: BraintrustPreparedExperimentCase,
  output: BraintrustPreparedExperimentCase["output"],
): readonly DeterministicScore[] {
  const recomputed = evaluateDeterministicScorers(
    input.evaluationEvidence,
  ).scores;
  if (canonicalJson(recomputed) !== canonicalJson(output.scores)) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust task output does not match scorer-recomputed evidence",
      false,
    );
  }
  return recomputed;
}

type BraintrustCandidateResult =
  BraintrustExperimentEvidence["candidateResults"][number];

const DETERMINISTIC_SCORE_NAMES = [
  "BuildSuccess",
  "UnitTestPassRate",
  "SafetyInvariant",
  "RegressionProtection",
  "PatchIntegrity",
  "PatchMinimality",
  "ExplanationGroundedness",
  "Reproducibility",
] as const satisfies readonly DeterministicScore["name"][];

const HARD_GATE_SCORE_NAMES = new Set<DeterministicScore["name"]>([
  "BuildSuccess",
  "UnitTestPassRate",
  "SafetyInvariant",
  "PatchIntegrity",
]);

/**
 * Normalize only values confirmed by Braintrust's returned Eval rows. The
 * caller-supplied cases are comparison oracles, never the evidence source.
 */
export function normalizeBraintrustReturnedResults(
  cases: readonly BraintrustPreparedExperimentCase[],
  results: readonly BraintrustReturnedExperimentResult[],
  expectedExperimentId: string,
  resultTraces: ReadonlyMap<string, BraintrustResultTraceConfiguration>,
): readonly BraintrustCandidateResult[] {
  assertRemoteIdentifier("experiment ID", expectedExperimentId);
  if (results.length !== cases.length || cases.length === 0) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust did not return exactly one result for every candidate",
      false,
    );
  }
  const expectedByCandidate = new Map<string, BraintrustPreparedExperimentCase>();
  for (const testCase of cases) {
    if (
      testCase.candidateId.trim() === "" ||
      expectedByCandidate.has(testCase.candidateId)
    ) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust candidate IDs must be non-empty and unique",
        false,
      );
    }
    expectedByCandidate.set(testCase.candidateId, testCase);
  }

  const seen = new Set<string>();
  const seenResultIds = new Set<string>();
  return results.map((remote) => {
    const candidateId = remote.input?.candidateId;
    const expected = expectedByCandidate.get(candidateId);
    const expectedMetadata =
      expected === undefined
        ? undefined
        : { ...expected.metadata, candidateId: expected.candidateId };
    if (
      expected === undefined ||
      seen.has(candidateId) ||
      (remote.error !== null && remote.error !== undefined) ||
      canonicalJson(remote.input) !== canonicalJson(expected) ||
      canonicalJson(remote.output) !== canonicalJson(expected.output) ||
      canonicalJson(remote.expected ?? null) !==
        canonicalJson(expected.expected ?? null) ||
      canonicalJson(remote.metadata ?? {}) !== canonicalJson(expectedMetadata)
    ) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust returned an errored, duplicate, or mismatched candidate result",
        false,
      );
    }
    const resultTrace = resultTraces.get(candidateId);
    if (
      resultTrace === undefined ||
      resultTrace.object_type !== "experiment" ||
      resultTrace.object_id !== expectedExperimentId
    ) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust scorer trace is missing or belongs to another Experiment",
        false,
      );
    }
    const resultId = assertRemoteIdentifier(
      "Eval result ID",
      resultTrace.root_span_id,
    );
    if (seenResultIds.has(resultId)) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust returned duplicate Eval result IDs",
        false,
      );
    }
    const expectedScores = new Map<string, number>(
      remote.output.scores.map((score) => [score.name, score.score] as const),
    );
    const returnedNames = Object.keys(remote.scores);
    if (
      expectedScores.size !== remote.output.scores.length ||
      returnedNames.length !== expectedScores.size ||
      returnedNames.some((name) => {
        const value = remote.scores[name];
        return (
          value === null ||
          !Number.isFinite(value) ||
          value !== expectedScores.get(name)
        );
      })
    ) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust returned missing, null, extra, or mismatched scorer results",
        false,
      );
    }
    seen.add(candidateId);
    seenResultIds.add(resultId);
    return {
      resultId,
      candidateId,
      evidenceDigest: remote.output.evidenceDigest,
      evaluationEvidence: structuredClone(remote.input.evaluationEvidence),
      scores: remote.output.scores.map((score) => ({
        ...score,
        metadata: { ...score.metadata },
      })),
      metadata: { ...remote.input.metadata },
    };
  });
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
    cases: readonly BraintrustPreparedExperimentCase[],
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

function assertRemoteIdentifier(label: string, value: unknown): string {
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
  if (label.endsWith("URL")) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDatasetEvidence(
  value: BraintrustDatasetEvidence,
): BraintrustDatasetEvidence {
  if (typeof value !== "object" || value === null) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust returned malformed Dataset evidence",
      false,
    );
  }
  assertRemoteIdentifier("dataset ID", value.datasetId);
  assertRemoteIdentifier("dataset name", value.datasetName);
  assertRemoteIdentifier("dataset version", value.datasetVersion);
  assertRemoteIdentifier("dataset URL", value.datasetUrl);
  if (
    !Number.isSafeInteger(value.totalRecords) ||
    value.totalRecords < 1 ||
    !Array.isArray(value.rowIds) ||
    value.rowIds.length < 1 ||
    value.rowIds.some(
      (rowId) => assertRemoteIdentifier("Dataset row ID", rowId) !== rowId,
    ) ||
    value.totalRecords < value.rowIds.length ||
    new Set(value.rowIds).size !== value.rowIds.length
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust returned malformed Dataset evidence",
      false,
    );
  }
  return value;
}

function validateTraceEvidence(
  value: BraintrustTraceEvidence,
): BraintrustTraceEvidence {
  if (typeof value !== "object" || value === null) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust returned malformed Trace evidence",
      false,
    );
  }
  assertRemoteIdentifier("trace ID", value.traceId);
  assertRemoteIdentifier("span ID", value.spanId);
  assertRemoteIdentifier("trace URL", value.traceUrl);
  return value;
}

function validateExperimentEvidence(
  value: BraintrustExperimentEvidence,
): BraintrustExperimentEvidence {
  if (typeof value !== "object" || value === null) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust returned malformed Experiment evidence",
      false,
    );
  }
  assertRemoteIdentifier("project name", value.projectName);
  assertRemoteIdentifier("experiment name", value.experimentName);
  assertRemoteIdentifier("project ID", value.projectId);
  assertRemoteIdentifier("experiment ID", value.experimentId);
  assertRemoteIdentifier("experiment URL", value.experimentUrl);
  if (
    !Number.isSafeInteger(value.resultCount) ||
    value.resultCount < 1 ||
    !Array.isArray(value.candidateResults)
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust returned malformed Experiment or Score evidence",
      false,
    );
  }
  const resultIds = value.candidateResults.map((result) => {
    if (!isRecord(result)) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust returned malformed Experiment result evidence",
        false,
      );
    }
    return assertRemoteIdentifier("Eval result ID", result.resultId);
  });
  if (
    value.resultCount !== value.candidateResults.length ||
    new Set(resultIds).size !== resultIds.length ||
    new Set(value.candidateResults.map((result) => result.candidateId)).size !==
      value.candidateResults.length ||
    value.candidateResults.some(
      (result) => {
        if (
          !isRecord(result) ||
          !Array.isArray(result.scores) ||
          !isRecord(result.metadata) ||
          typeof result.evidenceDigest !== "string" ||
          result.scores.some(
            (score) =>
              !isRecord(score) ||
              !isRecord(score.metadata),
          )
        ) {
          return true;
        }
        const scoreNames = result.scores.map(
          (score: DeterministicScore) => score.name,
        );
        return (
          assertRemoteIdentifier("candidate ID", result.candidateId) !==
            result.candidateId ||
          !/^[0-9a-f]{64}$/iu.test(result.evidenceDigest) ||
          scoreNames.length !== DETERMINISTIC_SCORE_NAMES.length ||
          new Set(scoreNames).size !== scoreNames.length ||
          DETERMINISTIC_SCORE_NAMES.some(
            (name) => !scoreNames.includes(name),
          ) ||
          result.scores.some(
            (score: DeterministicScore) =>
              !Number.isFinite(score.score) ||
              score.score < 0 ||
              score.score > 1 ||
              score.metadata.deterministic !== true ||
              score.metadata.hardGate !== HARD_GATE_SCORE_NAMES.has(score.name),
          )
        );
      },
    )
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust returned malformed Experiment or Score IDs",
      false,
    );
  }
  return value;
}

function braintrustRetryable(
  error: unknown,
  depth = 0,
  seen = new Set<object>(),
): boolean {
  if (typeof error === "object" && error !== null) {
    if (depth > 3 || seen.has(error)) return false;
    seen.add(error);
    const status =
      "status" in error && typeof error.status === "number"
        ? error.status
        : "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : "response" in error &&
              isRecord(error.response) &&
              typeof error.response.status === "number"
            ? error.response.status
          : undefined;
    if (status !== undefined) {
      if ([408, 429].includes(status) || status >= 500) return true;
      if ([400, 401, 403, 404, 409, 422].includes(status)) return false;
    }
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code.toUpperCase()
        : "";
    if (
      ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(
        code,
      )
    ) {
      return true;
    }
    if ("cause" in error && error.cause !== undefined) {
      return braintrustRetryable(error.cause, depth + 1, seen);
    }
  }
  return error instanceof TypeError ||
    (error instanceof Error && /timeout|timed out/iu.test(error.message));
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
  return registerOfficialTransport({
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
      const resultTraces =
        new Map<string, BraintrustResultTraceConfiguration>();
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
            ({ input, output, trace }) => {
              if (trace === undefined) {
                throw new ProviderResponseError(
                  "braintrust",
                  "Braintrust scorer did not expose an Experiment trace",
                  false,
                );
              }
              const traceConfiguration = trace.getConfiguration();
              const existing = resultTraces.get(input.candidateId);
              if (
                existing !== undefined &&
                canonicalJson(existing) !== canonicalJson(traceConfiguration)
              ) {
                throw new ProviderResponseError(
                  "braintrust",
                  "Braintrust returned conflicting scorer traces for a candidate",
                  false,
                );
              }
              resultTraces.set(input.candidateId, traceConfiguration);
              return evaluateBraintrustCandidateScorers(input, output).map((resultScore) => ({
                name: resultScore.name,
                score: resultScore.score,
                metadata: resultScore.metadata,
              }));
            },
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
        candidateResults: normalizeBraintrustReturnedResults(
          cases,
          result.results,
          experimentId,
          resultTraces,
        ),
      };
    },
  } satisfies BraintrustSdkPort);
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
        this.sdk,
        validateDatasetEvidence(
          await this.sdk.seedDataset(this.config, cases),
        ),
      );
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust dataset seed/verification failed",
        braintrustRetryable(error),
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
        this.sdk,
        validateTraceEvidence(await this.sdk.writeTrace(this.config, event)),
      );
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust trace write/flush failed",
        braintrustRetryable(error),
        { cause: error },
      );
    }
  }

  async runCandidateExperiment(
    experimentName: string,
    cases: readonly BraintrustExperimentCase[],
  ): Promise<ProviderEnvelope<BraintrustExperimentEvidence>> {
    try {
      const seen = new Set<string>();
      const prepared: BraintrustPreparedExperimentCase[] = cases.map(
        (testCase) => {
          if (
            testCase.candidateId.trim() === "" ||
            seen.has(testCase.candidateId) ||
            testCase.evaluationEvidence.candidateId !== testCase.candidateId ||
            !/^[0-9a-f]{64}$/iu.test(testCase.evidenceDigest)
          ) {
            throw new ProviderResponseError(
              "braintrust",
              "Braintrust cases require unique bound candidates and a SHA-256 evidence digest",
              false,
            );
          }
          seen.add(testCase.candidateId);
          const deterministic = evaluateDeterministicScorers(
            testCase.evaluationEvidence,
          );
          return {
            candidateId: testCase.candidateId,
            input: { ...testCase.input },
            evaluationEvidence: structuredClone(testCase.evaluationEvidence),
            output: {
              scores: deterministic.scores,
              evidenceDigest: testCase.evidenceDigest,
            },
            expected:
              testCase.expected === undefined
                ? undefined
                : { ...testCase.expected },
            metadata: { ...testCase.metadata },
          };
        },
      );
      return transportEnvelope(
        "braintrust",
        this.sdk,
        validateExperimentEvidence(
          await this.sdk.runExperiment(
            this.config,
            experimentName,
            prepared,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust Experiment failed",
        braintrustRetryable(error),
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
          evaluationEvidence: smokeEvidence,
          evidenceDigest: computeEvidenceDigest({
            kind: "braintrust-contract-smoke",
            scores: deterministic.scores,
          }),
          expected: { deterministicScores: 8 },
          metadata: { smoke: true },
        },
      ],
    );
    return transportEnvelope(
      "braintrust",
      this.sdk,
      {
        dataset: dataset.data,
        trace: trace.data,
        experiment: experiment.data,
      },
      capturedAt.toISOString(),
    );
  }
}
