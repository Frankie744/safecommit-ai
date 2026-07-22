import {
  invalidateApprovalWhenEvidenceChanges,
  isApprovalValid,
  type ApprovalBinding,
} from "./approval";
import { evaluateCodeRabbitGate } from "./review-gate";
import type {
  HumanApproval,
  OperatingMode,
  PullRequestRecord,
  ReviewFinding,
  ValidationSession,
  ValidationState,
} from "./types";

export interface CreateValidationSessionInput {
  id: string;
  incidentId: string;
  policyId: string;
  policyVersion: string;
  repository: {
    repoUrl: string;
    commitSha: string;
  };
  mode: OperatingMode;
  runKind?: "single" | "tournament";
  sourceVersion: string;
  at: string;
}

export type WorkflowEvent =
  | { type: "START"; at: string }
  | { type: "REPOSITORY_INGESTED"; at: string }
  | { type: "INCIDENT_ANALYZED"; at: string }
  | { type: "CANDIDATES_GENERATED"; at: string; candidateIds: readonly string[] }
  | {
      type: "SANDBOXES_PROVISIONED";
      at: string;
      sandboxIdsByCandidate: Readonly<Record<string, string>>;
    }
  | { type: "BUILDS_FINISHED"; at: string }
  | { type: "TESTS_FINISHED"; at: string }
  | { type: "SCORING_FINISHED"; at: string }
  | {
      type: "CANDIDATE_SELECTED";
      at: string;
      candidateId: string;
      patchDigest: string;
      evidenceDigest: string;
    }
  | { type: "APPROVAL_RECORDED"; at: string; approval: HumanApproval }
  | { type: "PR_CREATION_REQUESTED"; at: string }
  | { type: "PR_CREATED_OR_UPDATED"; at: string; pullRequest: PullRequestRecord }
  | {
      type: "REVIEW_FINDINGS_RECEIVED";
      at: string;
      findings: readonly ReviewFinding[];
    }
  | { type: "REPAIR_STARTED"; at: string }
  | {
      type: "REPAIR_GENERATED";
      at: string;
      candidateId: string;
      patchDigest: string;
    }
  | {
      type: "REVALIDATION_PASSED";
      at: string;
      evidenceDigest: string;
      patchDigest: string;
    }
  | { type: "MARK_READY_TO_MERGE"; at: string }
  | { type: "COMPLETE"; at: string }
  | {
      type: "FAIL";
      at: string;
      reason: string;
      recoverable: boolean;
      retryAction?: string;
    }
  | { type: "CANCEL"; at: string };

const EXPECTED_EVENT: Partial<Record<ValidationState, WorkflowEvent["type"]>> = {
  IDLE: "START",
  INGESTING_REPOSITORY: "REPOSITORY_INGESTED",
  ANALYZING_INCIDENT: "INCIDENT_ANALYZED",
  GENERATING_CANDIDATES: "CANDIDATES_GENERATED",
  PROVISIONING_SANDBOXES: "SANDBOXES_PROVISIONED",
  BUILDING: "BUILDS_FINISHED",
  RUNNING_TESTS: "TESTS_FINISHED",
  SCORING: "SCORING_FINISHED",
  SELECTING: "CANDIDATE_SELECTED",
  CREATING_PULL_REQUEST: "PR_CREATED_OR_UPDATED",
  REVIEW_BLOCKED: "REPAIR_STARTED",
  REPAIRING_REVIEW_FINDINGS: "REPAIR_GENERATED",
  REVALIDATING: "REVALIDATION_PASSED",
  REVIEW_PASSED: "MARK_READY_TO_MERGE",
  READY_TO_MERGE: "COMPLETE",
};

const TERMINAL_STATES: ReadonlySet<ValidationState> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED_BY_HUMAN",
]);

export class InvalidWorkflowTransitionError extends Error {
  constructor(
    public readonly state: ValidationState,
    public readonly eventType: WorkflowEvent["type"],
    message?: string,
  ) {
    super(message ?? `Cannot apply ${eventType} while workflow is ${state}`);
    this.name = "InvalidWorkflowTransitionError";
  }
}

export function createValidationSession(
  input: CreateValidationSessionInput,
): ValidationSession {
  return {
    id: input.id,
    sessionId: input.id,
    createdAt: input.at,
    updatedAt: input.at,
    source: "orchestrator",
    sourceVersion: input.sourceVersion,
    mode: input.mode,
    runKind: input.runKind ?? "tournament",
    state: "IDLE",
    incidentId: input.incidentId,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    repository: { ...input.repository },
    candidateIds: [],
    sandboxIdsByCandidate: {},
    reviewFindings: [],
    validationRound: 0,
  };
}

