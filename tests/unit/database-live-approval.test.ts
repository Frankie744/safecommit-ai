import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { computeEvidenceDigest, sha256 } from "@safeflash/domain";
import {
  createLiveDatabaseApprovalReceipt,
  loadSafeCommitDatabaseProfile,
} from "@safeflash/orchestrator";
import { describe, expect, it } from "vitest";

async function fixture() {
  const root = resolve("artifacts/evidence/safecommit-database-live");
  const liveRunId = (await readFile(resolve(root, "latest-run.txt"), "utf8")).trim();
  const body = await readFile(
    resolve(root, liveRunId, "database-live-evidence.json"),
    "utf8",
  );
  const profile = await loadSafeCommitDatabaseProfile();
  return {
    evidence: JSON.parse(body) as unknown,
    liveRunId,
    artifactSha256: sha256(body),
    expectedCandidateId: "candidate-c-safe",
    approverId: "workspace-owner",
    authorizationStatementDigest: "a".repeat(64),
    approvalId: "database-approval-test",
    timestamp: "2026-07-24T14:00:00.000Z",
    profile: {
      fixtureSourceDigest: profile.fixtureSourceDigest,
      schemaFingerprint: profile.schemaFingerprint,
      intentContractDigest: computeEvidenceDigest(profile.intentContract),
      policyVersion: profile.intentContract.contractVersion,
    },
  };
}

describe("live database approval receipt", () => {
  it("binds the unique eligible live winner without executing a commit", async () => {
    const receipt = createLiveDatabaseApprovalReceipt(await fixture());
    expect(receipt).toMatchObject({
      status: "SAFE_TO_COMMIT",
      liveCertified: true,
      guardrails: {
        productionCommitExecuted: false,
        pullRequestMerged: false,
        publicMutationControls: false,
      },
      approval: {
        decision: "approved",
        binding: {
          candidateId: "candidate-c-safe",
          approverId: "workspace-owner",
        },
      },
    });
  });

  it("fails closed when a different candidate is requested", async () => {
    const input = await fixture();
    expect(() =>
      createLiveDatabaseApprovalReceipt({
        ...input,
        expectedCandidateId: "candidate-b-shipped-order",
      }),
    ).toThrow("not the evidence-bound winner");
  });
});
