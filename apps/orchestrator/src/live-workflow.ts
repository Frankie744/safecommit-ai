import {
  createHumanApproval,
  createRecordedLiveArtifact,
  createValidationSession,
  selectCandidate,
  sha256,
  transitionValidationSession,
  type ApprovalDecision,
  type CandidateDecision,
  type CandidatePatch,
  type CandidateStrategy,
  type DaytonaAttemptRecord,
  type HumanApproval,
  type PullRequestRecord,
  type RecordedLiveArtifact,
  type RecordedLiveCaptureInput,
  type ReviewFinding,
  type SafetyPolicy,
  type ScorerValues,
  type ValidationSession,
  type ValidationState,
} from "@safeflash/domain";
import {
  FIRMWARE_SAFETY_INCIDENTS,
  evaluateDeterministicScorers,
} from "@safeflash/evals";
import {
  BraintrustAdapter,
  CodeRabbitAdapter,
  DaytonaAdapter,
  DaytonaAttemptError,
  FireworksAdapter,
  GitHubAdapter,
  ProviderResponseError,
  buildLiveCandidateEvaluationEvidence,
  computeLiveCandidateEvidenceDigest,
  createLiveFullRevalidationReceipt,
  createLiveIndependentReviewReceipt,
  mintPullRequestPublishAuthorization,
  isOfficialLiveEnvelope,
  readBraintrustConfig,
  readCodeRabbitConfig,
  readDaytonaConfig,
  readFireworksConfig,
  readGitHubConfig,
  readPublishAuthorizationService,
  type BraintrustDatasetEvidence,
  type BraintrustExperimentEvidence,
  type BraintrustTraceEvidence,
  type CodeRabbitInspectionEvidence,
  type DaytonaValidationEvidence,
  type FireworksCandidateRequest,
  type FireworksCandidateEvidence,
  type FireworksEvaluationProfile,
  type FireworksSourceContext,
  type ProviderEnvelope,
  type GitHubConfig,
  type PreparedCandidatePublication as GitHubPreparedCandidatePublication,
  type PublishAuthorizationAuthority,
} from "@safeflash/integrations";

const WORKFLOW_SOURCE_VERSION = "safeflash-live-workflow-v1";
const SELECTION_POLICY_VERSION = "safety-tournament-v1";
const MAX_TOURNAMENT_PROFILE_ATTEMPTS = 4;
const MAX_REPAIR_ATTEMPTS = 3;
const STRATEGIES: readonly CandidateStrategy[] = [
  "fail-closed",
  "retry-and-latch",
  "range-validation",
] as const;
const EVALUATION_PROFILES: readonly FireworksEvaluationProfile[] = [
  "safety-contender",
  "safety-contender",
  "safety-negative-control",
] as const;

export interface RegisteredLiveIncident {
  id: string;
  title: string;
  summary: string;
  evidence: readonly string[];
  temperatureC: number;
  sensorFault: boolean;
  chargingEnabled: boolean;
}

export interface RegisteredLivePolicy {
  id: string;
  policyVersion: string;
  invariants: readonly string[];
  allowedPatchPaths: readonly string[];
  protectedPaths: readonly string[];
  maxChangedFiles: number;
  maxChangedLines: number;
  requestedTests: readonly string[];
}

export interface LiveWorkflowRegistry {
  incident: RegisteredLiveIncident;
  policy: RegisteredLivePolicy;
}

/**
 * P0 registry is server-owned and immutable. Neither the browser nor a request
 * body can relax paths, limits, invariants, or trusted test identifiers.
 */
export const P0_LIVE_WORKFLOW_REGISTRY: LiveWorkflowRegistry = Object.freeze({
  incident: Object.freeze({
    id: "battery-sensor-disconnect",
    title: "Battery temperature sensor disconnect leaves charging enabled",
    summary:
      "A disconnected temperature sensor reports 0 C; firmware must treat the sensor fault as invalid evidence and de-energize the charge FET.",
    evidence: Object.freeze([
      "The disconnected temperature sensor sets sensor_fault and reports temperature_c = 0 C.",
      "The pre-fix controller treats 0 C as a valid cold reading and can keep charging enabled.",
      "The trusted safety suite requires immediate de-energization and a latched fault.",
    ]),
    temperatureC: 0,
    sensorFault: true,
    chargingEnabled: true,
  }),
  policy: Object.freeze({
    id: "battery-controller-p0-policy",
    policyVersion: "battery-controller-p0-v1",
    invariants: Object.freeze([
      "sensor_fault disables charging in the same controller update cycle.",
      "temperature_c below the valid minimum or above the valid maximum enters the safe state.",
      "BATTERY_STALE_SAMPLE_LIMIT consecutive controller cycles without a fresh sample disable charging and latch the fault.",
      "The sensor fault remains latched until the explicit trusted reset action.",
      "Normal fresh temperatures inside the valid range, including the documented boundaries, retain their existing charging behavior.",
      "Existing tests, temperature thresholds, stale-sample limit, build scripts, and validation tooling are immutable.",
    ]),
    allowedPatchPaths: Object.freeze([
      "fixtures/battery-controller/src/**",
    ]),
    protectedPaths: Object.freeze([
      "fixtures/battery-controller/tests/**",
      "fixtures/battery-controller/include/**",
      "fixtures/battery-controller/CMakeLists.txt",
      "packages/safety-policy/**",
    ]),
    maxChangedFiles: 1,
    maxChangedLines: 120,
    requestedTests: Object.freeze([
      "trusted-cmake-configure",
      "trusted-build",
      "trusted-unit-tests",
      "trusted-safety-tests",
      "trusted-patch-integrity",
    ]),
  }),
});

export interface PreparedCandidatePublication {
  headBranch: string;
  baseCommitSha: string;
  commitSha: string;
  treeSha: string;
  /** Adapter-private, frozen publication plan; never accepted from HTTP input. */
  publication: ProviderEnvelope<GitHubPreparedCandidatePublication>;
}

export interface CandidatePublicationPort {
  prepareCandidatePublication(input: {
    sessionId: string;
    baseCommitSha: string;
    candidate: CandidatePatch;
    expectedTreeSha: string;
    targetBaseCommitSha: string;
    committedAt: string;
  }): Promise<PreparedCandidatePublication>;
  publishApprovedCandidate(input: {
    session: ValidationSession;
    candidate: CandidatePatch;
    prepared: PreparedCandidatePublication;
    incident: RegisteredLiveIncident;
    tests: readonly string[];
  }): Promise<ProviderEnvelope<PullRequestRecord>>;
}

export interface LiveWorkflowDependencies {
  fireworks: Pick<FireworksAdapter, "generateTournament" | "generateCandidate">;
  daytona: Pick<DaytonaAdapter, "validateCandidate">;
  braintrust: Pick<
    BraintrustAdapter,
    "seedFirmwareSafetyDataset" | "runCandidateExperiment" | "traceStage"
  >;
  publication: CandidatePublicationPort;
  coderabbit: Pick<CodeRabbitAdapter, "waitForReview"> &
    Partial<Pick<CodeRabbitAdapter, "inspectReview">>;
  repository: {
    owner: string;
    name: string;
    baseBranch: string;
    repoUrl: string;
    /** Read-only official GitHub readiness resolves this immutable base. */
    resolveBaseCommit(): Promise<string>;
    readSourceContext(
      sessionId: string,
      commitSha: string,
    ): Promise<ProviderEnvelope<FireworksSourceContext>>;
  };
  now?: () => Date;
}

interface ValidationRoundEvidence {
  dataset: ProviderEnvelope<BraintrustDatasetEvidence>;
  experiment: ProviderEnvelope<BraintrustExperimentEvidence>;
  trace: ProviderEnvelope<BraintrustTraceEvidence>;
}

interface LiveWorkflowRecord {
  session: ValidationSession;
  candidates: Map<string, CandidatePatch>;
  daytonaByCandidate: Map<
    string,
    ProviderEnvelope<DaytonaValidationEvidence>
  >;
  decision: CandidateDecision;
  braintrust: ValidationRoundEvidence;
  selectedCandidate: CandidatePatch;
  prepared: PreparedCandidatePublication;
  generationByCandidate: Map<
    string,
    {
      request: FireworksCandidateRequest;
      evidence: ProviderEnvelope<FireworksCandidateEvidence>;
    }
  >;
  evaluationByCandidate: Map<
    string,
    BraintrustExperimentEvidence["candidateResults"][number]
  >;
  evaluationProvenanceByCandidate: Map<
    string,
    {
      resultId: string;
      experimentId: string;
      experimentName: string;
      experimentUrl: string;
      traceId: string;
      traceUrl: string;
      validationRound: number;
      capturedAt: string;
    }
  >;
  rankingByCandidate: Map<string, CandidateDecision["rankings"][number]>;
  lastInspection?: ProviderEnvelope<CodeRabbitInspectionEvidence>;
  pullRequestEvidence?: ProviderEnvelope<PullRequestRecord>;
  stageTraces: ProviderEnvelope<BraintrustTraceEvidence>[];
  repairCheckpoint?: {
    blockedPullRequest: PullRequestRecord;
    repairIncident: RegisteredLiveIncident;
    sourceContext?: ProviderEnvelope<FireworksSourceContext>;
    candidate?: CandidatePatch;
    generation?: {
      request: FireworksCandidateRequest;
      evidence: ProviderEnvelope<FireworksCandidateEvidence>;
    };
    daytona?: ProviderEnvelope<DaytonaValidationEvidence>;
    braintrust?: ValidationRoundEvidence;
    prepared?: PreparedCandidatePublication;
    attempt: number;
  };
}

export interface LiveWorkflowSnapshot {
  session: ValidationSession;
  decision: CandidateDecision;
  selectedCandidate: CandidatePatch;
  candidates: readonly LiveCandidateEvidenceSummary[];
  providerEvidence: {
    braintrustDatasetId: string;
    braintrustDatasetUrl: string;
    braintrustExperimentId: string;
    braintrustExperimentUrl: string;
    braintrustTraceId: string;
    braintrustTraceUrl: string;
    stageTraceIds: readonly string[];
    stageTraceUrls: readonly string[];
    daytonaSandboxId: string;
    daytonaRunId: string;
    preparedCommitSha: string;
    preparedTreeSha: string;
    headBranch: string;
  };
}

export interface LiveCandidateEvidenceSummary {
  candidate: CandidatePatch;
  evaluationProfile: FireworksEvaluationProfile;
  generation: {
    provider: "fireworks";
    model: string;
    requestId: string;
    latencyMs: number;
    totalTokens: number | null;
    sourceContextDigest: string;
    requestDigest: string;
    capturedAt: string;
  };
  validation: {
    provider: "daytona";
    sandboxId: string;
    runId: string;
    baseCommitSha: string;
    patchDigest: string;
    policyDigest: string;
    passed: boolean;
    validatedTreeSha: string | null;
    build: { exitCode: number | null };
    unitTests: { passed: number; total: number };
    safetyTests: {
      passed: number;
      total: number;
      criticalFailures: readonly string[];
    };
    regressionTests: { passed: number; total: number };
    integrity: { passed: boolean; violations: readonly string[] };
    commands: readonly {
      id: string;
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
      stdoutHash: string | null;
      artifactHash: string | null;
    }[];
    capturedAt: string;
  };
  scoring: {
    provider: "braintrust";
    resultId: string;
    eligible: boolean;
    weightedScore: number;
    hardGateFailures: readonly string[];
    evidenceDigest: string;
    values: ScorerValues;
    experimentId: string;
    experimentName: string;
    experimentUrl: string;
    traceId: string;
    traceUrl: string;
    validationRound: number;
    capturedAt: string;
  };
}

export interface LiveHumanDecisionInput {
  sessionId: string;
  approverId: string;
  approverDisplayName?: string;
  decision: ApprovalDecision;
  reason?: string;
  expected: {
    candidateId: string;
    patchDigest: string;
    evidenceDigest: string;
    commitSha: string;
    policyVersion: string;
  };
}

export interface LiveWorkflowProgressEvent {
  sequence: number;
  sessionId: string;
  state: ValidationState;
  stage:
    | "workflow-started"
    | "repository-ingested"
    | "incident-analyzed"
    | "candidates-generated"
    | "candidate-validated"
    | "sandboxes-provisioned"
    | "builds-finished"
    | "tests-finished"
    | "scoring-finished"
    | "candidate-selected"
    | "human-decision-recorded"
    | "publication-requested"
    | "pull-request-published"
    | "independent-review-finished"
    | "repair-started"
    | "repair-candidate-generated"
    | "repair-revalidation-finished"
    | "ready-to-merge"
    | "readiness-refreshed"
    | "readiness-invalidated";
  at: string;
  provider?: "github" | "fireworks" | "daytona" | "braintrust" | "coderabbit";
  candidateId?: string;
  evidenceId?: string;
  candidates?: readonly {
    candidateId: string;
    strategy: CandidateStrategy;
    evaluationProfile: FireworksEvaluationProfile;
    hypothesis: string;
    unifiedDiff: string;
    patchDigest: string;
    generationCapturedAt: string;
  }[];
  validation?: {
    sandboxId: string;
    runId: string;
    passed: boolean;
    validatedTreeSha: string | null;
    capturedAt: string;
    build: { exitCode: number | null };
    unitTests: { passed: number; total: number };
    safetyTests: {
      passed: number;
      total: number;
      criticalFailures: readonly string[];
    };
    integrity: { passed: boolean; violations: readonly string[] };
  };
  message: string;
}

function safeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(sessionId)) {
    throw new Error("Live workflow sessionId is not safe");
  }
  return sessionId;
}

/** Shared by server routes and the live CLI before constructing any path. */
export function requireSafeLiveSessionId(sessionId: string): string {
  return safeSessionId(sessionId);
}

