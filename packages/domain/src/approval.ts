import { computeEvidenceDigest } from "./evidence";
import type { HumanApproval, IsoTimestamp, PullRequestTarget } from "./types";

export interface ApprovalBinding {
  candidateId: string;
  patchDigest: string;
  evidenceDigest: string;
  policyVersion: string;
  commitSha: string;
  pullRequestTarget?: PullRequestTarget;
}

export interface CreateApprovalInput extends ApprovalBinding {
  id: string;
  sessionId: string;
  approverId: string;
  approverDisplayName?: string;
  decision: HumanApproval["decision"];
  source?: string;
  sourceVersion: string;
  actedAt: IsoTimestamp;
  reason?: string;
}

export function computeApprovalBindingDigest(binding: ApprovalBinding): string {
  return computeEvidenceDigest(binding);
}

export function createHumanApproval(input: CreateApprovalInput): HumanApproval {
  const binding: ApprovalBinding = {
    candidateId: input.candidateId,
    patchDigest: input.patchDigest,
    evidenceDigest: input.evidenceDigest,
    policyVersion: input.policyVersion,
    commitSha: input.commitSha,
    pullRequestTarget:
      input.pullRequestTarget === undefined
        ? undefined
        : { ...input.pullRequestTarget },
  };

  return {
    id: input.id,
    sessionId: input.sessionId,
    createdAt: input.actedAt,
    updatedAt: input.actedAt,
    source: input.source ?? "human",
    sourceVersion: input.sourceVersion,
    candidateId: input.candidateId,
    approverId: input.approverId,
    approverDisplayName: input.approverDisplayName,
    decision: input.decision,
    actedAt: input.actedAt,
    evidenceDigest: input.evidenceDigest,
    patchDigest: input.patchDigest,
    policyVersion: input.policyVersion,
    commitSha: input.commitSha,
    pullRequestTarget:
      input.pullRequestTarget === undefined
        ? undefined
        : { ...input.pullRequestTarget },
    bindingDigest: computeApprovalBindingDigest(binding),
    reason: input.reason,
  };
}

export function isApprovalValid(
  approval: HumanApproval | undefined,
  current: ApprovalBinding,
): boolean {
  if (
    approval === undefined ||
    approval.decision !== "approved" ||
    approval.invalidatedAt !== undefined
  ) {
    return false;
  }

  return (
    approval.bindingDigest === computeApprovalBindingDigest(current) &&
    approval.candidateId === current.candidateId &&
    approval.patchDigest === current.patchDigest &&
    approval.evidenceDigest === current.evidenceDigest &&
    approval.policyVersion === current.policyVersion &&
    approval.commitSha === current.commitSha &&
    computeEvidenceDigest(approval.pullRequestTarget ?? null) ===
      computeEvidenceDigest(current.pullRequestTarget ?? null)
  );
}

export function invalidateApprovalWhenEvidenceChanges(
  approval: HumanApproval | undefined,
  current: ApprovalBinding,
  at: IsoTimestamp,
): HumanApproval | undefined {
  if (approval === undefined || isApprovalValid(approval, current)) {
    return approval;
  }

  if (approval.invalidatedAt !== undefined) {
    return approval;
  }

  return {
    ...approval,
    updatedAt: at,
    invalidatedAt: at,
    invalidationReason:
      "The candidate patch or its validation evidence changed after approval.",
  };
}