function currentBinding(session: ValidationSession): ApprovalBinding | undefined {
  if (
    session.selectedCandidateId === undefined ||
    session.currentPatchDigest === undefined ||
    session.currentEvidenceDigest === undefined
  ) {
    return undefined;
  }

  return {
    candidateId: session.selectedCandidateId,
    patchDigest: session.currentPatchDigest,
    evidenceDigest: session.currentEvidenceDigest,
    policyVersion: session.policyVersion,
    commitSha: session.repository.commitSha,
  };
}

export function canCreateOrUpdatePullRequest(session: ValidationSession): {
  allowed: boolean;
  reason: string;
} {
  const binding = currentBinding(session);
  if (session.state !== "AWAITING_HUMAN_APPROVAL") {
    return { allowed: false, reason: "Workflow is not awaiting human approval." };
  }
  if (binding === undefined || !isApprovalValid(session.approval, binding)) {
    return {
      allowed: false,
      reason: "A valid approval bound to the current patch and evidence is required.",
    };
  }
  return { allowed: true, reason: "Current evidence has valid human approval." };
}

export function canEnterReadyToMerge(session: ValidationSession): {
  allowed: boolean;
  reason: string;
} {
  if (session.state !== "REVIEW_PASSED") {
    return { allowed: false, reason: "Independent review has not passed." };
  }
  const review = evaluateCodeRabbitGate(session.reviewFindings);
  if (!review.passed) return { allowed: false, reason: review.reason };
  const binding = currentBinding(session);
  if (binding === undefined || !isApprovalValid(session.approval, binding)) {
    return {
      allowed: false,
      reason: "Human approval is absent or stale for the current evidence.",
    };
  }
  return { allowed: true, reason: "Review and approval gates passed." };
}

function requireExpectedEvent(session: ValidationSession, event: WorkflowEvent): void {
  const expected = EXPECTED_EVENT[session.state];
  if (expected !== event.type) {
    throw new InvalidWorkflowTransitionError(session.state, event.type);
  }
}

function withState(
  session: ValidationSession,
  state: ValidationState,
  at: string,
  changes: Partial<ValidationSession> = {},
): ValidationSession {
  return { ...session, ...changes, state, updatedAt: at };
}