function requireGitId(label: string, value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) {
    throw new Error(`${label} is not a full immutable Git object ID`);
  }
  return value;
}

function liveCapturedAt<T>(envelope: ProviderEnvelope<T>): string {
  if (
    !("capturedAt" in envelope.provenance) ||
    typeof envelope.provenance.capturedAt !== "string"
  ) {
    throw new Error("Official live provider evidence is missing capturedAt");
  }
  return envelope.provenance.capturedAt;
}

function policyForReceipt(policy: RegisteredLivePolicy) {
  return {
    id: policy.id,
    policyVersion: policy.policyVersion,
    allowedPatchPaths: policy.allowedPatchPaths,
    maxChangedFiles: policy.maxChangedFiles,
    maxChangedLines: policy.maxChangedLines,
  } satisfies Pick<
    SafetyPolicy,
    | "id"
    | "policyVersion"
    | "allowedPatchPaths"
    | "maxChangedFiles"
    | "maxChangedLines"
  >;
}

function scoresFromExperiment(
  experiment: BraintrustExperimentEvidence,
): readonly {
  candidateId: string;
  values: ScorerValues;
  evidenceDigest: string;
}[] {
  return experiment.candidateResults.map((result) => ({
    candidateId: result.candidateId,
    values: evaluateDeterministicScorers(result.evaluationEvidence).values,
    evidenceDigest: result.evidenceDigest,
  }));
}

