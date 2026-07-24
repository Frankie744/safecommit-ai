import { z } from "zod";

import {
  computeEvidenceDigest,
  createDatabaseApproval,
  isDatabaseApprovalValid,
  type DatabaseApproval,
  type DatabaseApprovalBinding,
} from "@safeflash/domain";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const CandidateSchema = z.object({
  plan: z.object({
    candidateId: z.string().min(1),
  }).passthrough(),
  evidence: z.object({
    candidateId: z.string().min(1),
    sourceCommitSha: CommitSchema,
    snapshotDigest: DigestSchema,
    planDigest: DigestSchema,
    intentContractDigest: DigestSchema,
    schemaFingerprint: DigestSchema,
  }).passthrough(),
  gates: z.object({
    eligible: z.boolean(),
    failedGateNames: z.array(z.string()),
  }).passthrough(),
}).passthrough();

const LiveEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.literal("live"),
  status: z.literal("AWAITING_HUMAN_APPROVAL"),
  liveCertified: z.literal(false),
  sourceCommitSha: CommitSchema,
  sessionId: z.string().min(1),
  profile: z.object({
    fixtureSourceDigest: DigestSchema,
    schemaFingerprint: DigestSchema,
  }).passthrough(),
  candidates: z.array(CandidateSchema).min(1),
  rankings: z.array(
    z.object({
      candidateId: z.string().min(1),
      eligible: z.boolean(),
      evidenceDigest: DigestSchema,
    }).passthrough(),
  ).min(1),
  winnerCandidateId: z.string().min(1),
}).passthrough();

export interface LiveDatabaseApprovalProfile {
  readonly fixtureSourceDigest: string;
  readonly schemaFingerprint: string;
  readonly intentContractDigest: string;
  readonly policyVersion: string;
}

export interface LiveDatabaseApprovalReceipt {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly provenance: "human-approval";
  readonly status: "SAFE_TO_COMMIT";
  readonly liveCertified: true;
  readonly sourceEvidence: {
    readonly liveRunId: string;
    readonly artifactSha256: string;
    readonly sourceCommitSha: string;
    readonly sessionId: string;
    readonly providerEvidenceStatus: "AWAITING_HUMAN_APPROVAL";
  };
  readonly authorization: {
    readonly source: "active-user-request";
    readonly statementDigest: string;
  };
  readonly approval: DatabaseApproval;
  readonly guardrails: {
    readonly productionCommitExecuted: false;
    readonly pullRequestMerged: false;
    readonly publicMutationControls: false;
  };
  readonly claim: string;
}

export function createLiveDatabaseApprovalReceipt(input: {
  readonly evidence: unknown;
  readonly liveRunId: string;
  readonly artifactSha256: string;
  readonly expectedCandidateId: string;
  readonly approverId: string;
  readonly authorizationStatementDigest: string;
  readonly approvalId: string;
  readonly timestamp: string;
  readonly profile: LiveDatabaseApprovalProfile;
}): LiveDatabaseApprovalReceipt {
  const evidence = LiveEvidenceSchema.parse(input.evidence);
  if (!/^safecommit-live-\d{8}T\d{9}Z$/u.test(input.liveRunId)) {
    throw new Error("Approval requires a valid live evidence run identifier");
  }
  for (const value of [
    input.artifactSha256,
    input.authorizationStatementDigest,
    input.profile.fixtureSourceDigest,
    input.profile.schemaFingerprint,
    input.profile.intentContractDigest,
  ]) {
    DigestSchema.parse(value);
  }
  if (
    input.approverId.trim() === "" ||
    input.approvalId.trim() === "" ||
    !Number.isFinite(Date.parse(input.timestamp))
  ) {
    throw new Error("Approval identity, identifier, and timestamp are required");
  }
  if (evidence.winnerCandidateId !== input.expectedCandidateId) {
    throw new Error("Requested candidate is not the evidence-bound winner");
  }

  const eligible = evidence.candidates.filter(
    (candidate) => candidate.gates.eligible,
  );
  if (
    eligible.length !== 1 ||
    eligible[0]?.evidence.candidateId !== evidence.winnerCandidateId ||
    eligible[0]?.plan.candidateId !== evidence.winnerCandidateId ||
    eligible[0]?.gates.failedGateNames.length !== 0
  ) {
    throw new Error("Approval requires exactly one eligible selected candidate");
  }
  const winner = eligible[0];
  const ranking = evidence.rankings.find(
    (item) => item.candidateId === evidence.winnerCandidateId,
  );
  const computedEvidenceDigest = computeEvidenceDigest(winner.evidence);
  if (
    ranking?.eligible !== true ||
    ranking.evidenceDigest !== computedEvidenceDigest ||
    winner.evidence.sourceCommitSha !== evidence.sourceCommitSha
  ) {
    throw new Error("Winner ranking or evidence digest is not internally bound");
  }
  if (
    evidence.profile.fixtureSourceDigest !== input.profile.fixtureSourceDigest ||
    winner.evidence.snapshotDigest !== input.profile.fixtureSourceDigest ||
    evidence.profile.schemaFingerprint !== input.profile.schemaFingerprint ||
    winner.evidence.schemaFingerprint !== input.profile.schemaFingerprint ||
    winner.evidence.intentContractDigest !==
      input.profile.intentContractDigest
  ) {
    throw new Error("Current policy profile does not match the live evidence");
  }

  const binding: DatabaseApprovalBinding = {
    candidateId: winner.evidence.candidateId,
    planDigest: winner.evidence.planDigest,
    intentContractDigest: winner.evidence.intentContractDigest,
    evidenceDigest: computedEvidenceDigest,
    snapshotDigest: winner.evidence.snapshotDigest,
    schemaFingerprint: winner.evidence.schemaFingerprint,
    policyVersion: input.profile.policyVersion,
    sourceCommitSha: winner.evidence.sourceCommitSha,
    approverId: input.approverId.trim(),
    timestamp: input.timestamp,
  };
  const approval = createDatabaseApproval({
    approvalId: input.approvalId,
    decision: "approved",
    binding,
  });
  if (!isDatabaseApprovalValid(approval, binding)) {
    throw new Error("Generated approval failed its evidence binding check");
  }

  return {
    schemaVersion: 1,
    capturedAt: input.timestamp,
    provenance: "human-approval",
    status: "SAFE_TO_COMMIT",
    liveCertified: true,
    sourceEvidence: {
      liveRunId: input.liveRunId,
      artifactSha256: input.artifactSha256,
      sourceCommitSha: evidence.sourceCommitSha,
      sessionId: evidence.sessionId,
      providerEvidenceStatus: evidence.status,
    },
    authorization: {
      source: "active-user-request",
      statementDigest: input.authorizationStatementDigest,
    },
    approval,
    guardrails: {
      productionCommitExecuted: false,
      pullRequestMerged: false,
      publicMutationControls: false,
    },
    claim:
      "The unique eligible plan is evidence-bound and SAFE_TO_COMMIT. No production database write or pull-request merge was executed.",
  };
}
