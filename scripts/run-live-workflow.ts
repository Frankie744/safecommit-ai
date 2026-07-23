import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  createProductionLiveSafetyWorkflow,
  requireSafeLiveSessionId,
  type LiveWorkflowSnapshot,
} from "@safeflash/orchestrator";
import {
  ProviderResponseError,
  redactProviderError,
  redactSecrets,
} from "@safeflash/integrations";

const MAX_RESUMABLE_ATTEMPTS = 3;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sessionId(): string {
  const supplied = argument("--session")?.trim();
  return requireSafeLiveSessionId(
    supplied !== undefined && supplied !== ""
      ? supplied
      : `live-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
}

function approvalBinding(snapshot: LiveWorkflowSnapshot) {
  const session = snapshot.session;
  if (
    session.selectedCandidateId === undefined ||
    session.currentPatchDigest === undefined ||
    session.currentEvidenceDigest === undefined ||
    session.currentCommitSha === undefined
  ) {
    throw new Error("Live snapshot has no complete approval binding");
  }
  return {
    candidateId: session.selectedCandidateId,
    patchDigest: session.currentPatchDigest,
    evidenceDigest: session.currentEvidenceDigest,
    commitSha: session.currentCommitSha,
    policyVersion: session.policyVersion,
  };
}

function printSnapshot(snapshot: LiveWorkflowSnapshot): void {
  const binding = approvalBinding(snapshot);
  console.log(`\nState: ${snapshot.session.state}`);
  console.log(`Candidate: ${binding.candidateId}`);
  console.log(`Strategy: ${snapshot.selectedCandidate.strategy}`);
  console.log(`Patch digest: ${binding.patchDigest}`);
  console.log(`Evidence digest: ${binding.evidenceDigest}`);
  console.log(`Prepared commit: ${binding.commitSha}`);
  console.log(`Daytona: ${snapshot.providerEvidence.daytonaSandboxId}`);
  console.log(`Braintrust: ${snapshot.providerEvidence.braintrustExperimentUrl}`);
  console.log(`Trace: ${snapshot.providerEvidence.braintrustTraceUrl}`);
  console.log(`Branch: ${snapshot.providerEvidence.headBranch}`);
  console.log("\nCandidate diff:\n");
  console.log(snapshot.selectedCandidate.unifiedDiff);
}

interface EvidenceLog {
  schemaVersion: 1;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  snapshots: Array<{
    stage: string;
    capturedAt: string;
    snapshot: LiveWorkflowSnapshot;
  }>;
  errors: Array<{
    stage: string;
    capturedAt: string;
    message: string;
  }>;
}

async function persistEvidence(
  evidencePath: string,
  evidence: EvidenceLog,
): Promise<void> {
  evidence.updatedAt = new Date().toISOString();
  await mkdir(dirname(evidencePath), { recursive: true });
  const serialized = redactSecrets(
    `${JSON.stringify(evidence, null, 2)}\n`,
    process.env,
  );
  await writeFile(evidencePath, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Live workflow requires an interactive TTY for evidence-bound human approval",
    );
  }
  const id = sessionId();
  const approverId =
    argument("--approver")?.trim() ||
    process.env.SAFEFLASH_APPROVER_ID?.trim() ||
    process.env.USERNAME ||
    "operator";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(approverId)) {
    throw new Error(
      "--approver/SAFEFLASH_APPROVER_ID must be a safe 1-100 character operator identifier",
    );
  }
  const evidencePath = resolve(
    process.cwd(),
    ".safeflash",
    "live-evidence",
    `${id}.json`,
  );
  const startedAt = new Date().toISOString();
  const evidence: EvidenceLog = {
    schemaVersion: 1,
    sessionId: id,
    startedAt,
    updatedAt: startedAt,
    snapshots: [],
    errors: [],
  };
  const saveSnapshot = async (stage: string, snapshot: LiveWorkflowSnapshot) => {
    evidence.snapshots.push({
      stage,
      capturedAt: new Date().toISOString(),
      snapshot,
    });
    await persistEvidence(evidencePath, evidence);
  };
  const saveError = async (stage: string, error: unknown) => {
    evidence.errors.push({
      stage,
      capturedAt: new Date().toISOString(),
      message: redactProviderError(error),
    });
    await persistEvidence(evidencePath, evidence);
  };

  // This preflight reads every provider credential before any network call.
  const workflow = createProductionLiveSafetyWorkflow();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Starting official live workflow ${id} ...`);
    let snapshot = await workflow.startTournament(id);
    await saveSnapshot("initial-selection", snapshot);

    while (true) {
      printSnapshot(snapshot);
      const binding = approvalBinding(snapshot);
      const exactApproval = `APPROVE ${binding.evidenceDigest}`;
      const answer = (
        await terminal.question(
          `\nType exactly "${exactApproval}" to authorize one GitHub publication, or REJECT to stop: `,
        )
      ).trim();
      if (answer !== exactApproval) {
        if (answer.toUpperCase() === "REJECT") {
          snapshot = await workflow.recordHumanDecision({
            sessionId: id,
            approverId,
            decision: "rejected",
            reason: "Rejected from the interactive live workflow CLI",
            expected: binding,
          });
          await saveSnapshot("human-rejected", snapshot);
        }
        console.log("No GitHub write was authorized. Exiting.");
        return;
      }

      snapshot = await workflow.recordHumanDecision({
        sessionId: id,
        approverId,
        decision: "approved",
        reason: "Exact evidence digest approved in the interactive live workflow CLI",
        expected: binding,
      });
      await saveSnapshot("human-approved", snapshot);

      let completedReview = false;
      for (let attempt = 1; attempt <= MAX_RESUMABLE_ATTEMPTS; attempt += 1) {
        try {
          snapshot = await workflow.publishApprovedAndReview(id);
          await saveSnapshot(`publication-review-attempt-${attempt}`, snapshot);
          completedReview = true;
          break;
        } catch (error) {
          await saveError(`publication-review-attempt-${attempt}`, error);
          const state = workflow.getSession(id).state;
          if (
            attempt === MAX_RESUMABLE_ATTEMPTS ||
            !(error instanceof ProviderResponseError) ||
            !error.retryable ||
            !["CREATING_PULL_REQUEST", "AWAITING_CODERABBIT"].includes(state)
          ) {
            throw error;
          }
          console.log(`Resuming idempotent ${state} step (${attempt + 1}/${MAX_RESUMABLE_ATTEMPTS}) ...`);
        }
      }
      if (!completedReview) throw new Error("Review did not reach a terminal result");

      if (snapshot.session.state === "READY_TO_MERGE") {
        console.log("\nCodeRabbit passed the exact PR head. READY_TO_MERGE; SafeFlash never merges automatically.");
        console.log(`Evidence saved to ${evidencePath}`);
        return;
      }
      if (snapshot.session.state !== "REVIEW_BLOCKED") {
        throw new Error(`Unexpected post-review state: ${snapshot.session.state}`);
      }

      console.log("\nCodeRabbit blocked the exact PR head. Starting bounded Fireworks repair and fresh Daytona/Braintrust validation ...");
      let repaired = false;
      for (let attempt = 1; attempt <= MAX_RESUMABLE_ATTEMPTS; attempt += 1) {
        try {
          snapshot = await workflow.repairBlockedReview(id);
          await saveSnapshot(`review-repair-attempt-${attempt}`, snapshot);
          repaired = true;
          break;
        } catch (error) {
          await saveError(`review-repair-attempt-${attempt}`, error);
          const state = workflow.getSession(id).state;
          if (
            attempt === MAX_RESUMABLE_ATTEMPTS ||
            !(error instanceof ProviderResponseError) ||
            !error.retryable ||
            !["REPAIRING_REVIEW_FINDINGS", "REVALIDATING"].includes(state)
          ) {
            throw error;
          }
          console.log(`Resuming repair checkpoint (${attempt + 1}/${MAX_RESUMABLE_ATTEMPTS}) ...`);
        }
      }
      if (!repaired || snapshot.session.state !== "AWAITING_HUMAN_APPROVAL") {
        throw new Error("Repair did not produce fresh approval-bound evidence");
      }
      console.log("\nRepair passed fresh provider validation. The old approval is invalid; review and approve the new digest.");
    }
  } catch (error) {
    await saveError("fatal", error);
    throw error;
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Live workflow failed: ${redactProviderError(error)}`);
  process.exitCode = 1;
});