export class LiveSafetyWorkflow {
  private readonly records = new Map<string, LiveWorkflowRecord>();
  /**
   * Survives recoverable operation failure even before a complete workflow
   * record exists. The same append-only history is copied into every session
   * snapshot so resume/hydration cannot make a prior attempt look fresh.
   */
  private readonly sandboxAttemptHistoryBySession = new Map<
    string,
    DaytonaAttemptRecord[]
  >();
  private readonly daytonaRunSequenceBySession = new Map<string, number>();
  private readonly startReservations = new Set<string>();
  private readonly activeOperations = new Set<string>();
  private readonly progressBySession = new Map<
    string,
    LiveWorkflowProgressEvent[]
  >();
  private readonly progressListeners = new Map<
    string,
    Set<(event: LiveWorkflowProgressEvent) => void>
  >();
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: LiveWorkflowDependencies,
    private readonly registry: LiveWorkflowRegistry = P0_LIVE_WORKFLOW_REGISTRY,
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  subscribeProgress(
    sessionIdValue: string,
    listener: (event: LiveWorkflowProgressEvent) => void,
  ): () => void {
    const sessionId = safeSessionId(sessionIdValue);
    const listeners = this.progressListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.progressListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.progressListeners.delete(sessionId);
    };
  }

  getProgress(sessionIdValue: string): readonly LiveWorkflowProgressEvent[] {
    const sessionId = safeSessionId(sessionIdValue);
    return structuredClone(this.progressBySession.get(sessionId) ?? []);
  }

  getSandboxAttemptHistory(
    sessionIdValue: string,
  ): readonly DaytonaAttemptRecord[] {
    const sessionId = safeSessionId(sessionIdValue);
    return structuredClone(
      this.sandboxAttemptHistoryBySession.get(sessionId) ??
        this.records.get(sessionId)?.session.sandboxAttemptHistory ??
        [],
    );
  }

  private emitProgress(
    event: Omit<LiveWorkflowProgressEvent, "sequence" | "at">,
  ): void {
    const history = this.progressBySession.get(event.sessionId) ?? [];
    const progress: LiveWorkflowProgressEvent = Object.freeze({
      ...event,
      sequence: history.length + 1,
      at: this.now().toISOString(),
    });
    history.push(progress);
    this.progressBySession.set(event.sessionId, history);
    for (const listener of this.progressListeners.get(event.sessionId) ?? []) {
      try {
        listener(structuredClone(progress));
      } catch {
        // A UI observer cannot change or interrupt the authoritative workflow.
      }
    }
  }

  private reserveDaytonaAttempt(input: {
    session: ValidationSession;
    envelope: ProviderEnvelope<DaytonaValidationEvidence>;
    purpose: DaytonaAttemptRecord["purpose"];
    expectedCandidateId: string;
    expectedRunId: string;
  }): { session: ValidationSession; accepted: boolean } {
    const data = input.envelope.data;
    if (
      input.envelope.provider !== "daytona" ||
      data.sessionId !== input.session.sessionId ||
      data.candidateId !== input.expectedCandidateId ||
      data.runId !== input.expectedRunId ||
      data.retained ||
      !data.destroyed
    ) {
      throw new Error(
        "Daytona response is not bound to the requested session, candidate, and run, or its sandbox was not destroyed",
      );
    }
    return this.appendDaytonaAttempt({
      session: input.session,
      purpose: input.purpose,
      candidateId: data.candidateId,
      sandboxId: data.sandboxId,
      runId: data.runId,
      capturedAt: liveCapturedAt(input.envelope),
      disposition: "completed",
      retryable: false,
    });
  }

  private reserveFailedDaytonaAttempt(input: {
    session: ValidationSession;
    error: DaytonaAttemptError;
    purpose: DaytonaAttemptRecord["purpose"];
    expectedCandidateId: string;
    expectedRunId: string;
  }): { session: ValidationSession; accepted: boolean } {
    const attempt = input.error.attempt;
    if (
      attempt.candidateId !== input.expectedCandidateId ||
      attempt.runId !== input.expectedRunId
    ) {
      throw new Error(
        "Failed Daytona attempt is not bound to the requested candidate and run",
      );
    }
    const reserved = this.appendDaytonaAttempt({
      session: input.session,
      purpose: input.purpose,
      candidateId: attempt.candidateId,
      sandboxId: attempt.sandboxId,
      runId: attempt.runId,
      capturedAt: attempt.capturedAt,
      disposition: attempt.disposition,
      retryable:
        attempt.disposition === "cleanup-failed" ||
        attempt.disposition === "failed-retained"
          ? false
          : input.error.retryable,
    });
    if (
      reserved.accepted &&
      ["cleanup-failed", "failed-retained"].includes(attempt.disposition)
    ) {
      return {
        accepted: true,
        session: transitionValidationSession(reserved.session, {
          type: "FAIL",
          at: this.now().toISOString(),
          reason:
            "Daytona sandbox deletion was not confirmed; the live run is permanently fail-closed.",
          recoverable: false,
          retryAction: "reconcile-and-start-new-session",
        }),
      };
    }
    return reserved;
  }

  private appendDaytonaAttempt(input: {
    session: ValidationSession;
    purpose: DaytonaAttemptRecord["purpose"];
    candidateId: string;
    sandboxId: string;
    runId: string;
    capturedAt: string;
    disposition: DaytonaAttemptRecord["disposition"];
    retryable: boolean;
  }): { session: ValidationSession; accepted: boolean } {
    const persisted =
      this.sandboxAttemptHistoryBySession.get(input.session.sessionId) ??
      [...(input.session.sandboxAttemptHistory ?? [])];
    const sessionHistory = input.session.sandboxAttemptHistory ?? [];
    if (
      persisted.length !== sessionHistory.length ||
      persisted.some(
        (attempt, index) =>
          attempt.sandboxId !== sessionHistory[index]?.sandboxId ||
          attempt.runId !== sessionHistory[index]?.runId,
      )
    ) {
      throw new Error("Persisted Daytona attempt history diverged from the session snapshot");
    }
    const next = transitionValidationSession(input.session, {
      type: "DAYTONA_ATTEMPT_RECORDED",
      at: this.now().toISOString(),
      attempt: {
        candidateId: input.candidateId,
        sandboxId: input.sandboxId,
        runId: input.runId,
        purpose: input.purpose,
        capturedAt: input.capturedAt,
        disposition: input.disposition,
        retryable: input.retryable,
      },
    });
    this.sandboxAttemptHistoryBySession.set(
      input.session.sessionId,
      next.sandboxAttemptHistory.map((attempt) => ({ ...attempt })),
    );
    return {
      session: next,
      accepted:
        input.session.state !== "FAILED" &&
        next.sandboxAttemptHistory.at(-1)?.reservationStatus === "reserved",
    };
  }

  private nextDaytonaRunId(sessionId: string): string {
    const historyFloor = Math.max(
      0,
      ...(this.sandboxAttemptHistoryBySession.get(sessionId) ?? []).map(
        (attempt) => {
          const match = /-daytona-(\d+)$/u.exec(attempt.runId);
          return match === null ? 0 : Number.parseInt(match[1]!, 10);
        },
      ),
    );
    const next =
      Math.max(
        this.daytonaRunSequenceBySession.get(sessionId) ?? 0,
        historyFloor,
      ) + 1;
    this.daytonaRunSequenceBySession.set(sessionId, next);
    return `${sessionId}-daytona-${next.toString().padStart(6, "0")}`;
  }

  private requestForCandidate(input: {
    sessionId: string;
    candidateId: string;
    strategy: CandidateStrategy;
    evaluationProfile: FireworksEvaluationProfile;
    commitSha: string;
    incident?: RegisteredLiveIncident;
    sourceContext: FireworksSourceContext;
    seed: number;
  }): FireworksCandidateRequest {
    const incident = input.incident ?? this.registry.incident;
    return {
      sessionId: input.sessionId,
      candidateId: input.candidateId,
      strategy: input.strategy,
      evaluationProfile: input.evaluationProfile,
      incident: {
        title: incident.title,
        summary: incident.summary,
        evidence: incident.evidence,
      },
      safetyPolicy: {
        policyVersion: this.registry.policy.policyVersion,
        invariants: this.registry.policy.invariants,
        allowedPatchPaths: this.registry.policy.allowedPatchPaths,
        protectedPaths: this.registry.policy.protectedPaths,
        maxChangedFiles: this.registry.policy.maxChangedFiles,
        maxChangedLines: this.registry.policy.maxChangedLines,
      },
      repository: {
        repoUrl: this.dependencies.repository.repoUrl,
        commitSha: input.commitSha,
      },
      sourceContext: input.sourceContext,
      requestedTests: this.registry.policy.requestedTests,
      seed: input.seed,
    };
  }

  private async captureTrace(
    traces: ProviderEnvelope<BraintrustTraceEvidence>[],
    event: Parameters<BraintrustAdapter["traceStage"]>[0],
  ): Promise<ProviderEnvelope<BraintrustTraceEvidence>> {
    const trace = await this.dependencies.braintrust.traceStage(event);
    if (trace.provider !== "braintrust") {
      throw new Error("Live stage trace did not come from Braintrust");
    }
    traces.push(trace);
    return trace;
  }

  private async evaluateRound(input: {
    session: ValidationSession;
    roundName: string;
    candidates: readonly CandidatePatch[];
    daytonas: readonly ProviderEnvelope<DaytonaValidationEvidence>[];
    dataset?: ProviderEnvelope<BraintrustDatasetEvidence>;
  }): Promise<ValidationRoundEvidence> {
    const policy = policyForReceipt(this.registry.policy);
    const cases = input.candidates.map((candidate, index) => {
      const daytona = input.daytonas[index]!.data;
      const evaluationEvidence = buildLiveCandidateEvaluationEvidence({
        candidate,
        daytona,
        policy,
      });
      const scores = evaluateDeterministicScorers(evaluationEvidence).scores;
      return {
        candidateId: candidate.candidateId,
        input: {
          incidentId: input.session.incidentId,
          strategy: candidate.strategy,
          hypothesis: candidate.hypothesis,
        },
        evaluationEvidence,
        evidenceDigest: computeLiveCandidateEvidenceDigest({
          policyVersion: input.session.policyVersion,
          daytona,
          scores,
        }),
        expected: { hardSafetyGates: "pass-or-ineligible" },
        metadata: {
          sessionId: input.session.sessionId,
          patchDigest: sha256(candidate.unifiedDiff),
          sandboxId: daytona.sandboxId,
          validatedTreeSha: daytona.validatedTreeSha ?? null,
          policyVersion: input.session.policyVersion,
          validationRound: input.session.validationRound + 1,
        },
      };
    });
    const dataset =
      input.dataset ??
      (await this.dependencies.braintrust.seedFirmwareSafetyDataset(
        FIRMWARE_SAFETY_INCIDENTS,
      ));
    const experiment = await this.dependencies.braintrust.runCandidateExperiment(
      input.roundName,
      cases,
    );
    const trace = await this.dependencies.braintrust.traceStage({
      name: "safeflash.live-validation-round",
      input: {
        sessionId: input.session.sessionId,
        candidateIds: input.candidates.map((candidate) => candidate.candidateId),
      },
      output: {
        experimentId: experiment.data.experimentId,
        resultCount: experiment.data.resultCount,
      },
      metadata: {
        policyVersion: input.session.policyVersion,
        roundName: input.roundName,
        mode: "live",
      },
    });
    return { dataset, experiment, trace };
  }

  private snapshot(record: LiveWorkflowRecord): LiveWorkflowSnapshot {
    const daytona = record.daytonaByCandidate.get(
      record.selectedCandidate.candidateId,
    );
    if (daytona === undefined) throw new Error("Selected Daytona evidence is missing");
    const candidates = record.session.candidateIds.map((candidateId) => {
      const candidate = record.candidates.get(candidateId);
      const candidateDaytona = record.daytonaByCandidate.get(candidateId);
      const generation = record.generationByCandidate.get(candidateId);
      const evaluation = record.evaluationByCandidate.get(candidateId);
      const evaluationProvenance =
        record.evaluationProvenanceByCandidate.get(candidateId);
      const ranking = record.rankingByCandidate.get(candidateId);
      if (
        candidate === undefined ||
        candidateDaytona === undefined ||
        generation === undefined ||
        evaluation === undefined ||
        evaluationProvenance === undefined ||
        ranking === undefined
      ) {
        throw new Error(`Live candidate evidence is incomplete: ${candidateId}`);
      }
      return {
        candidate: structuredClone(candidate),
        evaluationProfile: generation.request.evaluationProfile,
        generation: {
          provider: "fireworks" as const,
          model: generation.evidence.data.model,
          requestId: generation.evidence.data.requestId,
          latencyMs: generation.evidence.data.latencyMs,
          totalTokens: generation.evidence.data.totalTokens ?? null,
          sourceContextDigest: generation.evidence.data.sourceContextDigest,
          requestDigest: generation.evidence.data.requestDigest,
          capturedAt: liveCapturedAt(generation.evidence),
        },
        validation: {
          provider: "daytona" as const,
          sandboxId: candidateDaytona.data.sandboxId,
          runId: candidateDaytona.data.runId,
          baseCommitSha: candidateDaytona.data.commitSha,
          patchDigest: candidateDaytona.data.patchDigest,
          policyDigest: candidateDaytona.data.policyDigest,
          passed: candidateDaytona.data.passed,
          validatedTreeSha: candidateDaytona.data.validatedTreeSha ?? null,
          build: { ...evaluation.evaluationEvidence.build },
          unitTests: { ...evaluation.evaluationEvidence.unitTests },
          safetyTests: {
            ...evaluation.evaluationEvidence.safetyTests,
            criticalFailures: [
              ...evaluation.evaluationEvidence.safetyTests.criticalFailures,
            ],
          },
          regressionTests: { ...evaluation.evaluationEvidence.regressionTests },
          integrity: {
            ...evaluation.evaluationEvidence.integrity,
            violations: [...evaluation.evaluationEvidence.integrity.violations],
          },
          commands: candidateDaytona.data.commands.map((command) => ({
            id: command.id,
            exitCode: command.exitCode,
            timedOut: command.timedOut,
            durationMs: command.durationMs,
            stdoutHash: command.stdoutHash ?? null,
            artifactHash: command.artifactHash ?? null,
          })),
          capturedAt: liveCapturedAt(candidateDaytona),
        },
        scoring: {
          provider: "braintrust" as const,
          eligible: ranking.eligible,
          weightedScore: ranking.weightedScore,
          hardGateFailures: [...ranking.hardGateFailures],
          evidenceDigest: ranking.evidenceDigest,
          values: evaluateDeterministicScorers(
            evaluation.evaluationEvidence,
          ).values,
          ...evaluationProvenance,
        },
      } satisfies LiveCandidateEvidenceSummary;
    });
    return {
      session: structuredClone(record.session),
      decision: structuredClone(record.decision),
      selectedCandidate: structuredClone(record.selectedCandidate),
      candidates,
      providerEvidence: {
        braintrustDatasetId: record.braintrust.dataset.data.datasetId,
        braintrustDatasetUrl: record.braintrust.dataset.data.datasetUrl,
        braintrustExperimentId:
          record.braintrust.experiment.data.experimentId,
        braintrustExperimentUrl: record.braintrust.experiment.data.experimentUrl,
        braintrustTraceId: record.braintrust.trace.data.traceId,
        braintrustTraceUrl: record.braintrust.trace.data.traceUrl,
        stageTraceIds: record.stageTraces.map((trace) => trace.data.traceId),
        stageTraceUrls: record.stageTraces.map((trace) => trace.data.traceUrl),
        daytonaSandboxId: daytona.data.sandboxId,
        daytonaRunId: daytona.data.runId,
        preparedCommitSha: record.prepared.commitSha,
        preparedTreeSha: record.prepared.treeSha,
        headBranch: record.prepared.headBranch,
      },
    };
  }

  async startTournament(sessionIdValue: string): Promise<LiveWorkflowSnapshot> {
    const sessionId = safeSessionId(sessionIdValue);
    if (this.records.has(sessionId) || this.startReservations.has(sessionId)) {
      throw new Error("Live session already exists or is starting");
    }
    const persistedAttemptHistory =
      this.sandboxAttemptHistoryBySession.get(sessionId) ?? [];
    const terminalFailure = persistedAttemptHistory.find(
      (attempt) =>
        ["cleanup-failed", "failed-retained"].includes(attempt.disposition) ||
        (attempt.disposition === "failed-destroyed" && !attempt.retryable),
    );
    if (terminalFailure !== undefined) {
      const disposition = terminalFailure.disposition;
      if (disposition === "completed") {
        throw new Error(
          "Internal Daytona attempt-history invariant rejected a completed terminal failure",
        );
      }
      throw new DaytonaAttemptError({
        attempt: {
          sandboxId: terminalFailure.sandboxId,
          runId: terminalFailure.runId,
          candidateId: terminalFailure.candidateId,
          capturedAt: terminalFailure.capturedAt,
          disposition,
        },
        retryable: false,
      });
    }
    const invalidReservation = persistedAttemptHistory.find(
      (attempt) =>
        attempt.reservationStatus !== "reserved" ||
        attempt.duplicateSandbox ||
        attempt.duplicateRun,
    );
    if (invalidReservation !== undefined) {
      throw new ProviderResponseError(
        "daytona",
        "The live session ID is terminal because Daytona attempt identity was reused or rejected",
        false,
      );
    }
    this.startReservations.add(sessionId);
    this.emitProgress({
      sessionId,
      state: "INGESTING_REPOSITORY",
      stage: "workflow-started",
      message: "The orchestrator started immutable repository ingestion.",
    });
    try {
      return await this.startTournamentReserved(sessionId);
    } finally {
      this.startReservations.delete(sessionId);
    }
  }

  private async startTournamentReserved(
    sessionId: string,
  ): Promise<LiveWorkflowSnapshot> {
    const baseCommitSha = requireGitId(
      "GitHub base commit",
      await this.dependencies.repository.resolveBaseCommit(),
    );
    const sourceContextEnvelope =
      await this.dependencies.repository.readSourceContext(sessionId, baseCommitSha);
    if (
      sourceContextEnvelope.provider !== "github" ||
      sourceContextEnvelope.data.commitSha.toLowerCase() !==
        baseCommitSha.toLowerCase()
    ) {
      throw new Error("GitHub source context is not bound to the immutable base commit");
    }
    const stageTraces: ProviderEnvelope<BraintrustTraceEvidence>[] = [];
    await this.captureTrace(stageTraces, {
      name: "safeflash.repository-source-ingested",
      input: {
        sessionId,
        repository: this.dependencies.repository.repoUrl,
        commitSha: baseCommitSha,
      },
      output: {
        sourceContextDigest: sourceContextEnvelope.data.digest,
        filePaths: sourceContextEnvelope.data.files.map((file) => file.path),
      },
      metadata: {
        mode: "live",
        provider: "github",
        workflowSourceVersion: WORKFLOW_SOURCE_VERSION,
      },
    });
    let session = createValidationSession({
      id: sessionId,
      incidentId: this.registry.incident.id,
      policyId: this.registry.policy.id,
      policyVersion: this.registry.policy.policyVersion,
      policySnapshot: {
        allowedPatchPaths: this.registry.policy.allowedPatchPaths,
        maxChangedFiles: this.registry.policy.maxChangedFiles,
        maxChangedLines: this.registry.policy.maxChangedLines,
      },
      repository: {
        repoUrl: this.dependencies.repository.repoUrl,
        commitSha: baseCommitSha,
      },
      pullRequestTarget: {
        provider: "github",
        owner: this.dependencies.repository.owner,
        repository: this.dependencies.repository.name,
        baseBranch: this.dependencies.repository.baseBranch,
      },
      mode: "live",
      runKind: "tournament",
      sourceVersion: WORKFLOW_SOURCE_VERSION,
      at: this.now().toISOString(),
    });
    const priorAttemptHistory =
      this.sandboxAttemptHistoryBySession.get(sessionId) ?? [];
    if (priorAttemptHistory.length > 0) {
      session = {
        ...session,
        sandboxAttemptHistory: priorAttemptHistory.map((attempt) => ({
          ...attempt,
        })),
      };
    }
    session = transitionValidationSession(session, {
      type: "START",
      at: this.now().toISOString(),
    });
    session = transitionValidationSession(session, {
      type: "REPOSITORY_INGESTED",
      at: this.now().toISOString(),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "repository-ingested",
      provider: "github",
      evidenceId: sourceContextEnvelope.data.digest,
      message: "Immutable GitHub source context was verified.",
    });
    session = transitionValidationSession(session, {
      type: "INCIDENT_ANALYZED",
      at: this.now().toISOString(),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "incident-analyzed",
      message: "The server-owned temperature-sensor incident and safety policy were bound.",
    });

    let requests = STRATEGIES.map((strategy, index) =>
      this.requestForCandidate({
        sessionId,
        candidateId: `candidate-${index + 1}-${strategy}`,
        strategy,
        evaluationProfile: EVALUATION_PROFILES[index]!,
        commitSha: baseCommitSha,
        sourceContext: sourceContextEnvelope.data,
        seed: 10_001 + index,
      }),
    );
    let generated = [
      ...(await this.dependencies.fireworks.generateTournament(requests)),
    ];
    await this.captureTrace(stageTraces, {
      name: "safeflash.fireworks-tournament-generated",
      input: {
        sessionId,
        strategies: requests.map((request) => request.strategy),
        seeds: requests.map((request) => request.seed),
        sourceContextDigest: sourceContextEnvelope.data.digest,
      },
      output: {
        candidates: generated.map((envelope) => ({
          candidateId: envelope.data.candidate.candidateId,
          patchDigest: sha256(envelope.data.candidate.unifiedDiff),
          requestId: envelope.data.requestId,
          model: envelope.data.model,
          latencyMs: envelope.data.latencyMs,
          totalTokens: envelope.data.totalTokens ?? null,
        })),
      },
      metadata: { mode: "live", provider: "fireworks", profileAttempt: 1 },
    });
    let candidates = generated.map((envelope) => envelope.data.candidate);
    session = transitionValidationSession(session, {
      type: "CANDIDATES_GENERATED",
      at: this.now().toISOString(),
      candidateIds: candidates.map((candidate) => candidate.candidateId),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "candidates-generated",
      provider: "fireworks",
      evidenceId: generated
        .map((envelope) => envelope.data.requestId)
        .join(","),
      candidates: candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId,
        strategy: candidate.strategy,
        evaluationProfile: requests[index]!.evaluationProfile,
        hypothesis: candidate.hypothesis,
        unifiedDiff: candidate.unifiedDiff,
        patchDigest: sha256(candidate.unifiedDiff),
        generationCapturedAt: liveCapturedAt(generated[index]!),
      })),
      message: "Fireworks generated two contenders and one diagnostic control.",
    });
    const daytonaSettled = await Promise.allSettled(
      candidates.map(async (candidate) => {
        const runId = this.nextDaytonaRunId(sessionId);
        let daytona: ProviderEnvelope<DaytonaValidationEvidence>;
        try {
          daytona = await this.dependencies.daytona.validateCandidate({
            runId,
            sessionId,
            candidate,
            repository: {
              repoUrl: this.dependencies.repository.repoUrl,
              commitSha: baseCommitSha,
            },
            policy: {
              policyVersion: this.registry.policy.policyVersion,
              allowedPatchPaths: this.registry.policy.allowedPatchPaths,
              maxChangedFiles: this.registry.policy.maxChangedFiles,
              maxChangedLines: this.registry.policy.maxChangedLines,
            },
          });
        } catch (error) {
          if (error instanceof DaytonaAttemptError) {
            const failedReservation = this.reserveFailedDaytonaAttempt({
              session,
              error,
              purpose: "initial-candidate",
              expectedCandidateId: candidate.candidateId,
              expectedRunId: runId,
            });
            session = failedReservation.session;
            if (!failedReservation.accepted) {
              throw new Error(
                "Every Daytona response must reserve a globally unique sandbox ID and run ID",
              );
            }
            if (
              ["cleanup-failed", "failed-retained"].includes(
                error.attempt.disposition,
              )
            ) {
              throw new DaytonaAttemptError({
                attempt: { ...error.attempt },
                retryable: false,
              });
            }
          }
          throw error;
        }
        const reservation = this.reserveDaytonaAttempt({
          session,
          envelope: daytona,
          purpose: "initial-candidate",
          expectedCandidateId: candidate.candidateId,
          expectedRunId: runId,
        });
        session = reservation.session;
        if (!reservation.accepted) {
          throw new Error(
            "Every Daytona response must reserve a globally unique sandbox ID and run ID",
          );
        }
        const evaluation = buildLiveCandidateEvaluationEvidence({
          candidate,
          daytona: daytona.data,
          policy: policyForReceipt(this.registry.policy),
        });
        this.emitProgress({
          sessionId,
          state: session.state,
          stage: "candidate-validated",
          provider: "daytona",
          candidateId: daytona.data.candidateId,
          evidenceId: `${daytona.data.sandboxId}/${daytona.data.runId}`,
          validation: {
            sandboxId: daytona.data.sandboxId,
            runId: daytona.data.runId,
            passed: daytona.data.passed,
            validatedTreeSha: daytona.data.validatedTreeSha ?? null,
            capturedAt: liveCapturedAt(daytona),
            build: { ...evaluation.build },
            unitTests: { ...evaluation.unitTests },
            safetyTests: {
              ...evaluation.safetyTests,
              criticalFailures: [...evaluation.safetyTests.criticalFailures],
            },
            integrity: {
              ...evaluation.integrity,
              violations: [...evaluation.integrity.violations],
            },
          },
          message: daytona.data.passed
            ? "Daytona completed the trusted validation commands."
            : "Daytona recorded a real hard-gate failure for this candidate.",
        });
        await this.captureTrace(stageTraces, {
          name: "safeflash.daytona-candidate-validated",
          input: {
            sessionId,
            candidateId: daytona.data.candidateId,
            patchDigest: daytona.data.patchDigest,
            commitSha: daytona.data.commitSha,
          },
          output: {
            sandboxId: daytona.data.sandboxId,
            runId: daytona.data.runId,
            passed: daytona.data.passed,
            validatedTreeSha: daytona.data.validatedTreeSha ?? null,
            commandExitCodes: daytona.data.commands.map((command) => ({
              id: command.id,
              exitCode: command.exitCode,
              timedOut: command.timedOut,
            })),
          },
          metadata: { mode: "live", provider: "daytona", profileAttempt: 1 },
        });
        return daytona;
      }),
    );
    const rejectedDaytona = daytonaSettled.filter(
      (result) => result.status === "rejected",
    );
    const firstRejectedDaytona =
      rejectedDaytona.find(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ProviderResponseError &&
          !result.reason.retryable,
      ) ?? rejectedDaytona[0];
    if (firstRejectedDaytona?.status === "rejected") {
      if (firstRejectedDaytona.reason instanceof Error) {
        throw firstRejectedDaytona.reason;
      }
      throw new Error("Daytona candidate validation failed");
    }
    let daytonas = daytonaSettled.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("Daytona candidate validation did not settle successfully");
      }
      return result.value;
    });
    let braintrust: ValidationRoundEvidence;
    let sharedDataset: ProviderEnvelope<BraintrustDatasetEvidence> | undefined;
    let decision: CandidateDecision;
    let profileAttempt = 1;
    while (true) {
      braintrust = await this.evaluateRound({
        session,
        roundName: `${sessionId}-initial-tournament-profile-${profileAttempt}`,
        candidates,
        daytonas,
        dataset: sharedDataset,
      });
      sharedDataset = braintrust.dataset;
      stageTraces.push(braintrust.trace);
      decision = selectCandidate(
        scoresFromExperiment(braintrust.experiment.data),
        {
          id: `${sessionId}-initial-decision-profile-${profileAttempt}`,
          sessionId,
          source: "braintrust",
          sourceVersion: braintrust.experiment.data.experimentId,
          at: this.now().toISOString(),
          selectionPolicyVersion: SELECTION_POLICY_VERSION,
        },
      );
      await this.captureTrace(stageTraces, {
        name: "safeflash.braintrust-hard-gate-selection",
        input: {
          sessionId,
          experimentId: braintrust.experiment.data.experimentId,
          profileAttempt,
        },
        output: {
          winnerCandidateId: decision.winnerCandidateId,
          rankings: decision.rankings.map((ranking) => ({
            candidateId: ranking.candidateId,
            eligible: ranking.eligible,
            weightedScore: ranking.weightedScore,
            hardGateFailures: ranking.hardGateFailures,
            evidenceDigest: ranking.evidenceDigest,
          })),
        },
        metadata: {
          mode: "live",
          provider: "braintrust",
          selectionPolicyVersion: SELECTION_POLICY_VERSION,
        },
      });
      const rankingForRequest = (request: FireworksCandidateRequest) =>
        decision.rankings.find(
          (ranking) => ranking.candidateId === request.candidateId,
        );
      const contenderRequests = requests.filter(
        (request) => request.evaluationProfile === "safety-contender",
      );
      const failedContenderRequest = contenderRequests.find(
        (request) => rankingForRequest(request)?.eligible !== true,
      );
      const negativeControlRequest = requests.find(
        (request) => request.evaluationProfile === "safety-negative-control",
      );
      const negativeControlRanking =
        negativeControlRequest === undefined
          ? undefined
          : rankingForRequest(negativeControlRequest);
      const profileContractPassed =
        contenderRequests.length === 2 &&
        failedContenderRequest === undefined &&
        negativeControlRanking?.eligible === false &&
        negativeControlRanking.hardGateFailures.some((failure) =>
          failure.startsWith("SafetyInvariant"),
        ) &&
        contenderRequests.some(
          (request) => request.candidateId === decision.winnerCandidateId,
        );
      if (profileContractPassed) break;
      if (profileAttempt >= MAX_TOURNAMENT_PROFILE_ATTEMPTS) {
        throw new ProviderResponseError(
          "braintrust",
          "Live tournament did not produce both eligible and rejected candidates after bounded real-provider regeneration",
          false,
        );
      }
      const targetRequest =
        failedContenderRequest ?? negativeControlRequest;
      const targetRanking = decision.rankings.find(
        (ranking) => ranking.candidateId === targetRequest?.candidateId,
      );
      if (targetRanking === undefined) {
        throw new Error("Braintrust returned no ranked candidate for regeneration");
      }
      const targetIndex = candidates.findIndex(
        (item) => item.candidateId === targetRanking.candidateId,
      );
      if (targetIndex < 0) {
        throw new Error("Ranked candidate is missing from the tournament");
      }
      profileAttempt += 1;
      const replacementRequest = this.requestForCandidate({
        sessionId,
        candidateId: requests[targetIndex]!.candidateId,
        strategy: requests[targetIndex]!.strategy,
        evaluationProfile: requests[targetIndex]!.evaluationProfile,
        commitSha: baseCommitSha,
        sourceContext: sourceContextEnvelope.data,
        seed: 10_001 + targetIndex + profileAttempt * 1_000,
      });
      const replacement =
        await this.dependencies.fireworks.generateCandidate(replacementRequest);
      const replacementPatchDigest = sha256(
        replacement.data.candidate.unifiedDiff,
      );
      const otherPatchDigests = new Set(
        candidates.map((item) => sha256(item.unifiedDiff)),
      );
      await this.captureTrace(stageTraces, {
        name: "safeflash.fireworks-profile-regenerated",
        input: {
          sessionId,
          replacedCandidateId: targetRanking.candidateId,
          priorEligibility: targetRanking.eligible,
          seed: replacementRequest.seed,
        },
        output: {
          requestId: replacement.data.requestId,
          model: replacement.data.model,
          latencyMs: replacement.data.latencyMs,
          totalTokens: replacement.data.totalTokens ?? null,
          patchDigest: replacementPatchDigest,
          uniquePatch: !otherPatchDigests.has(replacementPatchDigest),
        },
        metadata: { mode: "live", provider: "fireworks", profileAttempt },
      });
      if (otherPatchDigests.has(replacementPatchDigest)) continue;
      const nextCandidates = candidates.map((item, index) =>
        index === targetIndex ? replacement.data.candidate : item,
      );
      const nextGenerated = generated.map((envelope, index) =>
        index === targetIndex ? replacement : envelope,
      );
      const nextRequests = requests.map((request, index) =>
        index === targetIndex ? replacementRequest : request,
      );
      this.emitProgress({
        sessionId,
        state: session.state,
        stage: "candidates-generated",
        provider: "fireworks",
        candidateId: replacement.data.candidate.candidateId,
        evidenceId: replacement.data.requestId,
        candidates: nextCandidates.map((candidate, index) => ({
          candidateId: candidate.candidateId,
          strategy: candidate.strategy,
          evaluationProfile: nextRequests[index]!.evaluationProfile,
          hypothesis: candidate.hypothesis,
          unifiedDiff: candidate.unifiedDiff,
          patchDigest: sha256(candidate.unifiedDiff),
          generationCapturedAt: liveCapturedAt(nextGenerated[index]!),
        })),
        message: "Fireworks regenerated one bounded tournament slot with a distinct patch.",
      });
      const replacementRunId = this.nextDaytonaRunId(sessionId);
      let replacementDaytona: ProviderEnvelope<DaytonaValidationEvidence>;
      try {
        replacementDaytona =
          await this.dependencies.daytona.validateCandidate({
            runId: replacementRunId,
            sessionId,
            candidate: replacement.data.candidate,
            repository: {
              repoUrl: this.dependencies.repository.repoUrl,
              commitSha: baseCommitSha,
            },
            policy: {
              policyVersion: this.registry.policy.policyVersion,
              allowedPatchPaths: this.registry.policy.allowedPatchPaths,
              maxChangedFiles: this.registry.policy.maxChangedFiles,
              maxChangedLines: this.registry.policy.maxChangedLines,
            },
          });
      } catch (error) {
        if (error instanceof DaytonaAttemptError) {
          const failedReservation = this.reserveFailedDaytonaAttempt({
            session,
            error,
            purpose: "profile-replacement",
            expectedCandidateId: replacement.data.candidate.candidateId,
            expectedRunId: replacementRunId,
          });
          session = failedReservation.session;
          if (!failedReservation.accepted) {
            throw new Error(
              "Every Daytona response must reserve a globally unique sandbox ID and run ID",
            );
          }
          if (
            ["cleanup-failed", "failed-retained"].includes(
              error.attempt.disposition,
            )
          ) {
            throw new DaytonaAttemptError({
              attempt: { ...error.attempt },
              retryable: false,
            });
          }
        }
        throw error;
      }
      const replacementReservation = this.reserveDaytonaAttempt({
        session,
        envelope: replacementDaytona,
        purpose: "profile-replacement",
        expectedCandidateId: replacement.data.candidate.candidateId,
        expectedRunId: replacementRunId,
      });
      session = replacementReservation.session;
      if (!replacementReservation.accepted) {
        throw new Error(
          "Every Daytona response must reserve a globally unique sandbox ID and run ID",
        );
      }
      const replacementEvaluation = buildLiveCandidateEvaluationEvidence({
        candidate: replacement.data.candidate,
        daytona: replacementDaytona.data,
        policy: policyForReceipt(this.registry.policy),
      });
      this.emitProgress({
        sessionId,
        state: session.state,
        stage: "candidate-validated",
        provider: "daytona",
        candidateId: replacementDaytona.data.candidateId,
        evidenceId: `${replacementDaytona.data.sandboxId}/${replacementDaytona.data.runId}`,
        validation: {
          sandboxId: replacementDaytona.data.sandboxId,
          runId: replacementDaytona.data.runId,
          passed: replacementDaytona.data.passed,
          validatedTreeSha:
            replacementDaytona.data.validatedTreeSha ?? null,
          capturedAt: liveCapturedAt(replacementDaytona),
          build: { ...replacementEvaluation.build },
          unitTests: { ...replacementEvaluation.unitTests },
          safetyTests: {
            ...replacementEvaluation.safetyTests,
            criticalFailures: [
              ...replacementEvaluation.safetyTests.criticalFailures,
            ],
          },
          integrity: {
            ...replacementEvaluation.integrity,
            violations: [...replacementEvaluation.integrity.violations],
          },
        },
        message: replacementDaytona.data.passed
          ? "Daytona completed the regenerated candidate validation."
          : "Daytona rejected the regenerated candidate at a real hard gate.",
      });
      await this.captureTrace(stageTraces, {
        name: "safeflash.daytona-profile-candidate-validated",
        input: {
          sessionId,
          candidateId: replacementDaytona.data.candidateId,
          patchDigest: replacementDaytona.data.patchDigest,
        },
        output: {
          sandboxId: replacementDaytona.data.sandboxId,
          runId: replacementDaytona.data.runId,
          passed: replacementDaytona.data.passed,
          validatedTreeSha: replacementDaytona.data.validatedTreeSha ?? null,
        },
        metadata: { mode: "live", provider: "daytona", profileAttempt },
      });
      requests = nextRequests;
      generated = nextGenerated;
      candidates = nextCandidates;
      daytonas = daytonas.map((envelope, index) =>
        index === targetIndex ? replacementDaytona : envelope,
      );
    }
    session = transitionValidationSession(session, {
      type: "SANDBOXES_PROVISIONED",
      at: this.now().toISOString(),
      sandboxIdsByCandidate: Object.fromEntries(
        daytonas.map((daytona) => [
          daytona.data.candidateId,
          daytona.data.sandboxId,
        ]),
      ),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "sandboxes-provisioned",
      provider: "daytona",
      message: "Three unique Daytona sandboxes returned isolated evidence.",
    });
    session = transitionValidationSession(session, {
      type: "BUILDS_FINISHED",
      at: this.now().toISOString(),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "builds-finished",
      provider: "daytona",
      message: "Trusted build command results were captured from Daytona.",
    });
    session = transitionValidationSession(session, {
      type: "TESTS_FINISHED",
      at: this.now().toISOString(),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "tests-finished",
      provider: "daytona",
      message: "Trusted unit, safety, regression, and integrity results were captured.",
    });
    session = transitionValidationSession(session, {
      type: "SCORING_FINISHED",
      at: this.now().toISOString(),
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "scoring-finished",
      provider: "braintrust",
      evidenceId: braintrust.experiment.data.experimentId,
      message: "Braintrust returned scorer-recomputed experiment rows for every candidate.",
    });
    if (decision.winnerCandidateId === null) {
      throw new ProviderResponseError(
        "braintrust",
        "No live tournament candidate passed every hard safety gate",
        false,
      );
    }
    const selectedCandidate = candidates.find(
      (candidate) => candidate.candidateId === decision.winnerCandidateId,
    );
    const selectedDaytona = daytonas.find(
      (daytona) => daytona.data.candidateId === decision.winnerCandidateId,
    );
    if (selectedCandidate === undefined || selectedDaytona === undefined) {
      throw new Error("Selected candidate evidence is incomplete");
    }
    const selectedTree = requireGitId(
      "Selected Daytona tree",
      selectedDaytona.data.validatedTreeSha,
    );
    const prepared = await this.dependencies.publication.prepareCandidatePublication({
      sessionId,
      baseCommitSha,
      candidate: selectedCandidate,
      expectedTreeSha: selectedTree,
      targetBaseCommitSha: session.repository.commitSha,
      committedAt: session.updatedAt,
    });
    if (
      prepared.baseCommitSha.toLowerCase() !== baseCommitSha.toLowerCase() ||
      prepared.treeSha.toLowerCase() !== selectedTree.toLowerCase()
    ) {
      throw new Error("Prepared Git publication is not bound to the Daytona tree");
    }
    await this.captureTrace(stageTraces, {
      name: "safeflash.github-publication-prepared",
      input: {
        sessionId,
        candidateId: selectedCandidate.candidateId,
        patchDigest: sha256(selectedCandidate.unifiedDiff),
        baseCommitSha,
      },
      output: {
        headBranch: prepared.headBranch,
        commitSha: prepared.commitSha,
        treeSha: prepared.treeSha,
        publicationDigest: prepared.publication.data.publicationDigest,
      },
      metadata: { mode: "live", provider: "github", mutation: false },
    });
    const receipt = createLiveFullRevalidationReceipt({
      purpose: "initial-selection",
      session,
      policy: policyForReceipt(this.registry.policy),
      candidate: selectedCandidate,
      commitSha: prepared.commitSha,
      commitTreeSha: prepared.treeSha,
      daytona: selectedDaytona,
      braintrust: braintrust.experiment,
      initialTournament: candidates.map((candidate, index) => ({
        candidate,
        daytona: daytonas[index]!,
      })),
      generations: requests.map((request, index) => ({
        request,
        evidence: generated[index]!,
        sourceContext: sourceContextEnvelope,
      })),
      publication: prepared.publication,
    });
    await this.captureTrace(stageTraces, {
      name: "safeflash.initial-selection-attested",
      input: {
        sessionId,
        candidateId: selectedCandidate.candidateId,
        patchDigest: receipt.patchDigest,
        experimentId: braintrust.experiment.data.experimentId,
      },
      output: {
        evidenceDigest: receipt.evidenceDigest,
        commitSha: receipt.commitSha,
        validatedTreeSha: receipt.validatedTreeSha,
        sandboxId: receipt.sandboxId,
        eligible: receipt.candidateEligible,
      },
      metadata: { mode: "live", stage: "initial-selection" },
    });
    session = transitionValidationSession(session, {
      type: "CANDIDATE_SELECTED",
      at: this.now().toISOString(),
      candidateId: selectedCandidate.candidateId,
      patchDigest: receipt.patchDigest,
      evidenceDigest: receipt.evidenceDigest,
      commitSha: receipt.commitSha,
      receipt,
    });
    this.emitProgress({
      sessionId,
      state: session.state,
      stage: "candidate-selected",
      provider: "braintrust",
      candidateId: selectedCandidate.candidateId,
      evidenceId: receipt.evidenceDigest,
      message: "The highest-scoring eligible contender is awaiting bound human approval.",
    });
    const record: LiveWorkflowRecord = {
      session,
      candidates: new Map(
        candidates.map((candidate) => [candidate.candidateId, candidate]),
      ),
      daytonaByCandidate: new Map(
        daytonas.map((daytona) => [daytona.data.candidateId, daytona]),
      ),
      decision,
      braintrust,
      selectedCandidate,
      prepared,
      generationByCandidate: new Map(
        requests.map((request, index) => [
          request.candidateId,
          { request, evidence: generated[index]! },
        ]),
      ),
      evaluationByCandidate: new Map(
        braintrust.experiment.data.candidateResults.map((result) => [
          result.candidateId,
          result,
        ]),
      ),
      evaluationProvenanceByCandidate: new Map(
        braintrust.experiment.data.candidateResults.map((result) => [
          result.candidateId,
          {
            resultId: result.resultId,
            experimentId: braintrust.experiment.data.experimentId,
            experimentName: braintrust.experiment.data.experimentName,
            experimentUrl: braintrust.experiment.data.experimentUrl,
            traceId: braintrust.trace.data.traceId,
            traceUrl: braintrust.trace.data.traceUrl,
            validationRound: session.validationRound,
            capturedAt: liveCapturedAt(braintrust.experiment),
          },
        ]),
      ),
      rankingByCandidate: new Map(
        decision.rankings.map((ranking) => [ranking.candidateId, ranking]),
      ),
      stageTraces,
    };
    this.records.set(sessionId, record);
    return this.snapshot(record);
  }

  async recordHumanDecision(
    input: LiveHumanDecisionInput,
  ): Promise<LiveWorkflowSnapshot> {
    const sessionId = safeSessionId(input.sessionId);
    return this.runExclusive(sessionId, () =>
      this.recordHumanDecisionReserved(input),
    );
  }

  private async recordHumanDecisionReserved(
    input: LiveHumanDecisionInput,
  ): Promise<LiveWorkflowSnapshot> {
    const record = this.records.get(input.sessionId);
    if (record === undefined) throw new Error("Unknown live workflow session");
    const session = record.session;
    if (
      session.state !== "AWAITING_HUMAN_APPROVAL" ||
      session.selectedCandidateId === undefined ||
      session.currentPatchDigest === undefined ||
      session.currentEvidenceDigest === undefined ||
      session.currentCommitSha === undefined
    ) {
      throw new Error("Live workflow is not awaiting a bound human decision");
    }
    if (
      input.expected.candidateId !== session.selectedCandidateId ||
      input.expected.patchDigest !== session.currentPatchDigest ||
      input.expected.evidenceDigest !== session.currentEvidenceDigest ||
      input.expected.commitSha.toLowerCase() !==
        session.currentCommitSha.toLowerCase() ||
      input.expected.policyVersion !== session.policyVersion
    ) {
      throw new Error(
        "Human decision evidence is stale; refresh and review the current candidate before acting",
      );
    }
    const approval = createHumanApproval({
      id: `approval-${session.sessionId}-${session.validationRound}`,
      sessionId: session.sessionId,
      approverId: input.approverId,
      approverDisplayName: input.approverDisplayName,
      decision: input.decision,
      actedAt: this.now().toISOString(),
      candidateId: session.selectedCandidateId,
      patchDigest: session.currentPatchDigest,
      evidenceDigest: session.currentEvidenceDigest,
      policyVersion: session.policyVersion,
      commitSha: session.currentCommitSha,
      pullRequestTarget: session.pullRequestTarget,
      sourceVersion: WORKFLOW_SOURCE_VERSION,
      reason: input.reason,
    });
    await this.captureTrace(record.stageTraces, {
      name: "safeflash.human-approval-bound",
      input: {
        sessionId: session.sessionId,
        candidateId: session.selectedCandidateId,
        patchDigest: session.currentPatchDigest,
        evidenceDigest: session.currentEvidenceDigest,
        commitSha: session.currentCommitSha,
        policyVersion: session.policyVersion,
      },
      output: {
        approvalId: approval.id,
        approverId: approval.approverId,
        decision: approval.decision,
        bindingDigest: approval.bindingDigest,
      },
      metadata: { mode: "live", stage: "human-approval" },
    });
    record.session = transitionValidationSession(session, {
      type: "APPROVAL_RECORDED",
      at: this.now().toISOString(),
      approval,
    });
    this.emitProgress({
      sessionId: session.sessionId,
      state: record.session.state,
      stage: "human-decision-recorded",
      candidateId: session.selectedCandidateId,
      evidenceId: approval.bindingDigest,
      message:
        approval.decision === "approved"
          ? "Human approval was bound to the exact current evidence."
          : "Human review stopped publication for the current evidence.",
    });
    return this.snapshot(record);
  }

  async publishApprovedAndReview(
    sessionIdValue: string,
  ): Promise<LiveWorkflowSnapshot> {
    const sessionId = safeSessionId(sessionIdValue);
    return this.runExclusive(sessionId, () =>
      this.publishApprovedAndReviewReserved(sessionId),
    );
  }

  private async publishApprovedAndReviewReserved(
    sessionId: string,
  ): Promise<LiveWorkflowSnapshot> {
    const record = this.records.get(sessionId);
    if (record === undefined) throw new Error("Unknown live workflow session");
    let pullRequest: PullRequestRecord;
    if (record.session.state === "AWAITING_HUMAN_APPROVAL") {
      record.session = transitionValidationSession(record.session, {
        type: "PR_CREATION_REQUESTED",
        at: this.now().toISOString(),
      });
      this.emitProgress({
        sessionId,
        state: record.session.state,
        stage: "publication-requested",
        candidateId: record.selectedCandidate.candidateId,
        evidenceId: record.session.currentEvidenceDigest,
        message: "The orchestrator entered the evidence-bound publication transition.",
      });
    }
    if (record.session.state === "CREATING_PULL_REQUEST") {
      const published =
        await this.dependencies.publication.publishApprovedCandidate({
          session: record.session,
          candidate: record.selectedCandidate,
          prepared: record.prepared,
          incident: this.registry.incident,
          tests: this.registry.policy.requestedTests,
        });
      await this.captureTrace(record.stageTraces, {
        name: "safeflash.github-approved-publication",
        input: {
          sessionId: record.session.sessionId,
          candidateId: record.selectedCandidate.candidateId,
          approvedCommitSha: record.session.currentCommitSha,
          headBranch: record.prepared.headBranch,
        },
        output: {
          pullNumber: published.data.number,
          pullRequestUrl: published.data.url,
          headSha: published.data.headSha,
          headTreeSha: published.data.headTreeSha,
          status: published.data.status,
        },
        metadata: { mode: "live", provider: "github", mutation: true },
      });
      record.session = transitionValidationSession(record.session, {
        type: "PR_CREATED_OR_UPDATED",
        at: this.now().toISOString(),
        pullRequest: published.data,
      });
      record.pullRequestEvidence = published;
      this.emitProgress({
        sessionId,
        state: record.session.state,
        stage: "pull-request-published",
        provider: "github",
        candidateId: record.selectedCandidate.candidateId,
        evidenceId: `${published.data.number}/${published.data.headSha}`,
        message: "The approved commit was created or updated on the SafeFlash pull request.",
      });
      pullRequest = published.data;
    } else if (
      record.session.state === "AWAITING_CODERABBIT" &&
      record.session.pullRequest !== undefined
    ) {
      pullRequest = record.session.pullRequest;
    } else {
      throw new Error(
        "Live workflow is not approved for publication or awaiting CodeRabbit",
      );
    }
    const inspection = await this.dependencies.coderabbit.waitForReview({
      sessionId: record.session.sessionId,
      pullNumber: pullRequest.number,
      headSha: pullRequest.headSha,
      expectedBaseRef: pullRequest.baseBranch,
      expectedBaseSha: pullRequest.baseSha,
    });
    record.lastInspection = inspection;
    await this.captureTrace(record.stageTraces, {
      name: "safeflash.coderabbit-independent-review",
      input: {
        sessionId: record.session.sessionId,
        pullNumber: pullRequest.number,
        headSha: pullRequest.headSha,
      },
      output: {
        status: inspection.data.status,
        pullRequestUrl: pullRequest.url,
        findingCount: inspection.data.findings.length,
        blockerCount: inspection.data.findings.filter(
          (finding) => !finding.finding.resolved,
        ).length,
      },
      metadata: { mode: "live", provider: "coderabbit" },
    });
    if (inspection.data.requiresFullRevalidation) {
      throw new ProviderResponseError(
        "coderabbit",
        "The pull-request base moved during independent review; restart the full validation pipeline against the new immutable base.",
        false,
      );
    }
    if (inspection.data.status === "pending" || inspection.data.timedOut) {
      throw new ProviderResponseError(
        "coderabbit",
        "CodeRabbit review is still pending for the exact pull-request head",
        true,
      );
    }
    const receipt = createLiveIndependentReviewReceipt(inspection, {
      owner: this.dependencies.repository.owner,
      repository: this.dependencies.repository.name,
    });
    const findings: readonly ReviewFinding[] = inspection.data.findings.map(
      (finding) => finding.finding,
    );
    record.session = transitionValidationSession(record.session, {
      type: "REVIEW_FINDINGS_RECEIVED",
      at: this.now().toISOString(),
      findings,
      receipt,
    });
    this.emitProgress({
      sessionId,
      state: record.session.state,
      stage: "independent-review-finished",
      provider: "coderabbit",
      candidateId: record.selectedCandidate.candidateId,
      evidenceId: receipt.evidenceIds.join(","),
      message:
        receipt.status === "passed"
          ? "CodeRabbit passed the exact pull-request head."
          : "CodeRabbit blocked the exact pull-request head with actionable findings.",
    });
    if (record.session.state === "REVIEW_PASSED") {
      record.session = transitionValidationSession(record.session, {
        type: "MARK_READY_TO_MERGE",
        at: this.now().toISOString(),
      });
      this.emitProgress({
        sessionId,
        state: record.session.state,
        stage: "ready-to-merge",
        provider: "coderabbit",
        candidateId: record.selectedCandidate.candidateId,
        evidenceId: pullRequest.headSha,
        message: "Every required gate passed; SafeFlash will not merge automatically.",
      });
    }
    return this.snapshot(record);
  }

  /**
   * Creates the redacted replay artifact directly from authority-bearing
   * envelopes retained by this in-memory Live workflow. Serialized snapshots,
   * mock fixtures, and manually assembled provider-shaped JSON cannot enter
   * this production capture path because they do not retain envelope identity.
   */
  captureRecordedLiveArtifact(
    sessionIdValue: string,
    signingKey: string,
  ): RecordedLiveArtifact {
    const sessionId = safeSessionId(sessionIdValue);
    const record = this.records.get(sessionId);
    if (record === undefined) throw new Error("Unknown live workflow session");
    const session = record.session;
    const pullRequest = session.pullRequest;
    const approval = session.approval;
    const reviewReceipt = session.reviewReceipt;
    const inspection = record.lastInspection;
    const published = record.pullRequestEvidence;
    if (
      session.state !== "READY_TO_MERGE" ||
      session.mode !== "live" ||
      pullRequest === undefined ||
      approval?.decision !== "approved" ||
      approval.invalidatedAt !== undefined ||
      reviewReceipt?.status !== "passed" ||
      inspection === undefined ||
      published === undefined
    ) {
      throw new Error(
        "Recorded Live capture requires one complete current READY_TO_MERGE Live run",
      );
    }

    const authorityEnvelopes: ProviderEnvelope<unknown>[] = [
      ...[...record.generationByCandidate.values()].map(
        (generation) =>
          generation.evidence as ProviderEnvelope<unknown>,
      ),
      ...[...record.daytonaByCandidate.values()].map(
        (daytona) => daytona as ProviderEnvelope<unknown>,
      ),
      record.braintrust.dataset as ProviderEnvelope<unknown>,
      record.braintrust.experiment as ProviderEnvelope<unknown>,
      record.braintrust.trace as ProviderEnvelope<unknown>,
      ...record.stageTraces.map(
        (trace) => trace as ProviderEnvelope<unknown>,
      ),
      record.prepared.publication as ProviderEnvelope<unknown>,
      published as ProviderEnvelope<unknown>,
      inspection as ProviderEnvelope<unknown>,
    ];
    if (
      authorityEnvelopes.some(
        (envelope) => !isOfficialLiveEnvelope(envelope),
      )
    ) {
      throw new Error(
        "Recorded Live capture rejected non-authoritative provider evidence",
      );
    }
    if (
      published.data.number !== pullRequest.number ||
      published.data.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase() ||
      inspection.data.pullNumber !== pullRequest.number ||
      inspection.data.observedPrHeadSha.toLowerCase() !==
        pullRequest.headSha.toLowerCase() ||
      inspection.data.status !== "passed" ||
      !inspection.data.passed
    ) {
      throw new Error(
        "Recorded Live capture rejected stale GitHub or CodeRabbit evidence",
      );
    }

    const snapshot = this.snapshot(record);
    const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
    const fireworksRequestIds = snapshot.candidates.map(
      (candidate) => candidate.generation.requestId,
    );
    const daytonaAttempts = session.sandboxAttemptHistory;
    if (
      daytonaAttempts.length === 0 ||
      daytonaAttempts.some(
        (attempt) =>
          attempt.reservationStatus !== "reserved" ||
          attempt.duplicateSandbox ||
          attempt.duplicateRun ||
          !(
            attempt.disposition === "completed" ||
            (attempt.disposition === "failed-destroyed" && attempt.retryable)
          ),
      )
    ) {
      throw new Error(
        "Recorded Live capture requires every Daytona attempt to be unique and destroyed",
      );
    }
    const daytonaRunIds = daytonaAttempts.map((attempt) => attempt.runId);
    const daytonaSandboxIds = daytonaAttempts.map(
      (attempt) => attempt.sandboxId,
    );
    const codeRabbitIds = [...reviewReceipt.evidenceIds];
    const fireworksCapturedAt =
      [...record.generationByCandidate.values()]
        .map((generation) => liveCapturedAt(generation.evidence))
        .sort()[0] ?? session.createdAt;
    const daytonaCapturedAt =
      [...record.daytonaByCandidate.values()]
        .map((daytona) => liveCapturedAt(daytona))
        .sort()[0] ?? session.createdAt;
    const braintrustCapturedAt = liveCapturedAt(record.braintrust.dataset);
    const githubCapturedAt = liveCapturedAt(published);
    const codeRabbitCapturedAt = liveCapturedAt(inspection);
    const fireworksDurationMs = Math.max(
      0,
      ...snapshot.candidates.map((candidate) => candidate.generation.latencyMs),
    );
    const daytonaDurationMs = Math.max(
      0,
      ...snapshot.candidates.map((candidate) =>
        candidate.validation.commands.reduce(
          (total, command) => total + command.durationMs,
          0,
        ),
      ),
    );
    const progress = this.getProgress(sessionId);
    const capturedAtMs = Math.min(
      Date.parse(session.createdAt),
      ...progress.map((event) => Date.parse(event.at)),
      ...[
        fireworksCapturedAt,
        daytonaCapturedAt,
        braintrustCapturedAt,
        githubCapturedAt,
        codeRabbitCapturedAt,
      ].map(Date.parse),
    );
    const completedAtMs = Math.max(
      Date.parse(session.updatedAt),
      ...progress.map((event) => Date.parse(event.at)),
      Date.parse(fireworksCapturedAt) + fireworksDurationMs,
      Date.parse(daytonaCapturedAt) + daytonaDurationMs,
      Date.parse(braintrustCapturedAt),
      Date.parse(githubCapturedAt),
      Date.parse(codeRabbitCapturedAt),
    );
    if (
      !Number.isFinite(capturedAtMs) ||
      !Number.isFinite(completedAtMs) ||
      completedAtMs < capturedAtMs
    ) {
      throw new Error("Recorded Live capture received invalid provider timing");
    }
    const capturedAt = new Date(capturedAtMs).toISOString();
    const completedAt = new Date(completedAtMs).toISOString();
    const providerCapture = (
      provider: RecordedLiveCaptureInput["providers"][number]["provider"],
      requestIds: readonly string[],
      resources: RecordedLiveCaptureInput["providers"][number]["resources"],
      providerCapturedAt: string,
      durationMs: number,
      cleanup?: RecordedLiveCaptureInput["providers"][number]["cleanup"],
    ): RecordedLiveCaptureInput["providers"][number] => ({
      provider,
      provenance: { mode: "live", kind: "live", verified: true },
      requestIds: unique(requestIds),
      resources,
      capturedAt: providerCapturedAt,
      durationMs,
      ...(cleanup === undefined ? {} : { cleanup }),
    });
    const traceResources = unique([
      record.braintrust.trace.data.traceId,
      ...record.stageTraces.map((trace) => trace.data.traceId),
    ]).map((traceId) => {
      const trace =
        record.braintrust.trace.data.traceId === traceId
          ? record.braintrust.trace.data
          : record.stageTraces.find(
              (candidate) => candidate.data.traceId === traceId,
            )!.data;
      return {
        kind: "trace" as const,
        id: traceId,
        url: trace.traceUrl,
      };
    });
    const providers: RecordedLiveCaptureInput["providers"] = [
      providerCapture(
        "fireworks",
        fireworksRequestIds,
        fireworksRequestIds.map((requestId) => ({
          kind: "response",
          id: requestId,
        })),
        fireworksCapturedAt,
        fireworksDurationMs,
      ),
      providerCapture(
        "daytona",
        [],
        [
          ...daytonaSandboxIds.map((sandboxId) => ({
            kind: "sandbox" as const,
            id: sandboxId,
          })),
          ...daytonaRunIds.map((runId) => ({
            kind: "run" as const,
            id: runId,
          })),
        ],
        daytonaCapturedAt,
        daytonaDurationMs,
        {
          status: "deleted",
          resourceIds: [...daytonaSandboxIds],
          completedAt,
        },
      ),
      providerCapture(
        "braintrust",
        [],
        [
          {
            kind: "dataset",
            id: record.braintrust.dataset.data.datasetId,
            url: record.braintrust.dataset.data.datasetUrl,
          },
          {
            kind: "experiment",
            id: record.braintrust.experiment.data.experimentId,
            url: record.braintrust.experiment.data.experimentUrl,
          },
          ...traceResources,
          ...snapshot.candidates.map((candidate) => ({
            kind: "eval-result" as const,
            id: candidate.scoring.resultId,
          })),
        ],
        braintrustCapturedAt,
        0,
      ),
      providerCapture(
        "github",
        [],
        [
          {
            kind: "repository",
            id: `${this.dependencies.repository.owner}/${this.dependencies.repository.name}`,
            url: session.repository.repoUrl,
          },
          {
            kind: "pull-request",
            id: String(pullRequest.number),
            url: pullRequest.url,
          },
          { kind: "base-sha", id: pullRequest.baseSha },
          { kind: "head-sha", id: pullRequest.headSha },
        ],
        githubCapturedAt,
        0,
      ),
      providerCapture(
        "coderabbit",
        [],
        [
          {
            kind: "pull-request",
            id: String(pullRequest.number),
            url: pullRequest.url,
          },
          { kind: "head-sha", id: pullRequest.headSha },
          ...codeRabbitIds.map((id) => ({
            kind: "review" as const,
            id,
            url: reviewReceipt.reviewUrl,
          })),
        ],
        codeRabbitCapturedAt,
        0,
      ),
    ];

    const eventsSource =
      progress.length > 0
        ? progress
        : [
            {
              sequence: 1,
              at: session.updatedAt,
              state: session.state,
              stage: "ready-to-merge" as const,
              message: "The complete Live run reached READY_TO_MERGE.",
              sessionId,
            },
          ];
    let priorOffset = 0;
    const events = eventsSource.map((event, index) => {
      const rawOffset = Math.max(0, Date.parse(event.at) - capturedAtMs);
      const offsetMs = Math.max(priorOffset, rawOffset);
      priorOffset = offsetMs;
      const nextAt = eventsSource[index + 1]?.at;
      const durationMs =
        nextAt === undefined
          ? Math.max(0, completedAtMs - capturedAtMs - offsetMs)
          : Math.max(0, Date.parse(nextAt) - capturedAtMs - offsetMs);
      return {
        sequence: index + 1,
        offsetMs,
        durationMs,
        state: event.state,
        title: event.stage.replaceAll("-", " ").toUpperCase(),
        summary: event.message,
        provider: "safeflash-orchestrator" as const,
        resourceRefs: [],
      };
    });
    const artifactInput: RecordedLiveCaptureInput = {
      runId: `recorded-${sessionId}`,
      capturedAt,
      completedAt,
      session: {
        id: session.sessionId,
        mode: "live",
        state: "READY_TO_MERGE",
        scenarioId: snapshot.candidates.some(
          (candidate) =>
            !candidate.scoring.eligible &&
            candidate.scoring.weightedScore >
              snapshot.candidates.find(
                (item) =>
                  item.candidate.candidateId ===
                  session.selectedCandidateId,
              )!.scoring.weightedScore,
        )
          ? "unsafe-high-score"
          : "happy-path",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        repository: {
          repoUrl: session.repository.repoUrl,
          baseCommitSha: session.repository.commitSha,
          headCommitSha: pullRequest.headSha,
        },
        incident: {
          title: this.registry.incident.title,
          summary: this.registry.incident.summary,
          severity: "critical",
          temperatureC: this.registry.incident.temperatureC,
          sensorFault: this.registry.incident.sensorFault,
          chargingEnabled: this.registry.incident.chargingEnabled,
          evidence: [...this.registry.incident.evidence],
        },
        policy: {
          name: "SafeFlash P0 Battery Controller Safety Policy",
          version: session.policyVersion,
          invariants: this.registry.policy.invariants.map(
            (description, index) => ({
              id: `p0-invariant-${index + 1}`,
              description,
              hardGate: true,
            }),
          ),
        },
        candidates: snapshot.candidates.map((candidate, index) => {
          const buildCommand = candidate.validation.commands.find((command) =>
            /build/iu.test(command.id),
          );
          return {
            id: candidate.candidate.candidateId,
            label: `Candidate ${String.fromCharCode(
              "A".charCodeAt(0) + index,
            )}`,
            strategy: candidate.candidate.strategy,
            hypothesis: candidate.candidate.hypothesis,
            validationRound: candidate.scoring.validationRound,
            selected:
              candidate.candidate.candidateId === session.selectedCandidateId,
            eliminatedReason: candidate.scoring.eligible
              ? undefined
              : candidate.scoring.hardGateFailures.join("; ") ||
                "A non-compensable hard gate failed.",
            generation: {
              model: candidate.generation.model,
              profile: candidate.evaluationProfile,
              patchDigest: candidate.validation.patchDigest,
            },
            sandbox: {
              id: candidate.validation.sandboxId,
              status: candidate.validation.passed ? "passed" : "failed",
              isolated: true,
            },
            build: {
              status:
                candidate.validation.build.exitCode === null
                  ? "not-run"
                  : candidate.validation.build.exitCode === 0
                    ? "passed"
                    : "failed",
              summary: `Build exit code ${candidate.validation.build.exitCode ?? "not run"}.`,
              exitCode: candidate.validation.build.exitCode,
              artifactHash:
                buildCommand?.artifactHash !== null &&
                buildCommand?.artifactHash !== undefined &&
                /^[0-9a-f]{64}$/u.test(buildCommand.artifactHash)
                  ? buildCommand.artifactHash
                  : undefined,
            },
            tests: {
              status:
                candidate.validation.unitTests.total === 0
                  ? "not-run"
                  : candidate.validation.unitTests.passed ===
                      candidate.validation.unitTests.total &&
                    candidate.validation.regressionTests.passed ===
                      candidate.validation.regressionTests.total
                    ? "passed"
                    : "failed",
              summary: `${candidate.validation.unitTests.passed}/${candidate.validation.unitTests.total} unit and ${candidate.validation.regressionTests.passed}/${candidate.validation.regressionTests.total} regression tests passed.`,
              passed:
                candidate.validation.unitTests.passed +
                candidate.validation.regressionTests.passed,
              total:
                candidate.validation.unitTests.total +
                candidate.validation.regressionTests.total,
            },
            safetyGate: {
              status: candidate.scoring.eligible ? "passed" : "failed",
              summary: `${candidate.validation.safetyTests.passed}/${candidate.validation.safetyTests.total} trusted safety tests passed.`,
              hardGatePassed: candidate.scoring.eligible,
              failures: [...candidate.scoring.hardGateFailures],
            },
            score: {
              weighted: candidate.scoring.weightedScore,
              eligible: candidate.scoring.eligible,
              resultId: candidate.scoring.resultId,
              experimentId: candidate.scoring.experimentId,
              traceId: record.braintrust.trace.data.traceId,
            },
          };
        }),
        selectedCandidateId: session.selectedCandidateId!,
        currentPatchDigest: session.currentPatchDigest!,
        currentEvidenceDigest: session.currentEvidenceDigest!,
        approval: {
          decision: "approved",
          evidenceDigest: approval.evidenceDigest,
          bindingDigest: approval.bindingDigest,
        },
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
          status: "open",
        },
        review: {
          round: Math.max(1, session.validationRound),
          status: "passed",
          headSha: reviewReceipt.headSha,
        },
      },
      providers,
      events,
    };
    return createRecordedLiveArtifact(artifactInput, signingKey);
  }

  /**
   * Revalidates a previously ready claim with read-only GitHub/CodeRabbit
   * evidence. A moved/closed PR, changed base/head, or new blocking review
   * invalidates the old approval and review receipt instead of leaving a
   * cached READY_TO_MERGE view behind.
   */
  async refreshReadyToMerge(
    sessionIdValue: string,
  ): Promise<LiveWorkflowSnapshot> {
    const sessionId = safeSessionId(sessionIdValue);
    return this.runExclusive(sessionId, async () => {
      const record = this.records.get(sessionId);
      if (record === undefined) throw new Error("Unknown live workflow session");
      if (
        record.session.state !== "READY_TO_MERGE" ||
        record.session.pullRequest === undefined ||
        record.session.reviewReceipt === undefined
      ) {
        throw new Error("Live workflow has no ready claim to refresh");
      }
      if (this.dependencies.coderabbit.inspectReview === undefined) {
        throw new ProviderResponseError(
          "coderabbit",
          "Read-only READY freshness verification is unavailable",
          false,
        );
      }

      const pullRequest = record.session.pullRequest;
      const inspection = await this.dependencies.coderabbit.inspectReview({
        sessionId,
        pullNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        expectedBaseRef: pullRequest.baseBranch,
        expectedBaseSha: pullRequest.baseSha,
      });
      record.lastInspection = inspection;

      if (
        inspection.data.status !== "passed" ||
        !inspection.data.passed ||
        inspection.data.timedOut ||
        inspection.data.requiresFullRevalidation
      ) {
        const at = this.now().toISOString();
        const reason =
          `READY evidence invalidated by read-only remote freshness check: ${inspection.data.reason}`;
        const approval =
          record.session.approval === undefined
            ? undefined
            : {
                ...record.session.approval,
                invalidatedAt: at,
                invalidationReason: reason,
              };
        record.session = transitionValidationSession(record.session, {
          type: "FAIL",
          at,
          reason,
          recoverable: false,
          retryAction: "start-new-live-validation",
        });
        record.session = {
          ...record.session,
          approval,
          reviewReceipt: undefined,
          reviewFindings: [],
        };
        this.emitProgress({
          sessionId,
          state: record.session.state,
          stage: "readiness-invalidated",
          provider: "coderabbit",
          candidateId: record.selectedCandidate.candidateId,
          evidenceId: inspection.data.observedPrHeadSha,
          message:
            "The remote PR/review no longer matches the approved evidence; READY was revoked.",
        });
        return this.snapshot(record);
      }

      const refreshedReceipt = createLiveIndependentReviewReceipt(inspection, {
        owner: this.dependencies.repository.owner,
        repository: this.dependencies.repository.name,
      });
      record.session = {
        ...record.session,
        reviewReceipt: refreshedReceipt,
        reviewFindings: inspection.data.findings.map(
          (finding) => finding.finding,
        ),
        updatedAt: refreshedReceipt.capturedAt,
      };
      this.emitProgress({
        sessionId,
        state: record.session.state,
        stage: "readiness-refreshed",
        provider: "coderabbit",
        candidateId: record.selectedCandidate.candidateId,
        evidenceId: refreshedReceipt.evidenceIds.join(","),
        message:
          "Read-only freshness verification confirmed the exact open PR head and CodeRabbit pass.",
      });
      return this.snapshot(record);
    });
  }

  async repairBlockedReview(sessionIdValue: string): Promise<LiveWorkflowSnapshot> {
    const sessionId = safeSessionId(sessionIdValue);
    return this.runExclusive(sessionId, () =>
      this.repairBlockedReviewReserved(sessionId),
    );
  }

  private async repairBlockedReviewReserved(
    sessionId: string,
  ): Promise<LiveWorkflowSnapshot> {
    const record = this.records.get(sessionId);
    if (record === undefined) throw new Error("Unknown live workflow session");
    if (record.session.state === "REVIEW_BLOCKED") {
      if (record.session.pullRequest === undefined) {
        throw new Error("Blocked review has no authoritative pull request");
      }
      const findings = record.session.reviewFindings.filter(
        (finding) => !finding.resolved,
      );
      const repairIncident: RegisteredLiveIncident = {
        ...this.registry.incident,
        title: `Repair CodeRabbit blockers: ${this.registry.incident.title}`,
        summary:
          "Repair the selected safety patch without weakening policy. Address every exact-head CodeRabbit blocker and preserve the original incident fix.",
        evidence: [
          ...this.registry.incident.evidence,
          ...findings.map(
            (finding) =>
              `${finding.severity.toUpperCase()} ${finding.filePath ?? "PR"}: ${finding.title} - ${finding.body}`,
          ),
        ],
      };
      record.repairCheckpoint = {
        blockedPullRequest: record.session.pullRequest,
        repairIncident,
        attempt: 1,
      };
      record.session = transitionValidationSession(record.session, {
        type: "REPAIR_STARTED",
        at: this.now().toISOString(),
      });
      this.emitProgress({
        sessionId,
        state: record.session.state,
        stage: "repair-started",
        provider: "coderabbit",
        candidateId: record.selectedCandidate.candidateId,
        evidenceId: record.session.pullRequest?.headSha,
        message: "Exact-head CodeRabbit blockers were bound into a fresh repair round.",
      });
    }
    const checkpoint = record.repairCheckpoint;
    if (
      checkpoint === undefined ||
      !["REPAIRING_REVIEW_FINDINGS", "REVALIDATING"].includes(
        record.session.state,
      )
    ) {
      throw new Error("Live workflow has no resumable blocked-review repair");
    }
    if (checkpoint.sourceContext === undefined) {
      const sourceContext = await this.dependencies.repository.readSourceContext(
        record.session.sessionId,
        checkpoint.blockedPullRequest.headSha,
      );
      if (
        sourceContext.provider !== "github" ||
        sourceContext.data.commitSha.toLowerCase() !==
          checkpoint.blockedPullRequest.headSha.toLowerCase()
      ) {
        throw new Error("Repair source context is not bound to the blocked PR head");
      }
      checkpoint.sourceContext = sourceContext;
      await this.captureTrace(record.stageTraces, {
        name: "safeflash.repair-source-ingested",
        input: {
          sessionId: record.session.sessionId,
          pullNumber: checkpoint.blockedPullRequest.number,
          blockedHeadSha: checkpoint.blockedPullRequest.headSha,
        },
        output: {
          sourceContextDigest: sourceContext.data.digest,
          filePaths: sourceContext.data.files.map((file) => file.path),
        },
        metadata: { mode: "live", provider: "github", repair: true },
      });
    }
    if (checkpoint.candidate === undefined) {
      const repairRequest = this.requestForCandidate({
        sessionId: record.session.sessionId,
        candidateId: record.selectedCandidate.candidateId,
        strategy: record.selectedCandidate.strategy,
        evaluationProfile: "safety-contender",
        commitSha: checkpoint.blockedPullRequest.headSha,
        incident: checkpoint.repairIncident,
        sourceContext: checkpoint.sourceContext.data,
        seed:
          20_000 + record.session.validationRound * 100 + checkpoint.attempt,
      });
      const repairedEnvelope =
        await this.dependencies.fireworks.generateCandidate(
          repairRequest,
        );
      const repairedCandidate = repairedEnvelope.data.candidate;
      const repairedPatchDigest = sha256(repairedCandidate.unifiedDiff);
      if (repairedPatchDigest === record.session.currentPatchDigest) {
        await this.captureTrace(record.stageTraces, {
          name: "safeflash.repair-attempt-rejected",
          input: {
            sessionId: record.session.sessionId,
            attempt: checkpoint.attempt,
            candidateId: repairedCandidate.candidateId,
          },
          output: {
            reason: "unchanged-patch",
            patchDigest: repairedPatchDigest,
            requestId: repairedEnvelope.data.requestId,
            model: repairedEnvelope.data.model,
            latencyMs: repairedEnvelope.data.latencyMs,
            totalTokens: repairedEnvelope.data.totalTokens ?? null,
          },
          metadata: { mode: "live", provider: "fireworks", repair: true },
        });
        if (checkpoint.attempt >= MAX_REPAIR_ATTEMPTS) {
          record.session = transitionValidationSession(record.session, {
            type: "FAIL",
            at: this.now().toISOString(),
            reason: "Bounded live repair attempts did not produce a changed patch",
            recoverable: false,
          });
          throw new Error("Live repair exhausted after unchanged Fireworks patches");
        }
        checkpoint.attempt += 1;
        return this.repairBlockedReviewReserved(sessionId);
      }
      checkpoint.candidate = repairedCandidate;
      checkpoint.generation = {
        request: repairRequest,
        evidence: repairedEnvelope,
      };
      await this.captureTrace(record.stageTraces, {
        name: "safeflash.fireworks-review-repair-generated",
        input: {
          sessionId: record.session.sessionId,
          attempt: checkpoint.attempt,
          blockedHeadSha: checkpoint.blockedPullRequest.headSha,
          blockerCount: checkpoint.repairIncident.evidence.length,
        },
        output: {
          candidateId: repairedCandidate.candidateId,
          patchDigest: repairedPatchDigest,
          requestId: repairedEnvelope.data.requestId,
          model: repairedEnvelope.data.model,
          latencyMs: repairedEnvelope.data.latencyMs,
          totalTokens: repairedEnvelope.data.totalTokens ?? null,
        },
        metadata: { mode: "live", provider: "fireworks", repair: true },
      });
      this.emitProgress({
        sessionId,
        state: record.session.state,
        stage: "repair-candidate-generated",
        provider: "fireworks",
        candidateId: repairedCandidate.candidateId,
        evidenceId: repairedEnvelope.data.requestId,
        message: "Fireworks generated a changed repair for the exact review findings.",
      });
    }
    const repairedCandidate = checkpoint.candidate;
    if (checkpoint.daytona === undefined) {
      const repairRunId = this.nextDaytonaRunId(record.session.sessionId);
      let daytona: ProviderEnvelope<DaytonaValidationEvidence>;
      try {
        daytona = await this.dependencies.daytona.validateCandidate({
          runId: repairRunId,
          sessionId: record.session.sessionId,
          candidate: repairedCandidate,
          repository: {
            repoUrl: this.dependencies.repository.repoUrl,
            commitSha: checkpoint.blockedPullRequest.headSha,
          },
          policy: {
            policyVersion: this.registry.policy.policyVersion,
            allowedPatchPaths: this.registry.policy.allowedPatchPaths,
            maxChangedFiles: this.registry.policy.maxChangedFiles,
            maxChangedLines: this.registry.policy.maxChangedLines,
          },
        });
      } catch (error) {
        if (error instanceof DaytonaAttemptError) {
          const failedReservation = this.reserveFailedDaytonaAttempt({
            session: record.session,
            error,
            purpose: "review-repair",
            expectedCandidateId: repairedCandidate.candidateId,
            expectedRunId: repairRunId,
          });
          record.session = failedReservation.session;
          if (!failedReservation.accepted) {
            throw new Error(
              "Every Daytona response must reserve a globally unique sandbox ID and run ID",
            );
          }
          if (
            ["cleanup-failed", "failed-retained"].includes(
              error.attempt.disposition,
            )
          ) {
            throw new DaytonaAttemptError({
              attempt: { ...error.attempt },
              retryable: false,
            });
          }
        }
        throw error;
      }
      const repairReservation = this.reserveDaytonaAttempt({
        session: record.session,
        envelope: daytona,
        purpose: "review-repair",
        expectedCandidateId: repairedCandidate.candidateId,
        expectedRunId: repairRunId,
      });
      record.session = repairReservation.session;
      if (!repairReservation.accepted) {
        throw new Error(
          "Every Daytona response must reserve a globally unique sandbox ID and run ID",
        );
      }
      checkpoint.daytona = daytona;
      await this.captureTrace(record.stageTraces, {
        name: "safeflash.daytona-review-repair-validated",
        input: {
          sessionId: record.session.sessionId,
          attempt: checkpoint.attempt,
          candidateId: repairedCandidate.candidateId,
          patchDigest: sha256(repairedCandidate.unifiedDiff),
          baseCommitSha: checkpoint.blockedPullRequest.headSha,
        },
        output: {
          sandboxId: checkpoint.daytona.data.sandboxId,
          runId: checkpoint.daytona.data.runId,
          passed: checkpoint.daytona.data.passed,
          validatedTreeSha: checkpoint.daytona.data.validatedTreeSha ?? null,
        },
        metadata: { mode: "live", provider: "daytona", repair: true },
      });
    }
    const daytona = checkpoint.daytona;
    if (checkpoint.braintrust === undefined) {
      checkpoint.braintrust = await this.evaluateRound({
        session: record.session,
        roundName: `${record.session.sessionId}-repair-${record.session.validationRound + 1}`,
        candidates: [repairedCandidate],
        daytonas: [daytona],
        dataset: record.braintrust.dataset,
      });
      record.stageTraces.push(checkpoint.braintrust.trace);
    }
    const braintrust = checkpoint.braintrust;
    const repairDecision = selectCandidate(
      scoresFromExperiment(braintrust.experiment.data),
      {
        id: `${record.session.sessionId}-repair-attempt-${checkpoint.attempt}`,
        sessionId: record.session.sessionId,
        source: "braintrust",
        sourceVersion: braintrust.experiment.data.experimentId,
        at: this.now().toISOString(),
        selectionPolicyVersion: SELECTION_POLICY_VERSION,
      },
    );
    const repairRanking = repairDecision.rankings.find(
      (ranking) => ranking.candidateId === repairedCandidate.candidateId,
    );
    if (repairRanking?.eligible !== true) {
      await this.captureTrace(record.stageTraces, {
        name: "safeflash.repair-attempt-rejected",
        input: {
          sessionId: record.session.sessionId,
          attempt: checkpoint.attempt,
          candidateId: repairedCandidate.candidateId,
          experimentId: braintrust.experiment.data.experimentId,
        },
        output: {
          reason: "hard-gate-failure",
          hardGateFailures: repairRanking?.hardGateFailures ?? ["missing-ranking"],
          sandboxId: daytona.data.sandboxId,
        },
        metadata: { mode: "live", provider: "braintrust", repair: true },
      });
      if (checkpoint.attempt >= MAX_REPAIR_ATTEMPTS) {
        record.session = transitionValidationSession(record.session, {
          type: "FAIL",
          at: this.now().toISOString(),
          reason: "Bounded live repair attempts failed the hard safety gates",
          recoverable: false,
        });
        throw new Error("Live repair exhausted after hard-gate failures");
      }
      checkpoint.attempt += 1;
      checkpoint.candidate = undefined;
      checkpoint.generation = undefined;
      checkpoint.daytona = undefined;
      checkpoint.braintrust = undefined;
      checkpoint.prepared = undefined;
      return this.repairBlockedReviewReserved(sessionId);
    }
    if (record.session.state === "REPAIRING_REVIEW_FINDINGS") {
      record.session = transitionValidationSession(record.session, {
        type: "REPAIR_GENERATED",
        at: this.now().toISOString(),
        candidateId: repairedCandidate.candidateId,
        patchDigest: sha256(repairedCandidate.unifiedDiff),
      });
    }
    const treeSha = requireGitId(
      "Repaired Daytona tree",
      daytona.data.validatedTreeSha,
    );
    if (checkpoint.prepared === undefined) {
      checkpoint.prepared =
        await this.dependencies.publication.prepareCandidatePublication({
          sessionId: record.session.sessionId,
          baseCommitSha: checkpoint.blockedPullRequest.headSha,
          candidate: repairedCandidate,
          expectedTreeSha: treeSha,
          targetBaseCommitSha: record.session.repository.commitSha,
          committedAt: record.session.updatedAt,
        });
      await this.captureTrace(record.stageTraces, {
        name: "safeflash.github-repair-publication-prepared",
        input: {
          sessionId: record.session.sessionId,
          candidateId: repairedCandidate.candidateId,
          baseCommitSha: checkpoint.blockedPullRequest.headSha,
          targetBaseCommitSha: record.session.repository.commitSha,
        },
        output: {
          headBranch: checkpoint.prepared.headBranch,
          commitSha: checkpoint.prepared.commitSha,
          treeSha: checkpoint.prepared.treeSha,
          publicationDigest:
            checkpoint.prepared.publication.data.publicationDigest,
        },
        metadata: { mode: "live", provider: "github", mutation: false, repair: true },
      });
    }
    const prepared = checkpoint.prepared;
    const receipt = createLiveFullRevalidationReceipt({
      purpose: "review-repair",
      session: record.session,
      policy: policyForReceipt(this.registry.policy),
      candidate: repairedCandidate,
      commitSha: prepared.commitSha,
      commitTreeSha: prepared.treeSha,
      daytona,
      braintrust: braintrust.experiment,
      generations: [
        {
          ...checkpoint.generation!,
          sourceContext: checkpoint.sourceContext!,
        },
      ],
      publication: prepared.publication,
    });
    await this.captureTrace(record.stageTraces, {
      name: "safeflash.review-repair-revalidated",
      input: {
        sessionId: record.session.sessionId,
        candidateId: receipt.candidateId,
        patchDigest: receipt.patchDigest,
        attempt: checkpoint.attempt,
      },
      output: {
        evidenceDigest: receipt.evidenceDigest,
        commitSha: receipt.commitSha,
        validatedTreeSha: receipt.validatedTreeSha,
        sandboxId: receipt.sandboxId,
        braintrustExperimentId: receipt.braintrustExperimentId,
        eligible: receipt.candidateEligible,
      },
      metadata: { mode: "live", stage: "full-revalidation", repair: true },
    });
    record.session = transitionValidationSession(record.session, {
      type: "REVALIDATION_PASSED",
      at: this.now().toISOString(),
      receipt,
    });
    this.emitProgress({
      sessionId,
      state: record.session.state,
      stage: "repair-revalidation-finished",
      provider: "braintrust",
      candidateId: repairedCandidate.candidateId,
      evidenceId: receipt.evidenceDigest,
      message: "Fresh Daytona and Braintrust evidence invalidated the old approval and requires reapproval.",
    });
    record.candidates.set(repairedCandidate.candidateId, repairedCandidate);
    record.daytonaByCandidate.set(repairedCandidate.candidateId, daytona);
    record.generationByCandidate.set(
      repairedCandidate.candidateId,
      checkpoint.generation!,
    );
    const repairedEvaluation = braintrust.experiment.data.candidateResults.find(
      (result) => result.candidateId === repairedCandidate.candidateId,
    );
    if (repairedEvaluation === undefined) {
      throw new Error("Repair Braintrust result is missing after attestation");
    }
    record.evaluationByCandidate.set(
      repairedCandidate.candidateId,
      repairedEvaluation,
    );
    record.evaluationProvenanceByCandidate.set(
      repairedCandidate.candidateId,
      {
        resultId: repairedEvaluation.resultId,
        experimentId: braintrust.experiment.data.experimentId,
        experimentName: braintrust.experiment.data.experimentName,
        experimentUrl: braintrust.experiment.data.experimentUrl,
        traceId: braintrust.trace.data.traceId,
        traceUrl: braintrust.trace.data.traceUrl,
        validationRound: record.session.validationRound,
        capturedAt: liveCapturedAt(braintrust.experiment),
      },
    );
    record.braintrust = braintrust;
    record.selectedCandidate = repairedCandidate;
    record.prepared = prepared;
    record.decision = selectCandidate(
      scoresFromExperiment(braintrust.experiment.data),
      {
        id: `${record.session.sessionId}-repair-decision-${record.session.validationRound}`,
        sessionId: record.session.sessionId,
        source: "braintrust",
        sourceVersion: braintrust.experiment.data.experimentId,
        at: this.now().toISOString(),
        selectionPolicyVersion: SELECTION_POLICY_VERSION,
      },
    );
    const repairedRanking = record.decision.rankings.find(
      (ranking) => ranking.candidateId === repairedCandidate.candidateId,
    );
    if (repairedRanking === undefined) {
      throw new Error("Repair ranking is missing after attestation");
    }
    record.rankingByCandidate.set(
      repairedCandidate.candidateId,
      repairedRanking,
    );
    record.repairCheckpoint = undefined;
    return this.snapshot(record);
  }

  getSession(sessionIdValue: string): ValidationSession {
    const record = this.records.get(safeSessionId(sessionIdValue));
    if (record === undefined) throw new Error("Unknown live workflow session");
    return structuredClone(record.session);
  }

  private async runExclusive<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.activeOperations.has(sessionId)) {
      throw new Error("Another live workflow operation is already in progress");
    }
    this.activeOperations.add(sessionId);
    try {
      return await operation();
    } finally {
      this.activeOperations.delete(sessionId);
    }
  }
}

