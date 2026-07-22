import type { CandidatePatch } from "./candidate-patch";

export type IsoTimestamp = string;
export type OperatingMode = "live" | "cached" | "mock";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface DomainEntity {
  id: string;
  sessionId: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  source: string;
  sourceVersion: string;
}

export interface RepositoryRevision {
  repoUrl: string;
  commitSha: string;
}

export interface Incident extends DomainEntity {
  kind: string;
  title: string;
  summary: string;
  severity: Severity;
  evidence: readonly string[];
  repository: RepositoryRevision;
}

export interface SafetyInvariant {
  id: string;
  description: string;
  hardGate: boolean;
  expectedBehavior: string;
}

export interface SafetyPolicy extends DomainEntity {
  name: string;
  policyVersion: string;
  invariants: readonly SafetyInvariant[];
  allowedPatchPaths: readonly string[];
  protectedPaths: readonly string[];
  maxChangedFiles: number;
  maxChangedLines: number;
}

/** Persisted wrapper around the strictly validated Fireworks payload. */
export interface CandidatePatchRecord extends DomainEntity {
  proposal: CandidatePatch;
  patchDigest: string;
  model: string;
  promptVersion: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type SandboxStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "destroyed";

export interface SandboxRun extends DomainEntity {
  candidateId: string;
  provider: "daytona";
  sandboxId: string;
  status: SandboxStatus;
  repository: RepositoryRevision;
  isolatedFilesystem: boolean;
  retained: boolean;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
}

export interface CommandEvidence extends DomainEntity {
  candidateId?: string;
  sandboxId?: string;
  commitSha: string;
  argv: readonly string[];
  commandHash: string;
  artifactHash?: string;
  exitCode: number | null;
  durationMs: number;
  stdoutSummary: string;
  stderrSummary: string;
  stdoutHash?: string;
  stderrHash?: string;
  timedOut: boolean;
}

export type TestKind = "unit" | "safety" | "regression" | "integrity";
export type TestStatus = "passed" | "failed" | "skipped" | "error";

export interface TestResult extends DomainEntity {
  candidateId: string;
  sandboxId: string;
  kind: TestKind;
  name: string;
  status: TestStatus;
  durationMs: number;
  details?: string;
  evidenceId: string;
}

export interface ScorerValues {
  buildSuccess: number;
  unitTestPassRate: number;
  safetyInvariant: number;
  regressionProtection: number;
  patchIntegrity: number;
  patchMinimality: number;
  explanationGroundedness: number;
  reproducibility: number;
}

export type ScorerName = keyof ScorerValues;

export interface ScoreResult extends DomainEntity {
  candidateId: string;
  experimentId?: string;
  traceId?: string;
  values: ScorerValues;
  explanations: Partial<Record<ScorerName, string>>;
  eligible: boolean;
  hardGateFailures: readonly string[];
  weightedScore: number;
  evidenceDigest: string;
}

export interface CandidateRanking {
  candidateId: string;
  eligible: boolean;
  weightedScore: number;
  hardGateFailures: readonly string[];
  evidenceDigest: string;
}

export interface CandidateDecision extends DomainEntity {
  winnerCandidateId: string | null;
  rankings: readonly CandidateRanking[];
  rationale: string;
  selectionPolicyVersion: string;
}

export type ApprovalDecision = "approved" | "rejected" | "changes_requested";

export interface HumanApproval extends DomainEntity {
  candidateId: string;
  approverId: string;
  approverDisplayName?: string;
  decision: ApprovalDecision;
  actedAt: IsoTimestamp;
  evidenceDigest: string;
  patchDigest: string;
  policyVersion: string;
  commitSha: string;
  bindingDigest: string;
  reason?: string;
  invalidatedAt?: IsoTimestamp;
  invalidationReason?: string;
}

export interface PullRequestRecord extends DomainEntity {
  candidateId: string;
  provider: "github";
  owner: string;
  repository: string;
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  status: "open" | "closed" | "merged";
}

export interface ReviewFinding extends DomainEntity {
  provider: "coderabbit" | "manual_verified";
  reviewUrl: string;
  externalId: string;
  severity: Severity;
  title: string;
  body: string;
  filePath?: string;
  line?: number;
  resolved: boolean;
}

/**
 * Server-normalized receipt for the independent review of one exact PR head.
 * The state machine does not accept a bare, empty findings array as proof that
 * CodeRabbit ran: a pass or block must be tied to concrete review evidence.
 */
export interface IndependentReviewReceipt {
  provider: "coderabbit" | "manual_verified";
  sourceKind: "live-api" | "manual-attestation";
  status: "passed" | "blocked";
  pullNumber: number;
  headSha: string;
  reviewUrl: string;
  evidenceIds: readonly string[];
  capturedAt: IsoTimestamp;
  attestedBy?: string;
}

/**
 * Fail-closed proof that a review repair re-entered every required validation
 * stage. Provider adapters create this receipt only after their own evidence
 * and provenance checks have succeeded.
 */
export interface FullRevalidationReceipt {
  candidateId: string;
  patchDigest: string;
  commitSha: string;
  evidenceDigest: string;
  executionProvider: "daytona";
  evaluationProvider: "braintrust";
  sandboxId: string;
  daytonaEvidenceRef: string;
  braintrustExperimentRef: string;
  buildPassed: boolean;
  unitTestsPassed: boolean;
  safetyTestsPassed: boolean;
  integrityChecksPassed: boolean;
  braintrustScored: boolean;
  candidateEligible: boolean;
}

export type ValidationState =
  | "IDLE"
  | "INGESTING_REPOSITORY"
  | "ANALYZING_INCIDENT"
  | "GENERATING_CANDIDATES"
  | "PROVISIONING_SANDBOXES"
  | "BUILDING"
  | "RUNNING_TESTS"
  | "SCORING"
  | "SELECTING"
  | "AWAITING_HUMAN_APPROVAL"
  | "CREATING_PULL_REQUEST"
  | "AWAITING_CODERABBIT"
  | "REVIEW_BLOCKED"
  | "REVIEW_PASSED"
  | "REPAIRING_REVIEW_FINDINGS"
  | "REVALIDATING"
  | "READY_TO_MERGE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED_BY_HUMAN";

export interface WorkflowFailure {
  reason: string;
  recoverable: boolean;
  retryAction?: string;
  failedFrom: ValidationState;
}

export interface ValidationSession extends DomainEntity {
  mode: OperatingMode;
  runKind: "single" | "tournament";
  state: ValidationState;
  incidentId: string;
  policyId: string;
  policyVersion: string;
  repository: RepositoryRevision;
  candidateIds: readonly string[];
  sandboxIdsByCandidate: Readonly<Record<string, string>>;
  selectedCandidateId?: string;
  currentPatchDigest?: string;
  currentEvidenceDigest?: string;
  /** Commit at the current approved/validated PR head; repository.commitSha is the ingested base. */
  currentCommitSha?: string;
  approval?: HumanApproval;
  pullRequest?: PullRequestRecord;
  reviewFindings: readonly ReviewFinding[];
  reviewReceipt?: IndependentReviewReceipt;
  lastRevalidation?: FullRevalidationReceipt;
  validationRound: number;
  failure?: WorkflowFailure;
}

export interface AuditEvent extends DomainEntity {
  sequence: number;
  eventType: string;
  fromState?: ValidationState;
  toState?: ValidationState;
  actor: string;
  mode: OperatingMode;
  payload: JsonObject;
  previousEventHash?: string;
  eventHash: string;
}
