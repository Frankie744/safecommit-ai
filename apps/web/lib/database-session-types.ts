export type DatabaseSessionProvenance =
  | "LIVE"
  | "RECORDED_LIVE"
  | "LOCAL_TEST"
  | "MOCK";

export type DatabaseSessionState =
  | "AWAITING_HUMAN_APPROVAL"
  | "SAFE_TO_COMMIT"
  | "BLOCKED"
  | "FAILED";

export interface DatabaseGateView {
  name: string;
  passed: boolean;
  explanation: string;
}

export interface DatabaseRowDeltaView {
  table: string;
  id: string;
  changeKind: "inserted" | "updated" | "deleted";
  summary: string;
}

export interface DatabaseCandidateView {
  candidateId: string;
  strategy:
    | "conservative"
    | "relationship-preserving"
    | "aggressive-cleanup";
  hypothesis: string;
  eligible: boolean;
  weightedScore: number;
  failedGateNames: readonly string[];
  affectedRows: number;
  touchedWarehouses: readonly string[];
  inventoryDeltaUnits: number;
  planDigest: string;
  evidenceDigest: string;
  gates: readonly DatabaseGateView[];
  rowDelta: readonly DatabaseRowDeltaView[];
}

export interface DatabaseApprovalView {
  approvalId: string;
  decision: "approved" | "rejected" | "changes_requested";
  approverId: string;
  actedAt: string;
  bindingDigest: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface DatabaseAuditEventView {
  sequence: number;
  eventType: string;
  occurredAt: string;
  previousEventHash: string | null;
  eventHash: string;
}

export interface DatabaseSessionView {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  provenance: DatabaseSessionProvenance;
  providerVerified: boolean;
  fixtureKind: "OpenBoxes-derived executable fixture";
  state: DatabaseSessionState;
  task: {
    taskId: string;
    naturalLanguageRequest: string;
    allowedWarehouses: readonly string[];
    allowedTenants: readonly string[];
    maxAffectedRows: number;
  };
  sourceCommitSha: string;
  snapshotDigest: string;
  schemaFingerprint: string;
  intentContractDigest: string;
  currentEvidenceDigest: string;
  policyVersion: string;
  candidates: readonly DatabaseCandidateView[];
  winnerCandidateId: string | null;
  approval?: DatabaseApprovalView;
  auditEvents: readonly DatabaseAuditEventView[];
  blockedReason?: string;
  liveStatus: {
    fireworks: "PASS" | "BLOCKED";
    daytona: "PASS" | "BLOCKED";
    braintrust: "PASS" | "BLOCKED";
    copilotKitHitl: "PASS" | "BLOCKED";
  };
}