export type LiveApproval = HumanApproval;

const P0_SOURCE_CONTEXT_PATHS = Object.freeze([
  "fixtures/battery-controller/include/battery_controller.h",
  "fixtures/battery-controller/src/battery_controller.c",
] as const);

class GitHubCandidatePublicationPort implements CandidatePublicationPort {
  constructor(
    private readonly github: GitHubAdapter,
    private readonly config: GitHubConfig,
    private readonly authority: PublishAuthorizationAuthority,
  ) {}

  async prepareCandidatePublication(input: {
    sessionId: string;
    baseCommitSha: string;
    candidate: CandidatePatch;
    expectedTreeSha: string;
    targetBaseCommitSha: string;
    committedAt: string;
  }): Promise<PreparedCandidatePublication> {
    const publication = await this.github.prepareCandidatePublication({
      sessionId: input.sessionId,
      candidate: input.candidate,
      baseCommitSha: input.baseCommitSha,
      targetBaseCommitSha: input.targetBaseCommitSha,
      expectedTreeSha: input.expectedTreeSha,
      committedAt: input.committedAt,
    });
    const data = publication.data;
    if (
      publication.provider !== "github" ||
      data.sessionId !== input.sessionId ||
      data.candidateId !== input.candidate.candidateId ||
      data.baseCommitSha.toLowerCase() !== input.baseCommitSha.toLowerCase() ||
      data.targetBaseCommitSha.toLowerCase() !==
        input.targetBaseCommitSha.toLowerCase() ||
      data.treeSha.toLowerCase() !== input.expectedTreeSha.toLowerCase()
    ) {
      throw new Error("Prepared GitHub publication is not bound to the live session");
    }
    return {
      headBranch: data.headBranch,
      baseCommitSha: data.baseCommitSha,
      commitSha: data.commitSha,
      treeSha: data.treeSha,
      publication,
    };
  }

