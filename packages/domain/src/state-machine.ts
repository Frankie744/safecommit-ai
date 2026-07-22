import {
  invalidateApprovalWhenEvidenceChanges,
  isApprovalValid,
  type ApprovalBinding,
} from "./approval";
import { evaluateCodeRabbitGate } from "./review-gate";
import type {
  FullRevalidationReceipt,
  HumanApproval,
  IndependentReviewReceipt,
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
      commitSha: string;
    }
  | { type: "APPROVAL_RECORDED"; at: string; approval: HumanApproval }
  | { type: "PR_CREATION_REQUESTED"; at: string }
  | { type: "PR_CREATED_OR_UPDATED"; at: string; pullRequest: PullRequestRecord }
  | {
      type: "REVIEW_FINDINGS_RECEIVED";
      at: string;
      findings: readonly ReviewFinding[];
      receipt: IndependentReviewReceipt;
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
      receipt: FullRevalidationReceipt;
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
    currentCommitSha: input.repository.commitSha,
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
    session.currentEvidenceDigest === undefined ||
    session.currentCommitSha === undefined
  ) {
    return undefined;
  }

  return {
    candidateId: session.selectedCandidateId,
    patchDigest: session.currentPatchDigest,
    evidenceDigest: session.currentEvidenceDigest,
    policyVersion: session.policyVersion,
    commitSha: session.currentCommitSha,
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
  if (
    session.pullRequest === undefined ||
    session.reviewReceipt === undefined ||
    session.reviewReceipt.status !== "passed" ||
    session.reviewReceipt.pullNumber !== session.pullRequest.number ||
    session.reviewReceipt.headSha.toLowerCase() !==
      session.pullRequest.headSha.toLowerCase()
  ) {
    return {
      allowed: false,
      reason: "A passing independent-review receipt for the exact current PR head is required.",
    };
  }
  const binding = currentBinding(session);
  if (binding === undefined || !isApprovalValid(session.approval, binding)) {
    return {
      allowed: false,
      reason: "Human approval is absent or stale for the current evidence.",
    };
  }
  if (
    session.pullRequest.status !== "open" ||
    session.pullRequest.headSha.toLowerCase() !== binding.commitSha.toLowerCase()
  ) {
    return {
      allowed: false,
      reason: "The open pull request head no longer matches the approved commit.",
    };
  }
  return { allowed: true, reason: "Review and approval gates passed." };
}

function isFullGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value);
}

