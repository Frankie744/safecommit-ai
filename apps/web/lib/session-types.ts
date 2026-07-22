export type SessionMode = "live" | "cached" | "mock" | "hybrid" | "unknown";

export type ProvenanceKind =
  | "live"
  | "recorded-live"
  | "mock"
  | "local-test"
  | "manual-verified"
  | "unknown";

export type EvidenceStatus =
  | "passed"
  | "failed"
  | "running"
  | "pending"
  | "not-run";

export type DecisionAction = "approved" | "rejected" | "changes_requested";

export interface EvidenceProvenance {
  kind: ProvenanceKind;
  provider: string;
  verified: boolean;
  externalId?: string;
  capturedAt?: string;
  url?: string;
}

export interface IncidentView {
  title: string;
  summary: string;
  severity: "low" | "medium" | "high" | "critical";
  temperatureC: number | null;
  sensorFault: boolean;
  chargingEnabled: boolean;
  lastUpdatedCycles?: number;
  evidence: readonly string[];
  provenance: EvidenceProvenance;
}

export interface SafetyInvariantView {
  id: string;
  description: string;
  hardGate: boolean;
}

export interface SafetyPolicyView {
  name: string;
  version: string;
  invariants: readonly SafetyInvariantView[];
  provenance: EvidenceProvenance;
}

export interface CandidateEvidenceView {
  status: EvidenceStatus;
  summary: string;
  exitCode?: number | null;
  artifactHash?: string;
  provenance: EvidenceProvenance;
}

export interface CandidateView {
  id: string;
  label: string;
  strategy: string;
  hypothesis?: string;
  selected: boolean;
  eliminatedReason?: string;
  sandbox: {
    id?: string;
    status: string;
    isolated: boolean;
    provenance: EvidenceProvenance;
  };
  build: CandidateEvidenceView;
  tests: CandidateEvidenceView & {
    passed: number;
    total: number;
  };
  safetyGate: CandidateEvidenceView & {
    hardGatePassed: boolean | null;
    failures: readonly string[];
  };
  score: {
    weighted: number | null;
    eligible: boolean;
    experimentId?: string;
    traceId?: string;
    provenance: EvidenceProvenance;
  };
  diff?: string;
}

export interface TimelineEventView {
  id: string;
  sequence: number;
  state: string;
  title: string;
  summary: string;
  occurredAt: string;
  provenance: EvidenceProvenance;
}

export interface SessionView {
  id: string;
  mode: SessionMode;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  repository: {
    repoUrl?: string;
    commitSha: string;
  };
  incident: IncidentView;
  policy: SafetyPolicyView;
  candidates: readonly CandidateView[];
  selectedCandidateId?: string;
  currentPatchDigest?: string;
  currentEvidenceDigest?: string;
  approval?: {
    decision: DecisionAction;
    approverDisplayName?: string;
    evidenceDigest: string;
    bindingDigest?: string;
    invalidatedAt?: string;
  };
  pullRequest?: {
    number: number;
    url: string;
    status: "open" | "closed" | "merged";
    provenance: EvidenceProvenance;
  };
  events: readonly TimelineEventView[];
}

export const TERMINAL_STATES = new Set([
  "READY_TO_MERGE",
  "COMPLETED",
  "FAILED",
  "CANCELLED_BY_HUMAN",
]);
