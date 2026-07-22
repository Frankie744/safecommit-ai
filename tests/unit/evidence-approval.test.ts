import { describe, expect, it } from "vitest";

import {
  computeEvidenceDigest,
  createHumanApproval,
  invalidateApprovalWhenEvidenceChanges,
  isApprovalValid,
} from "../../packages/domain/src/index";

const at = "2026-07-22T12:00:00.000Z";

describe("evidence and approval binding", () => {
  it("canonical evidence digest is stable across object key order", () => {
    expect(computeEvidenceDigest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      computeEvidenceDigest({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(computeEvidenceDigest({ command: ["ctest"], exitCode: 0 })).not.toBe(
      computeEvidenceDigest({ command: ["ctest"], exitCode: 1 }),
    );
  });

  it("approval_invalidated_when_patch_changes", () => {
    const originalBinding = {
      candidateId: "candidate-safe",
      patchDigest: "patch-v1",
      evidenceDigest: "evidence-v1",
      policyVersion: "policy-v1",
      commitSha: "0123456789abcdef",
    };
    const approval = createHumanApproval({
      id: "approval-1",
      sessionId: "session-1",
      approverId: "judge-1",
      decision: "approved",
      sourceVersion: "approval-v1",
      actedAt: at,
      ...originalBinding,
    });

    expect(isApprovalValid(approval, originalBinding)).toBe(true);

    const changedBinding = { ...originalBinding, patchDigest: "patch-v2" };
    const invalidated = invalidateApprovalWhenEvidenceChanges(
      approval,
      changedBinding,
      "2026-07-22T12:01:00.000Z",
    );

    expect(invalidated?.invalidatedAt).toBe("2026-07-22T12:01:00.000Z");
    expect(isApprovalValid(invalidated, changedBinding)).toBe(false);
  });
});

