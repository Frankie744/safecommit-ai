import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  computeEvidenceDigest,
  sha256,
} from "@safeflash/domain";
import {
  createLiveDatabaseApprovalReceipt,
  loadSafeCommitDatabaseProfile,
} from "@safeflash/orchestrator";

const LIVE_EVIDENCE_ROOT = resolve(
  "artifacts/evidence/safecommit-database-live",
);
const APPROVAL_ROOT = resolve(
  "artifacts/evidence/safecommit-database-approval",
);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    throw new Error(`Missing required argument ${name}`);
  }
  return value.trim();
}

function timestampId(now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, "");
}

async function main(): Promise<void> {
  if (process.env.SAFECOMMIT_ALLOW_HUMAN_APPROVAL !== "true") {
    throw new Error("SAFECOMMIT_ALLOW_HUMAN_APPROVAL must equal true");
  }

  const expectedCandidateId = argument("--candidate");
  const approverId = argument("--approver");
  const authorizationStatement = argument("--authorization-statement");
  const liveRunId = (
    await readFile(resolve(LIVE_EVIDENCE_ROOT, "latest-run.txt"), "utf8")
  ).trim();
  const liveArtifactPath = resolve(
    LIVE_EVIDENCE_ROOT,
    liveRunId,
    "database-live-evidence.json",
  );
  const manifest = (
    await readFile(
      resolve(LIVE_EVIDENCE_ROOT, liveRunId, "manifest.sha256"),
      "utf8",
    )
  ).trim();
  const liveArtifactBody = await readFile(liveArtifactPath, "utf8");
  const artifactSha256 = sha256(liveArtifactBody);
  if (manifest !== `${artifactSha256}  database-live-evidence.json`) {
    throw new Error("Live evidence manifest does not match the source artifact");
  }

  const profile = await loadSafeCommitDatabaseProfile();
  const now = new Date();
  const receipt = createLiveDatabaseApprovalReceipt({
    evidence: JSON.parse(liveArtifactBody) as unknown,
    liveRunId,
    artifactSha256,
    expectedCandidateId,
    approverId,
    authorizationStatementDigest: computeEvidenceDigest({
      source: "active-user-request",
      statement: authorizationStatement,
    }),
    approvalId: `database-approval-${randomUUID()}`,
    timestamp: now.toISOString(),
    profile: {
      fixtureSourceDigest: profile.fixtureSourceDigest,
      schemaFingerprint: profile.schemaFingerprint,
      intentContractDigest: computeEvidenceDigest(profile.intentContract),
      policyVersion: profile.intentContract.contractVersion,
    },
  });

  const runId = `safecommit-approval-${timestampId(now)}`;
  const runRoot = resolve(APPROVAL_ROOT, runId);
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const digest = sha256(body);
  await mkdir(runRoot, { recursive: true });
  await Promise.all([
    writeFile(resolve(runRoot, "database-approval.json"), body, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(
      resolve(runRoot, "manifest.sha256"),
      `${digest}  database-approval.json\n`,
      { encoding: "utf8", flag: "wx" },
    ),
  ]);
  await writeFile(
    resolve(APPROVAL_ROOT, "latest-run.txt"),
    `${runId}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "approved",
      status: receipt.status,
      liveCertified: receipt.liveCertified,
      approvalId: receipt.approval.approvalId,
      bindingDigest: receipt.approval.bindingDigest,
      candidateId: receipt.approval.binding.candidateId,
      sourceCommitSha: receipt.approval.binding.sourceCommitSha,
      productionCommitExecuted:
        receipt.guardrails.productionCommitExecuted,
      pullRequestMerged: receipt.guardrails.pullRequestMerged,
      runId,
    }, null, 2)}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
