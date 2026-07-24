import { computeEvidenceDigest } from "./evidence";

export interface DatabaseApprovalBinding {
  candidateId: string;
  planDigest: string;
  intentContractDigest: string;
  evidenceDigest: string;
  snapshotDigest: string;
  schemaFingerprint: string;
  policyVersion: string;
  sourceCommitSha: string;
  approverId: string;
  timestamp: string;
}

export interface DatabaseApproval {
  approvalId: string;
  decision: "approved" | "rejected" | "changes_requested";
  binding: DatabaseApprovalBinding;
  bindingDigest: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export function computeDatabaseApprovalBindingDigest(
  binding: DatabaseApprovalBinding,
): string {
  return computeEvidenceDigest(binding);
}

export function createDatabaseApproval(input: {
  approvalId: string;
  decision: DatabaseApproval["decision"];
  binding: DatabaseApprovalBinding;
}): DatabaseApproval {
  const binding = { ...input.binding };
  return {
    approvalId: input.approvalId,
    decision: input.decision,
    binding,
    bindingDigest: computeDatabaseApprovalBindingDigest(binding),
  };
}

export function isDatabaseApprovalValid(
  approval: DatabaseApproval | undefined,
  current: DatabaseApprovalBinding,
): boolean {
  return (
    approval !== undefined &&
    approval.decision === "approved" &&
    approval.invalidatedAt === undefined &&
    approval.bindingDigest === computeDatabaseApprovalBindingDigest(current)
  );
}

export function invalidateDatabaseApproval(
  approval: DatabaseApproval | undefined,
  current: DatabaseApprovalBinding,
  at: string,
): DatabaseApproval | undefined {
  if (
    approval === undefined ||
    approval.invalidatedAt !== undefined ||
    isDatabaseApprovalValid(approval, current)
  ) {
    return approval;
  }
  return {
    ...approval,
    invalidatedAt: at,
    invalidationReason:
      "The approved database plan, snapshot, policy, schema, source revision, or execution evidence changed.",
  };
}