  async publishApprovedCandidate(input: {
    session: ValidationSession;
    candidate: CandidatePatch;
    prepared: PreparedCandidatePublication;
    incident: RegisteredLiveIncident;
    tests: readonly string[];
  }): Promise<ProviderEnvelope<PullRequestRecord>> {
    const session = input.session;
    const approval = session.approval;
    const validationReceipt = session.lastRevalidation;
    if (
      session.state !== "CREATING_PULL_REQUEST" ||
      approval === undefined ||
      validationReceipt === undefined ||
      session.selectedCandidateId === undefined ||
      session.currentPatchDigest === undefined ||
      session.currentEvidenceDigest === undefined ||
      session.currentCommitSha === undefined
    ) {
      throw new Error("Authoritative session is incomplete for GitHub publication");
    }
    const currentBinding = {
      candidateId: session.selectedCandidateId,
      patchDigest: session.currentPatchDigest,
      evidenceDigest: session.currentEvidenceDigest,
      policyVersion: session.policyVersion,
      commitSha: session.currentCommitSha,
      pullRequestTarget: session.pullRequestTarget,
    };
    const request = {
      sessionId: session.sessionId,
      candidateId: session.selectedCandidateId,
      headBranch: input.prepared.headBranch,
      expectedHeadSha: session.currentCommitSha,
      title: `[SafeFlash] ${input.incident.title}`,
      description: {
        incident: input.incident.summary,
        selectedStrategy: input.candidate.strategy,
        tests: input.tests,
        braintrustExperimentUrl: validationReceipt.braintrustExperimentRef,
        daytonaEvidenceRef: validationReceipt.daytonaEvidenceRef,
        evidenceDigest: session.currentEvidenceDigest,
      },
      validationReceipt,
      approval,
      currentBinding,
      publication: input.prepared.publication.data,
      draft: false,
    };
    const publishAuthorization = mintPullRequestPublishAuthorization(
      this.authority,
      session,
      request,
      this.config,
    );
    return this.github.createOrGetPullRequest({
      ...request,
      publishAuthorization,
    });
  }
}

