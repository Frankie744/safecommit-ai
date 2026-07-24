import { describe, expect, it } from "vitest";

import {
  createDatabaseApproval,
  invalidateDatabaseApproval,
  isDatabaseApprovalValid,
  type DatabaseApprovalBinding,
} from "@safeflash/domain";

function binding(): DatabaseApprovalBinding {
  return {
    candidateId: "candidate-safe",
    planDigest: "1".repeat(64),
    intentContractDigest: "2".repeat(64),
    evidenceDigest: "3".repeat(64),
    snapshotDigest: "4".repeat(64),
    schemaFingerprint: "5".repeat(64),
    policyVersion: "safecommit-logistics-v1",
    sourceCommitSha: "6".repeat(40),
    approverId: "operator-1",
    timestamp: "2026-07-24T00:00:00.000Z",
  };
}

describe("database approval binding", () => {
  it("invalidates approval when any database evidence field changes", () => {
    const original = binding();
    const approval = createDatabaseApproval({
      approvalId: "approval-database-1",
      decision: "approved",
      binding: original,
    });
    expect(isDatabaseApprovalValid(approval, original)).toBe(true);

    for (const changed of [
      { ...original, planDigest: "a".repeat(64) },
      { ...original, intentContractDigest: "b".repeat(64) },
      { ...original, evidenceDigest: "c".repeat(64) },
      { ...original, snapshotDigest: "d".repeat(64) },
      { ...original, schemaFingerprint: "e".repeat(64) },
      { ...original, policyVersion: "safecommit-logistics-v2" },
      { ...original, sourceCommitSha: "f".repeat(40) },
    ]) {
      const invalidated = invalidateDatabaseApproval(
        approval,
        changed,
        "2026-07-24T00:01:00.000Z",
      );
      expect(invalidated?.invalidatedAt).toBe("2026-07-24T00:01:00.000Z");
      expect(isDatabaseApprovalValid(invalidated, changed)).toBe(false);
    }
  });
});
