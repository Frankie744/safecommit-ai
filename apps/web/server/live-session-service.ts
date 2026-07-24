import { randomUUID } from "node:crypto";

import {
  P0_LIVE_WORKFLOW_REGISTRY,
  createProductionLiveSafetyWorkflow,
  demoScenario,
  type LiveSafetyWorkflow,
  type LiveWorkflowProgressEvent,
  type LiveWorkflowSnapshot,
} from "@safeflash/orchestrator";

import type {
  CandidateEvidenceView,
  CandidateView,
  EvidenceProvenance,
  ProviderEvidenceView,
  ProvenanceKind,
  SessionView,
  TimelineEventView,
} from "../lib/session-types";
import {
  configuredApproverId,
  CreateSessionRequestSchema,
  DecisionRequestSchema,
  SessionServiceError,
} from "./session-service";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const FULL_GIT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PRODUCTION_LIVE_TRUST = Symbol("SafeFlashProductionLiveTrust");

export type LiveWorkflowPort = Pick<
  LiveSafetyWorkflow,
  | "startTournament"
  | "recordHumanDecision"
  | "publishApprovedAndReview"
  | "repairBlockedReview"
  | "subscribeProgress"
  | "getProgress"
> &
  Partial<Pick<LiveSafetyWorkflow, "refreshReadyToMerge">>;

export interface LiveSessionServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  readyRefreshIntervalMs?: number;
}

interface LiveSessionRecord {
  view: SessionView;
  snapshot?: LiveWorkflowSnapshot;
  operation?: Promise<void>;
  resume?: () => void;
  unsubscribeProgress?: () => void;
  lastProgressSequence?: number;
  lastReadyRefreshAtMs?: number;
  readyRefreshOperation?: Promise<void>;
}

interface ResumableStage<T> {
  operation: () => Promise<T>;
  resume: () => void;
  reason: string;
  retryAction: string;
}

function assertSafeSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionServiceError(
      400,
      "INVALID_SESSION_ID",
      "Invalid session identifier.",
    );
  }
  return sessionId;
}

function cloneView(view: SessionView): SessionView {
  return structuredClone(view);
}

function candidateLabel(index: number): string {
  return `Candidate ${String.fromCharCode("A".charCodeAt(0) + index)}`;
}

function stateCopy(state: string): { title: string; summary: string } {
  switch (state) {
    case "INGESTING_REPOSITORY":
      return {
        title: "LIVE SESSION ACCEPTED",
        summary:
          "The server accepted a live tournament and is reading an immutable GitHub revision.",
      };
    case "AWAITING_HUMAN_APPROVAL":
      return {
        title: "BOUND CANDIDATE AWAITS HUMAN APPROVAL",
        summary:
          "Real provider evidence selected a candidate. PR mutation remains blocked on the exact commit, patch, evidence, and policy binding.",
      };
    case "CREATING_PULL_REQUEST":
      return {
        title: "APPROVED PUBLICATION IN PROGRESS",
        summary:
          "The server is publishing the approval-bound commit and waiting for independent review.",
      };
    case "REVIEW_BLOCKED":
      return {
        title: "CODERABBIT BLOCKED THE HEAD",
        summary:
          "Independent review reported unresolved findings against the exact pull-request head.",
      };
    case "REPAIRING_REVIEW_FINDINGS":
      return {
        title: "REPAIR AND FULL REVALIDATION IN PROGRESS",
        summary:
          "A bounded repair is re-entering Fireworks, Daytona, and Braintrust before any new approval can be accepted.",
      };
    case "READY_TO_MERGE":
      return {
        title: "READY FOR HUMAN MERGE",
        summary:
          "The exact approved PR head passed independent review. SafeFlash never merges automatically.",
      };
    case "FAILED":
      return {
        title: "LIVE WORKFLOW FAILED CLOSED",
        summary:
          "A live workflow stage failed. No unverified provider result or merge-ready claim was emitted.",
      };
    default:
      return {
        title: state.replaceAll("_", " "),
        summary: "The server recorded a live workflow state transition.",
      };
  }
}

function appendEvent(
  view: SessionView,
  state: string,
  occurredAt: string,
  provenance: EvidenceProvenance,
  copy = stateCopy(state),
): SessionView {
  const previous = view.events.at(-1);
  if (
    previous?.state === state &&
    previous.title === copy.title &&
    previous.occurredAt === occurredAt
  ) {
    return view;
  }
  const sequence = view.events.length + 1;
  const event: TimelineEventView = {
    id: `${view.id}-web-live-event-${sequence}`,
    sequence,
    state,
    title: copy.title,
    summary: copy.summary,
    occurredAt,
    provenance: { ...provenance },
  };
  return { ...view, state, updatedAt: occurredAt, events: [...view.events, event] };
}

function evidenceView(
  status: CandidateEvidenceView["status"],
  summary: string,
  provenance: EvidenceProvenance,
  artifactHash?: string,
): CandidateEvidenceView {
  return {
    status,
    summary,
    artifactHash,
    provenance: { ...provenance },
  };
}