/**
 * Server-only production composition. Every provider is configured up front;
 * missing credentials abort before the first network call and no mock/local
 * adapter is available on this path.
 */
export function createProductionLiveSafetyWorkflow(): LiveSafetyWorkflow {
  if (process.env.SAFEFLASH_ALLOW_LIVE !== "true") {
    throw new Error(
      "SAFEFLASH_ALLOW_LIVE=true is required for the production live workflow",
    );
  }
  // Aggregate configuration preflight before constructing or calling clients.
  const fireworksConfig = readFireworksConfig(process.env, "live");
  const daytonaConfig = readDaytonaConfig(process.env, "live");
  const braintrustConfig = readBraintrustConfig(process.env, "live");
  const githubConfig = readGitHubConfig(process.env, "live");
  const coderabbitConfig = readCodeRabbitConfig(process.env, "live");
  const authority = readPublishAuthorizationService();
  if (
    coderabbitConfig.owner !== githubConfig.owner ||
    coderabbitConfig.repository !== githubConfig.repository ||
    coderabbitConfig.baseBranch !== githubConfig.baseBranch
  ) {
    throw new Error("GitHub and CodeRabbit repository configuration diverged");
  }
  const github = new GitHubAdapter(
    githubConfig,
    undefined,
    undefined,
    authority,
  );
  const publication = new GitHubCandidatePublicationPort(
    github,
    githubConfig,
    authority,
  );
  return new LiveSafetyWorkflow({
    fireworks: new FireworksAdapter(fireworksConfig),
    daytona: new DaytonaAdapter(daytonaConfig),
    braintrust: new BraintrustAdapter(braintrustConfig),
    publication,
    coderabbit: new CodeRabbitAdapter(coderabbitConfig),
    repository: {
      owner: githubConfig.owner,
      name: githubConfig.repository,
      baseBranch: githubConfig.baseBranch,
      repoUrl: `https://github.com/${githubConfig.owner}/${githubConfig.repository}.git`,
      async resolveBaseCommit() {
        const readiness = await github.smokeReadiness();
        return readiness.data.baseHeadSha;
      },
      readSourceContext(sessionId, commitSha) {
        return github.readCandidateSourceContext({
          sessionId,
          commitSha,
          allowedPaths: P0_SOURCE_CONTEXT_PATHS,
          maxBytes: 192 * 1024,
        });
      },
    },
  });
}