function isCanonicalGitHubPullRequest(
  pullRequest: PullRequestRecord,
): boolean {
  try {
    const url = new URL(pullRequest.url);
    const expectedPath = `/${encodeURIComponent(
      pullRequest.owner,
    )}/${encodeURIComponent(pullRequest.repository)}/pull/${pullRequest.number}`;
    return (
      pullRequest.owner.trim() !== "" &&
      pullRequest.repository.trim() !== "" &&
      pullRequest.baseBranch.trim() !== "" &&
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.toLowerCase() === expectedPath.toLowerCase() &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isReviewUrlForPullRequest(
  reviewUrl: string,
  pullRequestUrl: string,
): boolean {
  try {
    const review = new URL(reviewUrl);
    const pullRequest = new URL(pullRequestUrl);
    const pullPath = pullRequest.pathname.replace(/\/+$/u, "");
    return (
      review.protocol === "https:" &&
      review.username === "" &&
      review.password === "" &&
      review.origin.toLowerCase() === pullRequest.origin.toLowerCase() &&
      (review.pathname === pullPath || review.pathname.startsWith(`${pullPath}/`))
    );
  } catch {
    return false;
  }
}

function isEvidenceUrlForPullRequestRepository(
  evidenceUrl: string,
  pullRequestUrl: string,
): boolean {
  try {
    const evidence = new URL(evidenceUrl);
    const pullRequest = new URL(pullRequestUrl);
    const pathParts = pullRequest.pathname.split("/").filter(Boolean);
    if (pathParts.length < 4 || pathParts[2] !== "pull") return false;
    const repositoryPath = `/${pathParts[0]}/${pathParts[1]}`;
    return (
      evidence.protocol === "https:" &&
      evidence.username === "" &&
      evidence.password === "" &&
      evidence.origin.toLowerCase() === pullRequest.origin.toLowerCase() &&
      (evidence.pathname === repositoryPath ||
        evidence.pathname.startsWith(`${repositoryPath}/`))
    );
  } catch {
    return false;
  }
}

function requireIndependentReviewReceipt(
  session: ValidationSession,
  receipt: IndependentReviewReceipt,
  findings: readonly ReviewFinding[],
): void {
  const pullRequest = session.pullRequest;
  const gate = evaluateCodeRabbitGate(findings);
  const sourceIsConsistent =
    (receipt.provider === "coderabbit" && receipt.sourceKind === "live-api") ||
    (receipt.provider === "manual_verified" &&
      receipt.sourceKind === "manual-attestation" &&
      receipt.attestedBy?.trim() !== "");
  const findingsAreBound = findings.every(
    (finding) =>
      finding.sessionId === session.sessionId &&
      finding.provider === receipt.provider &&
      finding.sourceVersion.toLowerCase() === receipt.headSha.toLowerCase() &&
      (receipt.provider === "manual_verified"
        ? isReviewUrlForPullRequest(finding.reviewUrl, pullRequest?.url ?? "")
        : isEvidenceUrlForPullRequestRepository(
            finding.reviewUrl,
            pullRequest?.url ?? "",
          )),
  );
  if (
    pullRequest === undefined ||
    receipt.pullNumber !== pullRequest.number ||
    receipt.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase() ||
    !isFullGitObjectId(receipt.headSha) ||
    !isReviewUrlForPullRequest(receipt.reviewUrl, pullRequest.url) ||
    Number.isNaN(Date.parse(receipt.capturedAt)) ||
    receipt.evidenceIds.length === 0 ||
    new Set(receipt.evidenceIds).size !== receipt.evidenceIds.length ||
    receipt.evidenceIds.some((id) => id.trim() === "") ||
    !sourceIsConsistent ||
    !findingsAreBound ||
    (receipt.status === "passed") !== gate.passed
  ) {
    throw new InvalidWorkflowTransitionError(
      session.state,
      "REVIEW_FINDINGS_RECEIVED",
      "Independent review evidence must be non-empty, internally consistent, and bound to the exact current PR head.",
    );
  }
}

function requireFullRevalidationReceipt(
  session: ValidationSession,
  receipt: FullRevalidationReceipt,
): void {
  const everyGatePassed =
    receipt.buildPassed &&
    receipt.unitTestsPassed &&
    receipt.safetyTestsPassed &&
    receipt.integrityChecksPassed &&
    receipt.braintrustScored &&
    receipt.candidateEligible;
  const referencesPresent =
    receipt.sandboxId.trim() !== "" &&
    receipt.daytonaEvidenceRef.trim() !== "" &&
    receipt.braintrustExperimentRef.trim() !== "" &&
    receipt.evidenceDigest.trim() !== "";
  const freshSandbox = !Object.values(session.sandboxIdsByCandidate).includes(
    receipt.sandboxId,
  ) && receipt.sandboxId !== session.lastRevalidation?.sandboxId;
  const repairedHeadChanged =
    session.pullRequest === undefined ||
    receipt.commitSha.toLowerCase() !== session.pullRequest.headSha.toLowerCase();
  if (
    receipt.candidateId !== session.selectedCandidateId ||
    receipt.patchDigest !== session.currentPatchDigest ||
    receipt.evidenceDigest === session.currentEvidenceDigest ||
    !isFullGitObjectId(receipt.commitSha) ||
    receipt.executionProvider !== "daytona" ||
    receipt.evaluationProvider !== "braintrust" ||
    !referencesPresent ||
    !freshSandbox ||
    !repairedHeadChanged ||
    !everyGatePassed
  ) {
    throw new InvalidWorkflowTransitionError(
      session.state,
      "REVALIDATION_PASSED",
      "Review repair must pass build, unit, safety, integrity, and Braintrust eligibility in a fresh Daytona sandbox.",
    );
  }
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
    requireIndependentReviewReceipt(session, event.receipt, event.findings);
    return withState(
      session,
      event.receipt.status === "passed" && gate.passed
        ? "REVIEW_PASSED"
        : "REVIEW_BLOCKED",
      event.at,
      { reviewFindings: event.findings, reviewReceipt: event.receipt },
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
      if (!isFullGitObjectId(event.commitSha)) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Selected candidate must be bound to a full Git commit SHA",
        );
      }
      return withState(session, "AWAITING_HUMAN_APPROVAL", event.at, {
        selectedCandidateId: event.candidateId,
        currentPatchDigest: event.patchDigest,
        currentEvidenceDigest: event.evidenceDigest,
        currentCommitSha: event.commitSha,
        validationRound: session.validationRound + 1,
      });
    case "PR_CREATED_OR_UPDATED": {
      const binding = currentBinding(session);
      if (
        event.pullRequest.sessionId !== session.sessionId ||
        event.pullRequest.candidateId !== session.selectedCandidateId ||
        event.pullRequest.provider !== "github" ||
        event.pullRequest.status !== "open" ||
        event.pullRequest.number <= 0 ||
        !isCanonicalGitHubPullRequest(event.pullRequest) ||
        binding === undefined ||
        !isApprovalValid(session.approval, binding) ||
        event.pullRequest.headSha.toLowerCase() !== binding.commitSha.toLowerCase()
      ) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Pull request must be an open GitHub PR at the exact approval-bound head",
        );
      }
      return withState(session, "AWAITING_CODERABBIT", event.at, {
        pullRequest: event.pullRequest,
        reviewFindings: [],
        reviewReceipt: undefined,
      });
    }
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
            commitSha:
              session.currentCommitSha ?? session.repository.commitSha,
          }
        : undefined;
      return withState(session, "REVALIDATING", event.at, {
        selectedCandidateId: event.candidateId,
        currentPatchDigest: event.patchDigest,
        currentCommitSha: undefined,
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
      requireFullRevalidationReceipt(session, event.receipt);
      const existingApproval = session.approval;
      const binding: ApprovalBinding | undefined =
        existingApproval && session.selectedCandidateId
          ? {
              candidateId: session.selectedCandidateId,
              patchDigest: event.receipt.patchDigest,
              evidenceDigest: event.receipt.evidenceDigest,
              policyVersion: session.policyVersion,
              commitSha: event.receipt.commitSha,
            }
          : undefined;
      return withState(session, "AWAITING_HUMAN_APPROVAL", event.at, {
        currentEvidenceDigest: event.receipt.evidenceDigest,
        currentPatchDigest: event.receipt.patchDigest,
        currentCommitSha: event.receipt.commitSha,
        approval: binding
          ? invalidateApprovalWhenEvidenceChanges(existingApproval, binding, event.at)
          : existingApproval,
        validationRound: session.validationRound + 1,
        lastRevalidation: event.receipt,
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