function validateSnapshot(snapshot: LiveWorkflowSnapshot, sessionId: string): void {
  const { session, decision, selectedCandidate, providerEvidence } = snapshot;
  const candidateIds = snapshot.candidates.map(
    (summary) => summary.candidate.candidateId,
  );
  const selectedSummary = snapshot.candidates.find(
    (summary) => summary.candidate.candidateId === selectedCandidate.candidateId,
  );
  if (
    session.sessionId !== sessionId ||
    session.mode !== "live" ||
    session.selectedCandidateId === undefined ||
    session.currentPatchDigest === undefined ||
    session.currentEvidenceDigest === undefined ||
    session.currentCommitSha === undefined ||
    !FULL_GIT_ID_PATTERN.test(session.repository.commitSha) ||
    !FULL_GIT_ID_PATTERN.test(session.currentCommitSha) ||
    !SHA256_PATTERN.test(session.currentPatchDigest) ||
    !SHA256_PATTERN.test(session.currentEvidenceDigest) ||
    session.selectedCandidateId !== selectedCandidate.candidateId ||
    decision.winnerCandidateId !== selectedCandidate.candidateId ||
    candidateIds.length < 3 ||
    new Set(candidateIds).size !== candidateIds.length ||
    session.candidateIds.some((candidateId) => !candidateIds.includes(candidateId)) ||
    !decision.rankings.some(
      (ranking) =>
        ranking.candidateId === selectedCandidate.candidateId &&
        ranking.eligible,
    ) ||
    selectedSummary === undefined ||
    !selectedSummary.validation.passed ||
    !selectedSummary.scoring.eligible ||
    selectedSummary.validation.sandboxId !== providerEvidence.daytonaSandboxId ||
    selectedSummary.validation.runId !== providerEvidence.daytonaRunId ||
    selectedSummary.validation.validatedTreeSha?.toLowerCase() !==
      providerEvidence.preparedTreeSha.toLowerCase() ||
    providerEvidence.preparedCommitSha.toLowerCase() !==
      session.currentCommitSha.toLowerCase() ||
    !FULL_GIT_ID_PATTERN.test(providerEvidence.preparedTreeSha) ||
    providerEvidence.daytonaSandboxId.length === 0 ||
    providerEvidence.daytonaRunId.length === 0 ||
    providerEvidence.braintrustExperimentUrl.length === 0 ||
    providerEvidence.braintrustTraceUrl.length === 0
  ) {
    throw new Error("Live workflow returned an incomplete or inconsistent snapshot");
  }
}

export class LiveSessionService {
  private readonly records = new Map<string, LiveSessionRecord>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly readyRefreshIntervalMs: number;
  private readonly providerKind: ProvenanceKind;
  private readonly providerVerified: boolean;