export function transitionValidationSession(
  session: ValidationSession,
  event: WorkflowEvent,
): ValidationSession {
  if (TERMINAL_STATES.has(session.state)) {
    throw new InvalidWorkflowTransitionError(session.state, event.type);
  }

  if (event.type === "FAIL") {
    return withState(session, "FAILED", event.at, {
      failure: {
        reason: event.reason,
        recoverable: event.recoverable,
        retryAction: event.retryAction,
        failedFrom: session.state,
      },
    });
  }

  if (event.type === "CANCEL") {
    return withState(session, "CANCELLED_BY_HUMAN", event.at);
  }

  if (session.state === "AWAITING_HUMAN_APPROVAL") {
    if (event.type === "APPROVAL_RECORDED") {
      if (
        event.approval.sessionId !== session.sessionId ||
        event.approval.candidateId !== session.selectedCandidateId
      ) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Approval does not belong to the selected candidate and session",
        );
      }
      return withState(session, session.state, event.at, {
        approval: event.approval,
      });
    }
    if (event.type === "PR_CREATION_REQUESTED") {
      const gate = canCreateOrUpdatePullRequest(session);
      if (!gate.allowed) {
        throw new InvalidWorkflowTransitionError(session.state, event.type, gate.reason);
      }
      return withState(session, "CREATING_PULL_REQUEST", event.at);
    }
    throw new InvalidWorkflowTransitionError(session.state, event.type);
  }

  if (session.state === "AWAITING_CODERABBIT") {
    if (event.type !== "REVIEW_FINDINGS_RECEIVED") {
      throw new InvalidWorkflowTransitionError(session.state, event.type);
    }
    const gate = evaluateCodeRabbitGate(event.findings);
    return withState(
      session,
      gate.passed ? "REVIEW_PASSED" : "REVIEW_BLOCKED",
      event.at,
      { reviewFindings: event.findings },
    );
  }

  requireExpectedEvent(session, event);

  switch (event.type) {
    case "START":
      return withState(session, "INGESTING_REPOSITORY", event.at);
    case "REPOSITORY_INGESTED":
      return withState(session, "ANALYZING_INCIDENT", event.at);
    case "INCIDENT_ANALYZED":
      return withState(session, "GENERATING_CANDIDATES", event.at);
    case "CANDIDATES_GENERATED": {
      const unique = new Set(event.candidateIds);
      const minimum = session.runKind === "tournament" ? 3 : 1;
      if (unique.size !== event.candidateIds.length || unique.size < minimum) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          `${session.runKind} run requires at least ${minimum} unique candidate(s)`,
        );
      }
      return withState(session, "PROVISIONING_SANDBOXES", event.at, {
        candidateIds: [...event.candidateIds],
      });
    }
    case "SANDBOXES_PROVISIONED": {
      const candidateIds = [...session.candidateIds].sort();
      const mappedCandidates = Object.keys(event.sandboxIdsByCandidate).sort();
      const sandboxIds = Object.values(event.sandboxIdsByCandidate);
      if (
        candidateIds.length !== mappedCandidates.length ||
        candidateIds.some((candidate, index) => candidate !== mappedCandidates[index]) ||
        new Set(sandboxIds).size !== sandboxIds.length ||
        sandboxIds.some((sandboxId) => sandboxId.trim() === "")
      ) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Every candidate must map to one unique, non-empty sandbox ID",
        );
      }
      return withState(session, "BUILDING", event.at, {
        sandboxIdsByCandidate: { ...event.sandboxIdsByCandidate },
      });
    }
    case "BUILDS_FINISHED":
      return withState(session, "RUNNING_TESTS", event.at);
    case "TESTS_FINISHED":
      return withState(session, "SCORING", event.at);
    case "SCORING_FINISHED":
      return withState(session, "SELECTING", event.at);
    case "CANDIDATE_SELECTED":
      if (!session.candidateIds.includes(event.candidateId)) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Selected candidate was not evaluated in this session",
        );
      }
      return withState(session, "AWAITING_HUMAN_APPROVAL", event.at, {
        selectedCandidateId: event.candidateId,
        currentPatchDigest: event.patchDigest,
        currentEvidenceDigest: event.evidenceDigest,
        validationRound: session.validationRound + 1,
      });
    case "PR_CREATED_OR_UPDATED":
      if (
        event.pullRequest.sessionId !== session.sessionId ||
        event.pullRequest.candidateId !== session.selectedCandidateId
      ) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Pull request record belongs to a different session or candidate",
        );
      }
      return withState(session, "AWAITING_CODERABBIT", event.at, {
        pullRequest: event.pullRequest,
        reviewFindings: [],
      });
    case "REPAIR_STARTED":
      return withState(session, "REPAIRING_REVIEW_FINDINGS", event.at);
    case "REPAIR_GENERATED": {
      if (!session.candidateIds.includes(event.candidateId)) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Repaired candidate was not evaluated in this session",
        );
      }
      const existingApproval = session.approval;
      const invalidationBinding: ApprovalBinding | undefined = existingApproval
        ? {
            candidateId: event.candidateId,
            patchDigest: event.patchDigest,
            evidenceDigest: session.currentEvidenceDigest ?? "pending-revalidation",
            policyVersion: session.policyVersion,
            commitSha: session.repository.commitSha,
          }
        : undefined;
      return withState(session, "REVALIDATING", event.at, {
        selectedCandidateId: event.candidateId,
        currentPatchDigest: event.patchDigest,
        approval: invalidationBinding
          ? invalidateApprovalWhenEvidenceChanges(
              existingApproval,
              invalidationBinding,
              event.at,
            )
          : existingApproval,
      });
    }
    case "REVALIDATION_PASSED": {
      if (event.patchDigest !== session.currentPatchDigest) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Revalidation evidence does not match the repaired patch",
        );
      }
      const existingApproval = session.approval;
      const binding: ApprovalBinding | undefined =
        existingApproval && session.selectedCandidateId
          ? {
              candidateId: session.selectedCandidateId,
              patchDigest: event.patchDigest,
              evidenceDigest: event.evidenceDigest,
              policyVersion: session.policyVersion,
              commitSha: session.repository.commitSha,
            }
          : undefined;
      return withState(session, "AWAITING_HUMAN_APPROVAL", event.at, {
        currentEvidenceDigest: event.evidenceDigest,
        currentPatchDigest: event.patchDigest,
        approval: binding
          ? invalidateApprovalWhenEvidenceChanges(existingApproval, binding, event.at)
          : existingApproval,
        validationRound: session.validationRound + 1,
      });
    }
    case "MARK_READY_TO_MERGE": {
      const gate = canEnterReadyToMerge(session);
      if (!gate.allowed) {
        throw new InvalidWorkflowTransitionError(session.state, event.type, gate.reason);
      }
      return withState(session, "READY_TO_MERGE", event.at);
    }
    case "COMPLETE":
      return withState(session, "COMPLETED", event.at);
    default:
      throw new InvalidWorkflowTransitionError(session.state, event.type);
  }
}
