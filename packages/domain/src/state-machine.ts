import {
  invalidateApprovalWhenEvidenceChanges,
  isApprovalValid,
  type ApprovalBinding,
} from "./approval";
import { evaluateCodeRabbitGate } from "./review-gate";
import {
  computeFullRevalidationAttestationDigest,
  isFullRevalidationReceiptStructurallyValid,
} from "./revalidation";
import type {
  DaytonaAttemptInput,
  DaytonaAttemptRecord,
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
  policySnapshot?: {
    allowedPatchPaths: readonly string[];
    maxChangedFiles: number;
    maxChangedLines: number;
  };
  repository: {
    repoUrl: string;
    commitSha: string;
  };
  pullRequestTarget?: {
    provider: "github";
    owner: string;
    repository: string;
    baseBranch: string;
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
      type: "DAYTONA_ATTEMPT_RECORDED";
      at: string;
      attempt: DaytonaAttemptInput;
    }
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
      /** Required for live mode; omitted only by local/mock workflows. */
      receipt?: FullRevalidationReceipt;
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
    policySnapshot:
      input.policySnapshot === undefined
        ? undefined
        : {
            allowedPatchPaths: [...input.policySnapshot.allowedPatchPaths],
            maxChangedFiles: input.policySnapshot.maxChangedFiles,
            maxChangedLines: input.policySnapshot.maxChangedLines,
          },
    repository: { ...input.repository },
    pullRequestTarget:
      input.pullRequestTarget === undefined
        ? undefined
        : { ...input.pullRequestTarget },
    currentCommitSha: input.repository.commitSha,
    candidateIds: [],
    sandboxIdsByCandidate: {},
    sandboxAttemptHistory: [],
    reviewFindings: [],
    revalidationSandboxIds: [],
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
    pullRequestTarget: session.pullRequestTarget,
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
  if (session.pullRequestTarget === undefined) {
    return {
      allowed: false,
      reason: "A session-bound GitHub pull request target is required.",
    };
  }
  if (!hasCleanLiveDaytonaHistory(session)) {
    return {
      allowed: false,
      reason:
        "Every Daytona attempt must have unique IDs and confirmed sandbox deletion before GitHub publication.",
    };
  }
  if (binding === undefined || !isApprovalValid(session.approval, binding)) {
    return {
      allowed: false,
      reason: "A valid approval bound to the current patch and evidence is required.",
    };
  }
  return { allowed: true, reason: "Current evidence has valid human approval." };
}

function hasCleanLiveDaytonaHistory(session: ValidationSession): boolean {
  if (session.mode !== "live") return true;
  const attempts = session.sandboxAttemptHistory ?? [];
  return (
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        attempt.reservationStatus === "reserved" &&
        !attempt.duplicateSandbox &&
        !attempt.duplicateRun &&
        (attempt.disposition === "completed" ||
          (attempt.disposition === "failed-destroyed" && attempt.retryable)),
    )
  );
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
      session.pullRequest.headSha.toLowerCase() ||
    session.reviewReceipt.expectedBaseRef !== session.pullRequest.baseBranch ||
    session.reviewReceipt.observedBaseRef !== session.pullRequest.baseBranch ||
    session.reviewReceipt.expectedBaseSha.toLowerCase() !==
      session.pullRequest.baseSha.toLowerCase() ||
    session.reviewReceipt.observedBaseSha.toLowerCase() !==
      session.pullRequest.baseSha.toLowerCase()
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
    session.pullRequest.headSha.toLowerCase() !== binding.commitSha.toLowerCase() ||
    (session.currentValidatedTreeSha !== undefined &&
      session.pullRequest.headTreeSha.toLowerCase() !==
        session.currentValidatedTreeSha.toLowerCase())
  ) {
    return {
      allowed: false,
      reason: "The open pull request head no longer matches the approved commit.",
    };
  }
  if (!hasCleanLiveDaytonaHistory(session)) {
    return {
      allowed: false,
      reason:
        "Every Daytona attempt must have unique IDs and confirmed sandbox deletion.",
    };
  }
  return { allowed: true, reason: "Review and approval gates passed." };
}

function isFullGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value);
}

function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/iu.test(value);
}

function receiptHasUniqueReservedAttempt(
  session: ValidationSession,
  receipt: FullRevalidationReceipt,
): boolean {
  const history = session.sandboxAttemptHistory ?? [];
  const sandboxIds = history.map((attempt) => attempt.sandboxId);
  const runIds = history.map((attempt) => attempt.runId);
  const historyIsClean =
    history.length > 0 &&
    history.every(
      (attempt) =>
        attempt.reservationStatus === "reserved" &&
        !attempt.duplicateSandbox &&
        !attempt.duplicateRun,
    ) &&
    new Set(sandboxIds).size === sandboxIds.length &&
    new Set(runIds).size === runIds.length;
  const purposeMatches = (purpose: DaytonaAttemptRecord["purpose"]) =>
    receipt.validationPurpose === "review-repair"
      ? purpose === "review-repair"
      : purpose === "initial-candidate" || purpose === "profile-replacement";
  const matching = history.filter(
    (attempt) =>
      attempt.reservationStatus === "reserved" &&
      attempt.disposition === "completed" &&
      purposeMatches(attempt.purpose) &&
      attempt.candidateId === receipt.candidateId &&
      attempt.sandboxId === receipt.sandboxId &&
      attempt.runId === receipt.daytonaRunId,
  );
  return historyIsClean && matching.length === 1;
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
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(pullRequest.owner) &&
      !pullRequest.owner.endsWith("-") &&
      !pullRequest.owner.includes("--") &&
      /^[A-Za-z0-9_.-]{1,100}$/u.test(pullRequest.repository) &&
      ![".", ".."].includes(pullRequest.repository) &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(
        pullRequest.baseBranch,
      ) &&
      !pullRequest.baseBranch.includes("..") &&
      !pullRequest.baseBranch.includes("//") &&
      !pullRequest.baseBranch.includes("@{") &&
      !pullRequest.baseBranch.endsWith("/") &&
      !pullRequest.baseBranch.endsWith(".") &&
      !pullRequest.baseBranch.endsWith(".lock") &&
      isFullGitObjectId(pullRequest.headSha) &&
      isFullGitObjectId(pullRequest.headTreeSha) &&
      isFullGitObjectId(pullRequest.baseSha) &&
      Number.isSafeInteger(pullRequest.number) &&
      pullRequest.number > 0 &&
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
    receipt.expectedBaseRef !== pullRequest.baseBranch ||
    receipt.observedBaseRef !== pullRequest.baseBranch ||
    receipt.expectedBaseSha.toLowerCase() !== pullRequest.baseSha.toLowerCase() ||
    receipt.observedBaseSha.toLowerCase() !== pullRequest.baseSha.toLowerCase() ||
    !isFullGitObjectId(receipt.expectedBaseSha) ||
    !isFullGitObjectId(receipt.observedBaseSha) ||
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
  const { attestationDigest, ...attestedEvidence } = receipt;
  const everyGatePassed =
    receipt.buildPassed &&
    receipt.unitTestsPassed &&
    receipt.safetyTestsPassed &&
    receipt.integrityChecksPassed &&
    receipt.braintrustScored &&
    receipt.candidateEligible;
  let referencesValid = false;
  try {
    const daytona = new URL(receipt.daytonaEvidenceRef);
    const braintrust = new URL(receipt.braintrustExperimentRef);
    referencesValid =
      receipt.sandboxId.trim() !== "" &&
      receipt.daytonaRunId.trim() !== "" &&
      receipt.braintrustProjectId.trim() !== "" &&
      receipt.braintrustExperimentId.trim() !== "" &&
      receipt.braintrustExperimentName.trim() !== "" &&
      daytona.protocol === "daytona:" &&
      daytona.hostname === "sandbox" &&
      daytona.pathname ===
        `/${encodeURIComponent(receipt.sandboxId)}/runs/${encodeURIComponent(
          receipt.daytonaRunId,
        )}` &&
      daytona.username === "" &&
      daytona.password === "" &&
      braintrust.protocol === "https:" &&
      ["braintrust.dev", "www.braintrust.dev"].includes(
        braintrust.hostname.toLowerCase(),
      ) &&
      braintrust.port === "" &&
      braintrust.username === "" &&
      braintrust.password === "" &&
      braintrust.pathname.includes(
        encodeURIComponent(receipt.braintrustExperimentName),
      );
  } catch {
    referencesValid = false;
  }
  const usedSandboxes = new Set([
    ...Object.values(session.sandboxIdsByCandidate),
    ...(session.revalidationSandboxIds ?? []),
  ]);
  const freshSandbox = !usedSandboxes.has(receipt.sandboxId);
  const repairedHeadChanged =
    session.pullRequest === undefined ||
    receipt.commitSha.toLowerCase() !== session.pullRequest.headSha.toLowerCase();
  if (
    session.mode !== "live" ||
    receipt.validationPurpose !== "review-repair" ||
    receipt.candidateId !== session.selectedCandidateId ||
    receipt.mode !== "live" ||
    receipt.sessionId !== session.sessionId ||
    receipt.policyVersion !== session.policyVersion ||
    receipt.pullRequestTarget.owner !== session.pullRequestTarget?.owner ||
    receipt.pullRequestTarget.repository !==
      session.pullRequestTarget?.repository ||
    receipt.pullRequestTarget.baseBranch !==
      session.pullRequestTarget?.baseBranch ||
    receipt.patchDigest !== session.currentPatchDigest ||
    receipt.evidenceDigest === session.currentEvidenceDigest ||
    !isFullRevalidationReceiptStructurallyValid(receipt) ||
    receipt.sourceKind !== "live-provider-evidence" ||
    !isFullGitObjectId(receipt.commitSha) ||
    !isFullGitObjectId(receipt.validatedTreeSha) ||
    !/^[0-9a-f]{64}$/iu.test(receipt.evidenceDigest) ||
    !/^[0-9a-f]{64}$/iu.test(receipt.attestationDigest) ||
    computeFullRevalidationAttestationDigest(attestedEvidence) !==
      receipt.attestationDigest ||
    receipt.executionProvider !== "daytona" ||
    receipt.evaluationProvider !== "braintrust" ||
    !receiptHasUniqueReservedAttempt(session, receipt) ||
    !referencesValid ||
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

function requireInitialValidationReceipt(
  session: ValidationSession,
  event: Extract<WorkflowEvent, { type: "CANDIDATE_SELECTED" }>,
): FullRevalidationReceipt {
  const receipt = event.receipt;
  if (receipt === undefined) {
    throw new InvalidWorkflowTransitionError(
      session.state,
      event.type,
      "Live candidate selection requires server-normalized Daytona and Braintrust evidence.",
    );
  }
  const { attestationDigest, ...attestedEvidence } = receipt;
  const mappedSandbox = session.sandboxIdsByCandidate[event.candidateId];
  const everyGatePassed =
    receipt.buildPassed &&
    receipt.unitTestsPassed &&
    receipt.safetyTestsPassed &&
    receipt.integrityChecksPassed &&
    receipt.braintrustScored &&
    receipt.candidateEligible;
  if (
    receipt.validationPurpose !== "initial-selection" ||
    receipt.mode !== "live" ||
    receipt.sessionId !== session.sessionId ||
    receipt.policyVersion !== session.policyVersion ||
    receipt.candidateId !== event.candidateId ||
    receipt.patchDigest !== event.patchDigest ||
    receipt.evidenceDigest !== event.evidenceDigest ||
    receipt.commitSha.toLowerCase() !== event.commitSha.toLowerCase() ||
    receipt.commitSha.toLowerCase() === session.repository.commitSha.toLowerCase() ||
    receipt.pullRequestTarget.owner !== session.pullRequestTarget?.owner ||
    receipt.pullRequestTarget.repository !== session.pullRequestTarget?.repository ||
    receipt.pullRequestTarget.baseBranch !== session.pullRequestTarget?.baseBranch ||
    mappedSandbox === undefined ||
    receipt.sandboxId !== mappedSandbox ||
    !receiptHasUniqueReservedAttempt(session, receipt) ||
    session.revalidationSandboxIds.includes(receipt.sandboxId) ||
    !isFullRevalidationReceiptStructurallyValid(receipt) ||
    computeFullRevalidationAttestationDigest(attestedEvidence) !==
      attestationDigest ||
    !everyGatePassed
  ) {
    throw new InvalidWorkflowTransitionError(
      session.state,
      event.type,
      "Live candidate selection must use the exact eligible receipt from its mapped Daytona sandbox and Braintrust Experiment.",
    );
  }
  return receipt;
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
  if (
    TERMINAL_STATES.has(session.state) &&
    !(session.state === "FAILED" && event.type === "DAYTONA_ATTEMPT_RECORDED")
  ) {
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

  if (event.type === "DAYTONA_ATTEMPT_RECORDED") {
    const history = session.sandboxAttemptHistory ?? [];
    const attempt = event.attempt;
    const attemptState =
      session.state === "FAILED" ? session.failure?.failedFrom : session.state;
    const stageAllowsPurpose =
      (attempt.purpose === "initial-candidate" &&
        attemptState === "PROVISIONING_SANDBOXES") ||
      (attempt.purpose === "profile-replacement" &&
        attemptState === "PROVISIONING_SANDBOXES") ||
      (attempt.purpose === "review-repair" &&
        attemptState !== undefined &&
        ["REPAIRING_REVIEW_FINDINGS", "REVALIDATING"].includes(attemptState));
    const identifierIsValid = (value: string) =>
      value === value.trim() &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(value);
    const dispositionIsValid =
      [
        "completed",
        "failed-destroyed",
        "failed-retained",
        "cleanup-failed",
      ].includes(attempt.disposition) &&
      typeof attempt.retryable === "boolean" &&
      (attempt.disposition !== "completed" || attempt.retryable === false) &&
      (!["cleanup-failed", "failed-retained"].includes(
        attempt.disposition,
      ) ||
        attempt.retryable === false);
    const duplicateSandbox = history.some(
      (item) => item.sandboxId === attempt.sandboxId,
    );
    const duplicateRun = history.some((item) => item.runId === attempt.runId);
    if (
      session.mode !== "live" ||
      !stageAllowsPurpose ||
      !session.candidateIds.includes(attempt.candidateId) ||
      !identifierIsValid(attempt.sandboxId) ||
      !identifierIsValid(attempt.runId) ||
      Number.isNaN(Date.parse(attempt.capturedAt)) ||
      !dispositionIsValid
    ) {
      throw new InvalidWorkflowTransitionError(
        session.state,
        event.type,
        "Every Daytona response must reserve a globally unique sandbox ID and run ID before its evidence is used.",
      );
    }
    const recordedAttempt = {
      ...attempt,
      reservationStatus:
        duplicateSandbox || duplicateRun ? "rejected-reuse" : "reserved",
      duplicateSandbox,
      duplicateRun,
    } as const;
    if (duplicateSandbox || duplicateRun) {
      return withState(session, "FAILED", event.at, {
        sandboxAttemptHistory: [...history, recordedAttempt],
        failure:
          session.failure ??
          {
            reason:
              "Daytona reused a sandbox ID or run ID that was already observed in this live session.",
            recoverable: false,
            failedFrom: session.state,
          },
      });
    }
    return withState(session, session.state, event.at, {
      sandboxAttemptHistory: [...history, recordedAttempt],
    });
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
      const recordedAttempts = session.sandboxAttemptHistory ?? [];
      if (
        candidateIds.length !== mappedCandidates.length ||
        candidateIds.some((candidate, index) => candidate !== mappedCandidates[index]) ||
        new Set(sandboxIds).size !== sandboxIds.length ||
        sandboxIds.some((sandboxId) => sandboxId.trim() === "") ||
        (session.mode === "live" &&
          Object.entries(event.sandboxIdsByCandidate).some(
            ([candidateId, sandboxId]) =>
              !recordedAttempts.some(
                (attempt) =>
                  attempt.candidateId === candidateId &&
                  attempt.sandboxId === sandboxId &&
                  attempt.purpose !== "review-repair",
              ),
          ))
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
      if (
        !isSha256Digest(event.patchDigest) ||
        !isSha256Digest(event.evidenceDigest)
      ) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Selected candidate must be bound to SHA-256 patch and evidence digests",
        );
      }
      const liveReceipt =
        session.mode === "live"
          ? requireInitialValidationReceipt(session, event)
          : undefined;
      return withState(session, "AWAITING_HUMAN_APPROVAL", event.at, {
        selectedCandidateId: event.candidateId,
        currentPatchDigest: event.patchDigest,
        currentEvidenceDigest: event.evidenceDigest,
        currentCommitSha: event.commitSha,
        currentValidatedTreeSha: liveReceipt?.validatedTreeSha,
        lastRevalidation: liveReceipt,
        validationRound: session.validationRound + 1,
      });
    case "PR_CREATED_OR_UPDATED": {
      const binding = currentBinding(session);
      const target = session.pullRequestTarget;
      if (
        event.pullRequest.sessionId !== session.sessionId ||
        event.pullRequest.candidateId !== session.selectedCandidateId ||
        event.pullRequest.provider !== "github" ||
        event.pullRequest.status !== "open" ||
        !isCanonicalGitHubPullRequest(event.pullRequest) ||
        target === undefined ||
        event.pullRequest.owner !== target.owner ||
        event.pullRequest.repository !== target.repository ||
        event.pullRequest.baseBranch !== target.baseBranch ||
        event.pullRequest.baseSha.toLowerCase() !==
          session.repository.commitSha.toLowerCase() ||
        binding === undefined ||
        !isApprovalValid(session.approval, binding) ||
        event.pullRequest.headSha.toLowerCase() !== binding.commitSha.toLowerCase() ||
        (session.currentValidatedTreeSha !== undefined &&
          event.pullRequest.headTreeSha.toLowerCase() !==
            session.currentValidatedTreeSha.toLowerCase())
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
      if (!isSha256Digest(event.patchDigest)) {
        throw new InvalidWorkflowTransitionError(
          session.state,
          event.type,
          "Repaired candidate must be bound to a SHA-256 patch digest",
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
            pullRequestTarget: session.pullRequestTarget,
          }
        : undefined;
      return withState(session, "REVALIDATING", event.at, {
        selectedCandidateId: event.candidateId,
        currentPatchDigest: event.patchDigest,
        currentCommitSha: undefined,
        currentValidatedTreeSha: undefined,
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
              pullRequestTarget: session.pullRequestTarget,
            }
          : undefined;
      return withState(session, "AWAITING_HUMAN_APPROVAL", event.at, {
        currentEvidenceDigest: event.receipt.evidenceDigest,
        currentPatchDigest: event.receipt.patchDigest,
        currentCommitSha: event.receipt.commitSha,
        currentValidatedTreeSha: event.receipt.validatedTreeSha,
        approval: binding
          ? invalidateApprovalWhenEvidenceChanges(existingApproval, binding, event.at)
          : existingApproval,
        validationRound: session.validationRound + 1,
        lastRevalidation: event.receipt,
        revalidationSandboxIds: [
          ...(session.revalidationSandboxIds ?? []),
          event.receipt.sandboxId,
        ],
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
