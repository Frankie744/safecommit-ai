import { computeEvidenceDigest } from "./evidence";
import type { FullRevalidationReceipt } from "./types";

export type RevalidationReceiptEvidence = Omit<
  FullRevalidationReceipt,
  "attestationDigest"
>;

/**
 * Integrity seal for the server-normalized receipt. This is not a signature;
 * trust comes from the server-only live provider factory. The digest prevents
 * accidental or persisted-field mutation after that factory has validated the
 * provider envelopes.
 */
export function computeFullRevalidationAttestationDigest(
  evidence: RevalidationReceiptEvidence,
): string {
  return computeEvidenceDigest({
    schemaVersion: 1,
    kind: "safeflash-live-revalidation-receipt",
    ...evidence,
  });
}

export function isFullRevalidationReceiptStructurallyValid(
  receipt: FullRevalidationReceipt,
): boolean {
  try {
    const daytona = new URL(receipt.daytonaEvidenceRef);
    const braintrust = new URL(receipt.braintrustExperimentRef);
    const { attestationDigest, ...evidence } = receipt;
    return (
      receipt.sourceKind === "live-provider-evidence" &&
      receipt.mode === "live" &&
      ["initial-selection", "review-repair"].includes(
        receipt.validationPurpose,
      ) &&
      receipt.sessionId.trim() !== "" &&
      receipt.policyVersion.trim() !== "" &&
      receipt.executionProvider === "daytona" &&
      receipt.evaluationProvider === "braintrust" &&
      receipt.buildPassed &&
      receipt.unitTestsPassed &&
      receipt.safetyTestsPassed &&
      receipt.integrityChecksPassed &&
      receipt.braintrustScored &&
      receipt.candidateEligible &&
      receipt.candidateId.trim() !== "" &&
      receipt.pullRequestTarget.provider === "github" &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(
        receipt.pullRequestTarget.owner,
      ) &&
      !receipt.pullRequestTarget.owner.endsWith("-") &&
      !receipt.pullRequestTarget.owner.includes("--") &&
      /^[A-Za-z0-9_.-]{1,100}$/u.test(
        receipt.pullRequestTarget.repository,
      ) &&
      ![".", ".."].includes(receipt.pullRequestTarget.repository) &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(
        receipt.pullRequestTarget.baseBranch,
      ) &&
      !receipt.pullRequestTarget.baseBranch.includes("..") &&
      !receipt.pullRequestTarget.baseBranch.includes("//") &&
      !receipt.pullRequestTarget.baseBranch.includes("@{") &&
      !receipt.pullRequestTarget.baseBranch.endsWith("/") &&
      !receipt.pullRequestTarget.baseBranch.endsWith(".") &&
      !receipt.pullRequestTarget.baseBranch.endsWith(".lock") &&
      /^[0-9a-f]{64}$/iu.test(receipt.patchDigest) &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(receipt.commitSha) &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(receipt.validatedTreeSha) &&
      /^[0-9a-f]{64}$/iu.test(receipt.evidenceDigest) &&
      /^[0-9a-f]{64}$/iu.test(receipt.attestationDigest) &&
      receipt.sandboxId.trim() !== "" &&
      receipt.daytonaRunId.trim() !== "" &&
      receipt.braintrustProjectId.trim() !== "" &&
      receipt.braintrustExperimentId.trim() !== "" &&
      receipt.braintrustExperimentName.trim() !== "" &&
      daytona.protocol === "daytona:" &&
      daytona.hostname === "sandbox" &&
      daytona.pathname ===
        `/${encodeURIComponent(receipt.sandboxId)}/runs/${encodeURIComponent(
          receipt.daytonaRunId,
        )}` &&
      daytona.username === "" &&
      daytona.password === "" &&
      braintrust.protocol === "https:" &&
      ["braintrust.dev", "www.braintrust.dev"].includes(
        braintrust.hostname.toLowerCase(),
      ) &&
      braintrust.port === "" &&
      braintrust.username === "" &&
      braintrust.password === "" &&
      braintrust.pathname.includes(
        encodeURIComponent(receipt.braintrustExperimentName),
      ) &&
      computeFullRevalidationAttestationDigest(evidence) === attestationDigest
    );
  } catch {
    return false;
  }
}