  constructor(
    private readonly workflow: LiveWorkflowPort,
    options: LiveSessionServiceOptions = {},
    trust?: typeof PRODUCTION_LIVE_TRUST,
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `live-web-${randomUUID()}`);
    this.readyRefreshIntervalMs = Math.max(
      1_000,
      options.readyRefreshIntervalMs ?? 15_000,
    );
    this.providerKind =
      trust === PRODUCTION_LIVE_TRUST ? "live" : "local-test";
    this.providerVerified = trust === PRODUCTION_LIVE_TRUST;
  }

  private providerProvenance(
    provider: string,
    input: { externalId?: string; capturedAt?: string; url?: string } = {},
  ): EvidenceProvenance {
    return {
      kind: this.providerKind,
      provider,
      verified: this.providerVerified,
      ...input,
    };
  }

  private orchestratorProvenance(capturedAt?: string): EvidenceProvenance {
    return {
      kind: this.providerVerified ? "server-owned" : "local-test",
      provider: "safeflash-orchestrator",
      verified: this.providerVerified,
      capturedAt,
    };
  }

  private placeholder(
    sessionId: string,
    at: string,
    scenarioId: "happy-path" | "unsafe-high-score",
  ): SessionView {
    const orchestrator = this.orchestratorProvenance(at);
    const view: SessionView = {
      id: sessionId,
      mode: "live",
      state: "INGESTING_REPOSITORY",
      scenario: { ...demoScenario(scenarioId) },
      createdAt: at,
      updatedAt: at,
      repository: { commitSha: "unreported" },
      currentCommitSha: "unreported",
      incident: {
        title: P0_LIVE_WORKFLOW_REGISTRY.incident.title,
        summary: P0_LIVE_WORKFLOW_REGISTRY.incident.summary,
        severity: "critical",
        temperatureC: P0_LIVE_WORKFLOW_REGISTRY.incident.temperatureC,
        sensorFault: P0_LIVE_WORKFLOW_REGISTRY.incident.sensorFault,
        chargingEnabled: P0_LIVE_WORKFLOW_REGISTRY.incident.chargingEnabled,
        evidence: [...P0_LIVE_WORKFLOW_REGISTRY.incident.evidence],
        provenance: { ...orchestrator },
      },
      policy: {
        name: "SafeFlash P0 Battery Controller Safety Policy",
        version: P0_LIVE_WORKFLOW_REGISTRY.policy.policyVersion,
        invariants: P0_LIVE_WORKFLOW_REGISTRY.policy.invariants.map(
          (description, index) => ({
            id: `p0-invariant-${index + 1}`,
            description,
            hardGate: true,
          }),
        ),
        provenance: { ...orchestrator },
      },
      candidates: [],
      providerEvidence: [
        "fireworks",
        "daytona",
        "braintrust",
        "github",
        "coderabbit",
      ].map((provider) => ({
        provider,
        operation: "live workflow pending",
        status: "pending",
        resourceIds: [],
        urls: [],
        provenance: this.pendingProvenance(provider, at),
      })),
      cleanup: {
        status: "pending",
        sandboxIds: [],
        summary: "No Daytona sandbox receipt has been observed yet.",
        provenance: this.pendingProvenance("daytona", at),
      },
      events: [],
    };
    return appendEvent(view, view.state, at, orchestrator);
  }

  private candidateViews(snapshot: LiveWorkflowSnapshot): readonly CandidateView[] {
    const selectedId = snapshot.selectedCandidate.candidateId;
    return snapshot.candidates.map((summary, index) => {
      const { candidate, generation, validation, scoring } = summary;
      const selected = candidate.candidateId === selectedId;
      const failures = [
        ...scoring.hardGateFailures,
        ...validation.safetyTests.criticalFailures,
        ...validation.integrity.violations,
      ].filter((failure, failureIndex, all) => all.indexOf(failure) === failureIndex);
      const daytona = this.providerProvenance("daytona", {
        externalId: validation.sandboxId,
        capturedAt: validation.capturedAt,
      });
      const braintrust = this.providerProvenance("braintrust", {
        externalId: scoring.resultId,
        capturedAt: scoring.capturedAt,
        url: scoring.experimentUrl,
      });
      const buildCommand = validation.commands.find((command) =>
        /build/i.test(command.id),
      );
      const buildStatus =
        validation.build.exitCode === null
          ? "not-run"
          : validation.build.exitCode === 0
            ? "passed"
            : "failed";
      const unitStatus =
        validation.unitTests.total === 0
          ? "not-run"
          : validation.unitTests.passed === validation.unitTests.total
            ? "passed"
            : "failed";
      return {
        id: candidate.candidateId,
        label: candidateLabel(index),
        strategy: candidate.strategy,
        hypothesis: candidate.hypothesis,
        validationRound: scoring.validationRound,
        generation: {
          model: generation.model,
          profile: summary.evaluationProfile,
          patchDigest: validation.patchDigest,
          provenance: this.providerProvenance("fireworks", {
            externalId: generation.requestId,
            capturedAt: generation.capturedAt,
          }),
        },
        selected,
        eliminatedReason: scoring.eligible
          ? undefined
          : failures.join("; ") || "A non-compensable safety gate failed.",
        sandbox: {
          id: validation.sandboxId,
          status: validation.passed ? "passed" : "failed",
          isolated: true,
          provenance: { ...daytona },
        },
        build: evidenceView(
          buildStatus,
          validation.build.exitCode === 0
            ? `Daytona build passed for the Fireworks ${generation.model} candidate.`
            : `Daytona build exit code: ${validation.build.exitCode ?? "not run"}.`,
          daytona,
          buildCommand?.artifactHash ?? validation.validatedTreeSha ?? undefined,
        ),
        tests: {
          ...evidenceView(
            unitStatus,
            `${validation.unitTests.passed}/${validation.unitTests.total} unit tests and ${validation.regressionTests.passed}/${validation.regressionTests.total} regression tests passed in Daytona.`,
            daytona,
          ),
          passed: validation.unitTests.passed,
          total: validation.unitTests.total,
        },
        safetyGate: {
          ...evidenceView(
            scoring.eligible ? "passed" : "failed",
            `${validation.safetyTests.passed}/${validation.safetyTests.total} trusted safety tests passed; integrity ${validation.integrity.passed ? "passed" : "failed"}.`,
            braintrust,
          ),
          hardGatePassed: scoring.eligible,
          failures,
        },
        score: {
          weighted: scoring.weightedScore,
          eligible: scoring.eligible,
          experimentId: scoring.experimentId,
          traceId: scoring.traceId,
          resultId: scoring.resultId,
          provenance: { ...braintrust },
        },
        diff: candidate.unifiedDiff,
      };
    });
  }

  private providerEvidence(
    snapshot: LiveWorkflowSnapshot,
  ): readonly ProviderEvidenceView[] {
    const { session, candidates, providerEvidence } = snapshot;
    const fireworksRequestIds = candidates
      .map((candidate) => candidate.generation.requestId)
      .filter((id): id is string => Boolean(id));
    const daytonaResources = candidates.flatMap((candidate) => [
      `sandbox:${candidate.validation.sandboxId}`,
      `run:${candidate.validation.runId}`,
    ]);
    const braintrustResources = [
      `dataset:${providerEvidence.braintrustDatasetId}`,
      `experiment:${providerEvidence.braintrustExperimentId}`,
      `trace:${providerEvidence.braintrustTraceId}`,
      ...providerEvidence.stageTraceIds.map((id) => `trace:${id}`),
      ...candidates.flatMap((candidate) => [
        `experiment:${candidate.scoring.experimentId}`,
        `trace:${candidate.scoring.traceId}`,
        `eval-result:${candidate.scoring.resultId}`,
      ]),
    ];
    const unique = (values: readonly string[]) => [...new Set(values)];
    const urls = (values: readonly (string | undefined)[]) =>
      unique(values.filter((value): value is string => Boolean(value)));
    const githubResources =
      session.pullRequest === undefined
        ? []
        : [
            `repository:${session.pullRequest.owner}/${session.pullRequest.repository}`,
            `pull-request:${session.pullRequest.number}`,
            `base:${session.pullRequest.baseBranch}@${session.pullRequest.baseSha}`,
            `head:${session.pullRequest.headSha}`,
          ];
    const codeRabbitResources =
      session.reviewReceipt === undefined
        ? []
        : [
            `pull-request:${session.reviewReceipt.pullNumber}`,
            `head:${session.reviewReceipt.headSha}`,
            ...session.reviewReceipt.evidenceIds.map(
              (id) => `review-evidence:${id}`,
            ),
          ];
    return [
      {
        provider: "fireworks",
        operation: "CandidatePatch structured generation",
        status: "passed",
        requestId: fireworksRequestIds[0],
        requestIds: fireworksRequestIds,
        resourceIds: unique(
          fireworksRequestIds.map((id) => `request:${id}`),
        ),
        urls: [],
        capturedAt: candidates[0]?.generation.capturedAt,
        provenance: this.providerProvenance("fireworks", {
          externalId: fireworksRequestIds.join(","),
          capturedAt: candidates[0]?.generation.capturedAt,
        }),
      },
      {
        provider: "daytona",
        operation: "ephemeral sandbox create, execute, delete",
        status:
          session.sandboxAttemptHistory.some(
            (attempt) =>
              attempt.disposition === "cleanup-failed" ||
              attempt.disposition === "failed-retained",
          )
            ? "failed"
            : "passed",
        resourceIds: unique(daytonaResources),
        urls: [],
        capturedAt: candidates[0]?.validation.capturedAt,
        provenance: this.providerProvenance("daytona", {
          externalId: unique(daytonaResources).join(","),
          capturedAt: candidates[0]?.validation.capturedAt,
        }),
      },
      {
        provider: "braintrust",
        operation: "dataset, experiment, trace, and hard-gate scores",
        status: "passed",
        resourceIds: unique(braintrustResources),
        urls: urls([
          providerEvidence.braintrustDatasetUrl,
          providerEvidence.braintrustExperimentUrl,
          providerEvidence.braintrustTraceUrl,
          ...providerEvidence.stageTraceUrls,
          ...candidates.flatMap((candidate) => [
            candidate.scoring.experimentUrl,
            candidate.scoring.traceUrl,
          ]),
        ]),
        capturedAt: candidates[0]?.scoring.capturedAt,
        provenance: this.providerProvenance("braintrust", {
          externalId: unique(braintrustResources).join(","),
          capturedAt: candidates[0]?.scoring.capturedAt,
          url: providerEvidence.braintrustExperimentUrl,
        }),
      },
      {
        provider: "github",
        operation: "exact repository, base, head, and pull request",
        status: session.pullRequest === undefined ? "pending" : "passed",
        resourceIds: githubResources,
        urls: urls([session.pullRequest?.url]),
        capturedAt: session.pullRequest?.updatedAt,
        provenance:
          session.pullRequest === undefined
            ? this.pendingProvenance("github", session.updatedAt)
            : this.providerProvenance("github", {
                externalId: githubResources.join(","),
                capturedAt: session.pullRequest.updatedAt,
                url: session.pullRequest.url,
              }),
      },
      {
        provider: "coderabbit",
        operation: "exact PR head independent review",
        status:
          session.reviewReceipt === undefined
            ? "pending"
            : session.reviewReceipt.status === "passed"
              ? "passed"
              : "failed",
        resourceIds: codeRabbitResources,
        urls: urls([session.reviewReceipt?.reviewUrl]),
        capturedAt: session.reviewReceipt?.capturedAt,
        provenance:
          session.reviewReceipt === undefined
            ? this.pendingProvenance("coderabbit", session.updatedAt)
            : this.providerProvenance("coderabbit", {
                externalId: codeRabbitResources.join(","),
                capturedAt: session.reviewReceipt.capturedAt,
                url: session.reviewReceipt.reviewUrl,
              }),
      },
    ];
  }

  private cleanupView(
    snapshot: LiveWorkflowSnapshot,
  ): NonNullable<SessionView["cleanup"]> {
    const attempts = snapshot.session.sandboxAttemptHistory;
    const sandboxIds = [...new Set(attempts.map((attempt) => attempt.sandboxId))];
    const failed = attempts.some(
      (attempt) =>
        attempt.disposition === "cleanup-failed" ||
        attempt.disposition === "failed-retained",
    );
    return {
      status: failed ? "failed" : attempts.length === 0 ? "pending" : "deleted",
      sandboxIds,
      summary: failed
        ? "At least one Daytona sandbox lacks a deletion receipt; the workflow is failed closed."
        : attempts.length === 0
          ? "No Daytona sandbox receipt has been observed yet."
          : `Deletion was confirmed for ${sandboxIds.length} unique Daytona sandbox resource(s).`,
      provenance:
        attempts.length === 0
          ? this.pendingProvenance("daytona", snapshot.session.updatedAt)
          : this.providerProvenance("daytona", {
              externalId: sandboxIds.join(","),
              capturedAt: attempts.at(-1)?.capturedAt,
            }),
    };
  }

  private mapSnapshot(
    snapshot: LiveWorkflowSnapshot,
    previous: SessionView,
  ): SessionView {
    validateSnapshot(snapshot, previous.id);
    const { session } = snapshot;
    const orchestrator = this.orchestratorProvenance(session.updatedAt);
    return {
      id: session.sessionId,
      mode: "live",
      state: session.state,
      scenario: previous.scenario,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      repository: {
        repoUrl: session.repository.repoUrl,
        commitSha: session.repository.commitSha,
      },
      currentCommitSha: session.currentCommitSha!,
      incident: {
        ...previous.incident,
        provenance: { ...orchestrator },
      },
      policy: {
        ...previous.policy,
        version: session.policyVersion,
        provenance: { ...orchestrator },
      },
      candidates: this.candidateViews(snapshot),
      selectedCandidateId: session.selectedCandidateId,
      currentPatchDigest: session.currentPatchDigest,
      currentEvidenceDigest: session.currentEvidenceDigest,
      approval:
        session.approval === undefined
          ? undefined
          : {
              decision: session.approval.decision,
              approverDisplayName: session.approval.approverDisplayName,
              evidenceDigest: session.approval.evidenceDigest,
              bindingDigest: session.approval.bindingDigest,
              invalidatedAt: session.approval.invalidatedAt,
            },
      pullRequest:
        session.pullRequest === undefined
          ? undefined
          : {
              number: session.pullRequest.number,
              url: session.pullRequest.url,
              status: session.pullRequest.status,
              provenance: this.providerProvenance("github", {
                externalId: String(session.pullRequest.number),
                capturedAt: session.pullRequest.updatedAt,
                url: session.pullRequest.url,
              }),
            },
      review:
        session.reviewReceipt === undefined && session.state === "FAILED"
          ? undefined
          : session.reviewReceipt === undefined &&
        !["AWAITING_CODERABBIT", "REVIEW_BLOCKED", "REVIEW_PASSED"].includes(
          session.state,
        )
          ? previous.review
          : session.reviewReceipt === undefined
            ? {
                round: session.validationRound,
                status: "pending",
                headSha: session.pullRequest?.headSha,
                findings: [],
                provenance: this.providerProvenance("coderabbit", {
                  capturedAt: session.updatedAt,
                }),
              }
            : {
                round:
                  previous.review?.headSha === session.reviewReceipt.headSha
                    ? previous.review.round
                    : session.validationRound,
                status:
                  session.reviewReceipt.status === "passed"
                    ? "passed"
                    : "blocked",
                headSha: session.reviewReceipt.headSha,
                findings: session.reviewFindings.map((finding) => ({
                  id: finding.id,
                  severity: finding.severity,
                  title: finding.title,
                  body: finding.body,
                  filePath: finding.filePath,
                  line: finding.line,
                  resolved: finding.resolved,
                  url: finding.reviewUrl,
                })),
                provenance: this.providerProvenance("coderabbit", {
                  externalId: session.reviewReceipt.evidenceIds.join(","),
                  capturedAt: session.reviewReceipt.capturedAt,
                  url: session.reviewReceipt.reviewUrl,
                }),
              },
      failure:
        session.failure === undefined
          ? previous.failure
          : {
              reason: session.failure.reason,
              recoverable: session.failure.recoverable,
              retryAction: session.failure.retryAction,
            },
      providerEvidence: this.providerEvidence(snapshot),
      cleanup: this.cleanupView(snapshot),
      events: previous.events,
    };
  }

  private updateFromSnapshot(
    record: LiveSessionRecord,
    snapshot: LiveWorkflowSnapshot,
    copy?: { title: string; summary: string },
  ): void {
    const mapped = this.mapSnapshot(snapshot, record.view);
    record.snapshot = structuredClone(snapshot);
    record.view =
      copy === undefined && mapped.events.at(-1)?.state === mapped.state
        ? mapped
        : appendEvent(
            mapped,
            mapped.state,
            mapped.updatedAt ?? this.now().toISOString(),
            this.orchestratorProvenance(mapped.updatedAt),
            copy,
          );
  }

  private pendingProvenance(provider: string, capturedAt: string): EvidenceProvenance {
    return {
      kind: "unknown",
      provider,
      verified: false,
      capturedAt,
    };
  }

  private applyProgressEvidence(
    candidates: readonly CandidateView[],
    event: LiveWorkflowProgressEvent,
  ): readonly CandidateView[] {
    if (event.stage === "candidates-generated" && event.candidates !== undefined) {
      return event.candidates.map((candidate, index) => {
        const pendingDaytona = this.pendingProvenance("daytona-pending", event.at);
        const pendingBraintrust = this.pendingProvenance(
          "braintrust-pending",
          event.at,
        );
        return {
          id: candidate.candidateId,
          label: candidateLabel(index),
          strategy: candidate.strategy,
          hypothesis: candidate.hypothesis,
          generation: {
            profile: candidate.evaluationProfile,
            patchDigest: candidate.patchDigest,
            provenance: this.providerProvenance("fireworks", {
              externalId: candidate.patchDigest,
              capturedAt: candidate.generationCapturedAt,
            }),
          },
          selected: false,
          sandbox: {
            status: "pending",
            isolated: false,
            provenance: { ...pendingDaytona },
          },
          build: evidenceView(
            "pending",
            "Waiting for this candidate's Daytona build receipt.",
            pendingDaytona,
          ),
          tests: {
            ...evidenceView(
              "pending",
              "Waiting for this candidate's trusted Daytona test receipts.",
              pendingDaytona,
            ),
            passed: 0,
            total: 0,
          },
          safetyGate: {
            ...evidenceView(
              "pending",
              "Braintrust hard-gate scoring has not completed.",
              pendingBraintrust,
            ),
            hardGatePassed: null,
            failures: [],
          },
          score: {
            weighted: null,
            eligible: null,
            provenance: { ...pendingBraintrust },
          },
          diff: candidate.unifiedDiff,
        };
      });
    }
    if (
      event.stage !== "candidate-validated" ||
      event.candidateId === undefined ||
      event.validation === undefined
    ) {
      return candidates;
    }
    const validation = event.validation;
    const daytona = this.providerProvenance("daytona", {
      externalId: `${validation.sandboxId}/${validation.runId}`,
      capturedAt: validation.capturedAt,
    });
    return candidates.map((candidate) => {
      if (candidate.id !== event.candidateId) return candidate;
      const unitStatus =
        validation.unitTests.total === 0
          ? "not-run"
          : validation.unitTests.passed === validation.unitTests.total
            ? "passed"
            : "failed";
      const safetyPassed =
        validation.safetyTests.total > 0 &&
        validation.safetyTests.passed === validation.safetyTests.total &&
        validation.integrity.passed;
      return {
        ...candidate,
        sandbox: {
          id: validation.sandboxId,
          status: validation.passed ? "passed" : "failed",
          isolated: true,
          provenance: { ...daytona },
        },
        build: evidenceView(
          validation.build.exitCode === null
            ? "not-run"
            : validation.build.exitCode === 0
              ? "passed"
              : "failed",
          `Daytona build exit code: ${validation.build.exitCode ?? "not run"}.`,
          daytona,
          validation.validatedTreeSha ?? undefined,
        ),
        tests: {
          ...evidenceView(
            unitStatus,
            `${validation.unitTests.passed}/${validation.unitTests.total} trusted unit tests passed in Daytona.`,
            daytona,
          ),
          passed: validation.unitTests.passed,
          total: validation.unitTests.total,
        },
        safetyGate: {
          ...candidate.safetyGate,
          status: safetyPassed ? "passed" : "failed",
          summary: `${validation.safetyTests.passed}/${validation.safetyTests.total} safety tests passed; integrity ${validation.integrity.passed ? "passed" : "failed"}. Braintrust eligibility remains pending.`,
          failures: [
            ...validation.safetyTests.criticalFailures,
            ...validation.integrity.violations,
          ],
          provenance: { ...daytona },
        },
      };
    });
  }

  private recordProgress(
    record: LiveSessionRecord,
    event: LiveWorkflowProgressEvent,
  ): void {
    if (
      event.sessionId !== record.view.id ||
      event.sequence <= (record.lastProgressSequence ?? 0)
    ) {
      return;
    }
    record.lastProgressSequence = event.sequence;
    const provenance = event.provider
      ? this.providerProvenance(event.provider, {
          externalId: event.evidenceId,
          capturedAt: event.at,
        })
      : this.orchestratorProvenance(event.at);
    const sequence = record.view.events.length + 1;
    record.view = {
      ...record.view,
      state: event.state,
      updatedAt: event.at,
      failure: undefined,
      candidates: this.applyProgressEvidence(record.view.candidates, event),
      events: [
        ...record.view.events,
        {
          id: `${record.view.id}-live-progress-${event.sequence}`,
          sequence,
          state: event.state,
          title: event.stage.replaceAll("-", " ").toUpperCase(),
          summary: event.message,
          occurredAt: event.at,
          provenance,
        },
      ],
    };
  }

  private clearSyntheticFailure(record: LiveSessionRecord): void {
    record.view = {
      ...record.view,
      state: record.snapshot?.session.state ?? "INGESTING_REPOSITORY",
      failure: undefined,
    };
  }

  private failClosed(
    record: LiveSessionRecord,
    failure: NonNullable<SessionView["failure"]>,
    resume?: () => void,
  ): void {
    const at = this.now().toISOString();
    record.resume = failure.recoverable ? resume : undefined;
    record.view = {
      ...appendEvent(
        record.view,
        "FAILED",
        at,
        this.orchestratorProvenance(at),
      ),
      approval: record.view.approval,
      failure,
      pullRequest:
        record.view.pullRequest?.provenance.verified === true
          ? record.view.pullRequest
          : undefined,
    };
  }

  private launch(
    record: LiveSessionRecord,
    operation: () => Promise<void>,
  ): void {
    const running = operation()
      .catch(() =>
        this.failClosed(record, {
          reason: "The live workflow encountered an internal fail-closed error.",
          recoverable: false,
        }),
      )
      .finally(() => {
        if (record.operation === running) record.operation = undefined;
      });
    record.operation = running;
  }

  private isRetryable(error: unknown): boolean {
    if (typeof error === "object" && error !== null && "retryable" in error) {
      return (error as { retryable?: unknown }).retryable === true;
    }
    return (
      error instanceof TypeError ||
      (error instanceof Error && error.name === "AbortError")
    );
  }

  private async runResumableStage<T>(
    record: LiveSessionRecord,
    stage: ResumableStage<T>,
  ): Promise<T | undefined> {
    const maximumAttempts = 3;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const result = await stage.operation();
        record.resume = undefined;
        return result;
      } catch (error) {
        const recoverable = this.isRetryable(error);
        if (recoverable && attempt < maximumAttempts) continue;
        this.failClosed(
          record,
          {
            reason: stage.reason,
            recoverable,
            retryAction: recoverable ? stage.retryAction : undefined,
          },
          recoverable ? stage.resume : undefined,
        );
        return undefined;
      }
    }
    return undefined;
  }

  private startTournament(record: LiveSessionRecord, sessionId: string): void {
    this.clearSyntheticFailure(record);
    this.launch(record, async () => {
      const snapshot = await this.runResumableStage(record, {
        operation: () => this.workflow.startTournament(sessionId),
        resume: () => this.startTournament(record, sessionId),
        reason:
          "Live provider tournament startup did not complete after bounded retries.",
        retryAction: "resume-live-tournament",
      });
      if (snapshot !== undefined) this.updateFromSnapshot(record, snapshot);
    });
  }

  private async repairWithinOperation(
    record: LiveSessionRecord,
    sessionId: string,
  ): Promise<void> {
    const repaired = await this.runResumableStage(record, {
      operation: () => this.workflow.repairBlockedReview(sessionId),
      resume: () => this.startRepair(record, sessionId),
      reason:
        "CodeRabbit repair and full revalidation did not complete after bounded retries.",
      retryAction: "resume-review-repair",
    });
    if (repaired === undefined) return;
    if (repaired.session.state !== "AWAITING_HUMAN_APPROVAL") {
      this.failClosed(record, {
        reason: "The repaired candidate did not return to the human approval gate.",
        recoverable: false,
      });
      return;
    }
    this.updateFromSnapshot(record, repaired, {
      title: "REPAIRED HEAD REQUIRES FRESH APPROVAL",
      summary:
        "The repaired candidate passed full revalidation. Its old approval is invalid and publication is blocked until a human reviews the new binding.",
    });
  }

  private startRepair(record: LiveSessionRecord, sessionId: string): void {
    this.clearSyntheticFailure(record);
    this.launch(record, () => this.repairWithinOperation(record, sessionId));
  }

  private startPublication(record: LiveSessionRecord, sessionId: string): void {
    this.clearSyntheticFailure(record);
    this.launch(record, async () => {
      const reviewed = await this.runResumableStage(record, {
        operation: () => this.workflow.publishApprovedAndReview(sessionId),
        resume: () => this.startPublication(record, sessionId),
        reason:
          "GitHub publication or CodeRabbit review did not complete after bounded retries.",
        retryAction: "resume-publication-review",
      });
      if (reviewed === undefined) return;
      this.updateFromSnapshot(record, reviewed);
      if (reviewed.session.state === "REVIEW_BLOCKED") {
        await this.repairWithinOperation(record, sessionId);
      } else if (reviewed.session.state !== "READY_TO_MERGE") {
        this.failClosed(record, {
          reason: "Independent review did not reach an allowed review gate.",
          recoverable: false,
        });
      }
    });
  }

  private startReadyRefresh(
    record: LiveSessionRecord,
    sessionId: string,
  ): void {
    record.lastReadyRefreshAtMs = undefined;
    this.launch(record, () =>
      this.refreshReadyClaimIfDue(record, sessionId, true),
    );
  }

  private async refreshReadyClaimIfDue(
    record: LiveSessionRecord,
    sessionId: string,
    force = false,
  ): Promise<void> {
    if (record.readyRefreshOperation !== undefined) {
      await record.readyRefreshOperation;
      return;
    }
    const operation = this.performReadyClaimRefreshIfDue(
      record,
      sessionId,
      force,
    );
    record.readyRefreshOperation = operation;
    try {
      await operation;
    } finally {
      if (record.readyRefreshOperation === operation) {
        record.readyRefreshOperation = undefined;
      }
    }
  }

  private async performReadyClaimRefreshIfDue(
    record: LiveSessionRecord,
    sessionId: string,
    force: boolean,
  ): Promise<void> {
    const authoritativeReady =
      record.snapshot?.session.state === "READY_TO_MERGE";
    if (
      (record.view.state !== "READY_TO_MERGE" &&
        !(force && authoritativeReady)) ||
      this.workflow.refreshReadyToMerge === undefined
    ) {
      return;
    }
    const nowMs = this.now().getTime();
    if (
      !force &&
      record.lastReadyRefreshAtMs !== undefined &&
      nowMs - record.lastReadyRefreshAtMs < this.readyRefreshIntervalMs
    ) {
      return;
    }
    try {
      const refreshed = await this.workflow.refreshReadyToMerge(sessionId);
      record.lastReadyRefreshAtMs = nowMs;
      this.updateFromSnapshot(record, refreshed, {
        title:
          refreshed.session.state === "READY_TO_MERGE"
            ? "REMOTE READY CLAIM REVALIDATED"
            : "REMOTE READY CLAIM REVOKED",
        summary:
          refreshed.session.state === "READY_TO_MERGE"
            ? "A read-only exact repo/base/head/review check confirmed that the approval remains current."
            : "The remote PR or independent review no longer matches the approval-bound evidence.",
      });
    } catch {
      const at = this.now().toISOString();
      record.view = {
        ...record.view,
        approval:
          record.view.approval === undefined
            ? undefined
            : {
                ...record.view.approval,
                invalidatedAt: at,
                invalidationReason:
                  "Remote READY freshness could not be verified.",
              },
        review: undefined,
      };
      this.failClosed(
        record,
        {
          reason:
            "Read-only GitHub/CodeRabbit freshness verification failed; the cached READY claim is hidden.",
          recoverable: true,
          retryAction: "retry-ready-freshness-check",
        },
        () => this.startReadyRefresh(record, sessionId),
      );
    }
  }

  async create(input: unknown): Promise<SessionView> {
    const request = CreateSessionRequestSchema.safeParse(input);
    if (!request.success) {
      throw new SessionServiceError(
        400,
        "INVALID_REQUEST",
        "Session request failed validation.",
      );
    }
    if (request.data.scenarioId === "provider-failure") {
      throw new SessionServiceError(
        409,
        "MOCK_SCENARIO_REQUIRED",
        "The provider-failure fixture is mock-only and never consumes live provider quota.",
      );
    }
    const sessionId = assertSafeSessionId(this.idFactory());
    if (this.records.has(sessionId)) {
      throw new SessionServiceError(
        409,
        "SESSION_ALREADY_EXISTS",
        "A live session with this identifier already exists.",
      );
    }
    const record: LiveSessionRecord = {
      view: this.placeholder(
        sessionId,
        this.now().toISOString(),
        request.data.scenarioId,
      ),
    };
    record.unsubscribeProgress = this.workflow.subscribeProgress(
      sessionId,
      (event) => this.recordProgress(record, event),
    );
    this.records.set(sessionId, record);
    this.startTournament(record, sessionId);
    return cloneView(record.view);
  }

  async get(sessionId: string): Promise<SessionView> {
    const safeId = assertSafeSessionId(sessionId);
    const record = this.records.get(safeId);
    if (record === undefined) {
      throw new SessionServiceError(
        404,
        "SESSION_NOT_FOUND",
        "Session was not found.",
      );
    }
    if (record.operation === undefined) {
      await this.refreshReadyClaimIfDue(record, safeId);
    }
    return cloneView(record.view);
  }

  async list(): Promise<readonly SessionView[]> {
    for (const [sessionId, record] of this.records) {
      if (record.operation === undefined) {
        await this.refreshReadyClaimIfDue(record, sessionId);
      }
    }
    return [...this.records.values()]
      .map((record) => cloneView(record.view))
      .sort((left, right) =>
        (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
      );
  }

  async decide(sessionId: string, input: unknown): Promise<SessionView> {
    const safeId = assertSafeSessionId(sessionId);
    const request = DecisionRequestSchema.safeParse(input);
    if (!request.success) {
      throw new SessionServiceError(
        400,
        "INVALID_DECISION",
        "Decision request failed validation.",
      );
    }
    const record = this.records.get(safeId);
    if (record === undefined) {
      throw new SessionServiceError(
        404,
        "SESSION_NOT_FOUND",
        "Session was not found.",
      );
    }
    if (record.operation !== undefined) {
      throw new SessionServiceError(
        409,
        "SESSION_OPERATION_IN_PROGRESS",
        "The live workflow is still processing this session.",
      );
    }
    const view = record.view;
    if (
      view.state !== "AWAITING_HUMAN_APPROVAL" ||
      view.selectedCandidateId === undefined ||
      view.currentPatchDigest === undefined ||
      view.currentEvidenceDigest === undefined ||
      !FULL_GIT_ID_PATTERN.test(view.currentCommitSha)
    ) {
      throw new SessionServiceError(
        409,
        "DECISION_NOT_ALLOWED",
        "This session is not awaiting a bound decision.",
      );
    }
    if (
      request.data.candidateId !== view.selectedCandidateId ||
      request.data.patchDigest !== view.currentPatchDigest ||
      request.data.evidenceDigest !== view.currentEvidenceDigest ||
      request.data.commitSha !== view.currentCommitSha ||
      request.data.policyVersion !== view.policy.version
    ) {
      throw new SessionServiceError(
        409,
        "STALE_OR_TAMPERED_DECISION",
        "Decision binding does not match the current validated commit and evidence.",
      );
    }
    let snapshot: LiveWorkflowSnapshot;
    try {
      snapshot = await this.workflow.recordHumanDecision({
        sessionId: safeId,
        approverId: configuredApproverId("live-web-operator"),
        approverDisplayName:
          request.data.approverDisplayName ?? "SafeFlash live operator",
        decision: request.data.decision,
        reason: request.data.reason,
        expected: {
          candidateId: request.data.candidateId,
          patchDigest: request.data.patchDigest,
          evidenceDigest: request.data.evidenceDigest,
          commitSha: request.data.commitSha,
          policyVersion: request.data.policyVersion,
        },
      });
    } catch {
      throw new SessionServiceError(
        409,
        "DECISION_REJECTED",
        "The live workflow rejected the stale or invalid decision binding.",
      );
    }
    this.updateFromSnapshot(record, snapshot, {
      title: "HUMAN DECISION RECORDED",
      summary:
        request.data.decision === "approved"
          ? "Approval is bound to the exact candidate, patch, evidence, commit, policy, and pull-request target."
          : "The human decision was recorded; no publication was authorized.",
    });
    if (request.data.decision === "approved") {
      this.startPublication(record, safeId);
    }
    return cloneView(record.view);
  }

  async retry(sessionId: string): Promise<SessionView> {
    const safeId = assertSafeSessionId(sessionId);
    const record = this.records.get(safeId);
    if (record === undefined) {
      throw new SessionServiceError(
        404,
        "SESSION_NOT_FOUND",
        "Session was not found.",
      );
    }
    if (
      record.operation !== undefined ||
      record.view.state !== "FAILED" ||
      record.view.failure?.recoverable !== true ||
      record.resume === undefined
    ) {
      throw new SessionServiceError(
        409,
        "RETRY_NOT_ALLOWED",
        "This session has no recoverable live operation to resume.",
      );
    }
    const resume = record.resume;
    record.resume = undefined;
    resume();
    return cloneView(record.view);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __safeFlashLiveSessionService: LiveSessionService | undefined;
}

export function getLiveSessionService(): LiveSessionService {
  if (process.env.SAFEFLASH_DEFAULT_MODE !== "live") {
    throw new SessionServiceError(
      503,
      "LIVE_MODE_DISABLED",
      "Live session service is disabled.",
    );
  }
  if (globalThis.__safeFlashLiveSessionService !== undefined) {
    return globalThis.__safeFlashLiveSessionService;
  }
  try {
    const workflow = createProductionLiveSafetyWorkflow();
    globalThis.__safeFlashLiveSessionService = new LiveSessionService(
      workflow,
      {},
      PRODUCTION_LIVE_TRUST,
    );
    return globalThis.__safeFlashLiveSessionService;
  } catch {
    throw new SessionServiceError(
      503,
      "LIVE_CONFIGURATION_UNAVAILABLE",
      "Live mode is selected, but required server-only provider configuration is unavailable.",
    );
  }
}
