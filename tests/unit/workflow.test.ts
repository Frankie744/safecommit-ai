import { describe, expect, it } from "vitest";

import {
  InvalidWorkflowTransitionError,
  computeFullRevalidationAttestationDigest,
  createHumanApproval,
  createValidationSession,
  evaluateCodeRabbitGate,
  transitionValidationSession,
  type FullRevalidationReceipt,
  type IndependentReviewReceipt,
  type PullRequestRecord,
  type ReviewFinding,
  type ValidationSession,
} from "../../packages/domain/src/index";

const t = "2026-07-22T12:00:00.000Z";
const INITIAL_SHA = "a".repeat(40);
const REPAIRED_SHA = "b".repeat(40);
const PATCH_V1 = "1".repeat(64);
const PATCH_V2 = "2".repeat(64);

function awaitingApproval(): ValidationSession {
  return {
    ...createValidationSession({
      id: "session-1",
      incidentId: "incident-1",
      policyId: "policy-1",
      policyVersion: "policy-v1",
      repository: {
        repoUrl: "https://github.example/safe-flash/demo.git",
        commitSha: INITIAL_SHA,
      },
      pullRequestTarget: {
        provider: "github",
        owner: "safe-flash",
        repository: "demo",
        baseBranch: "main",
      },
      mode: "live",
      sourceVersion: "workflow-v1",
      at: t,
    }),
    state: "AWAITING_HUMAN_APPROVAL",
    candidateIds: ["candidate-safe", "candidate-a", "candidate-b"],
    selectedCandidateId: "candidate-safe",
    currentPatchDigest: PATCH_V1,
    currentEvidenceDigest: "evidence-v1",
    validationRound: 1,
  };
}

function approvalFor(session: ValidationSession) {
  return createHumanApproval({
    id: "approval-1",
    sessionId: session.sessionId,
    candidateId: session.selectedCandidateId!,
    approverId: "human-1",
    decision: "approved",
    sourceVersion: "approval-v1",
    actedAt: t,
    patchDigest: session.currentPatchDigest!,
    evidenceDigest: session.currentEvidenceDigest!,
    policyVersion: "policy-v1",
    commitSha: session.currentCommitSha!,
    pullRequestTarget: session.pullRequestTarget,
  });
}

function reviewFinding(
  severity: ReviewFinding["severity"],
  resolved = false,
  headSha = INITIAL_SHA,
): ReviewFinding {
  return {
    id: `finding-${severity}`,
    sessionId: "session-1",
    createdAt: t,
    updatedAt: t,
    source: "github-review",
    sourceVersion: headSha,
    provider: "coderabbit",
    reviewUrl: "https://github.com/safe-flash/demo/pull/1#review",
    externalId: `external-${severity}`,
    severity,
    title: `${severity} finding`,
    body: "Review evidence",
    resolved,
  };
}

function pullRequestFor(session: ValidationSession): PullRequestRecord {
  return {
    id: "pr-1",
    sessionId: session.sessionId,
    createdAt: t,
    updatedAt: t,
    source: "github",
    sourceVersion: "api-v1",
    candidateId: session.selectedCandidateId!,
    provider: "github",
    owner: "safe-flash",
    repository: "demo",
    number: 1,
    url: "https://github.com/safe-flash/demo/pull/1",
    headSha: session.currentCommitSha!,
    headTreeSha: session.currentValidatedTreeSha ?? "c".repeat(40),
    baseBranch: "main",
    baseSha: INITIAL_SHA,
    status: "open",
  };
}

function reviewReceipt(
  status: IndependentReviewReceipt["status"],
  headSha = INITIAL_SHA,
): IndependentReviewReceipt {
  return {
    provider: "coderabbit",
    sourceKind: "live-api",
    status,
    pullNumber: 1,
    headSha,
    expectedBaseRef: "main",
    expectedBaseSha: INITIAL_SHA,
    observedBaseRef: "main",
    observedBaseSha: INITIAL_SHA,
    reviewUrl: "https://github.com/safe-flash/demo/pull/1#review",
    evidenceIds: [`check:${status}`],
    capturedAt: t,
  };
}

function fullRevalidationReceipt(
  changes: Partial<FullRevalidationReceipt> = {},
): FullRevalidationReceipt {
  const evidence = {
    sourceKind: "live-provider-evidence" as const,
    mode: "live" as const,
    sessionId: "session-1",
    policyVersion: "policy-v1",
    candidateId: "candidate-safe",
    patchDigest: PATCH_V2,
    commitSha: REPAIRED_SHA,
    validatedTreeSha: "d".repeat(40),
    pullRequestTarget: {
      provider: "github" as const,
      owner: "safe-flash",
      repository: "demo",
      baseBranch: "main",
    },
    evidenceDigest: "e".repeat(64),
    executionProvider: "daytona" as const,
    evaluationProvider: "braintrust" as const,
    sandboxId: "daytona-revalidation-round-2",
    daytonaRunId: "revalidation-round-2",
    daytonaEvidenceRef:
      "daytona://sandbox/daytona-revalidation-round-2/runs/revalidation-round-2",
    braintrustProjectId: "safeflash-project",
    braintrustExperimentId: "revalidation-round-2",
    braintrustExperimentName: "revalidation-round-2",
    braintrustExperimentRef:
      "https://www.braintrust.dev/app/safeflash/experiments/revalidation-round-2",
    buildPassed: true,
    unitTestsPassed: true,
    safetyTestsPassed: true,
    integrityChecksPassed: true,
    braintrustScored: true,
    candidateEligible: true,
    ...changes,
    validationPurpose: changes.validationPurpose ?? "review-repair",
  };
  const { attestationDigest: _ignored, ...unsealed } = evidence as typeof evidence & {
    attestationDigest?: string;
  };
  return {
    ...unsealed,
    attestationDigest: computeFullRevalidationAttestationDigest(unsealed),
  };
}

describe("validation workflow guards", () => {
  it("requires and persists exact live provider evidence for initial selection while preserving mock compatibility", () => {
    const selecting: ValidationSession = {
      ...createValidationSession({
        id: "session-1",
        incidentId: "incident-1",
        policyId: "policy-1",
        policyVersion: "policy-v1",
        repository: {
          repoUrl: "https://github.com/safe-flash/demo.git",
          commitSha: INITIAL_SHA,
        },
        pullRequestTarget: {
          provider: "github",
          owner: "safe-flash",
          repository: "demo",
          baseBranch: "main",
        },
        mode: "live",
        sourceVersion: "workflow-v1",
        at: t,
      }),
      state: "SELECTING",
      candidateIds: ["candidate-safe", "candidate-a", "candidate-b"],
      sandboxIdsByCandidate: {
        "candidate-safe": "daytona-initial-winner",
        "candidate-a": "daytona-initial-a",
        "candidate-b": "daytona-initial-b",
      },
      sandboxAttemptHistory: [
        {
          candidateId: "candidate-safe",
          sandboxId: "daytona-initial-winner",
          runId: "initial-round",
          purpose: "initial-candidate",
          capturedAt: t,
          disposition: "completed",
          retryable: false,
          reservationStatus: "reserved",
          duplicateSandbox: false,
          duplicateRun: false,
        },
      ],
    };
    const receipt = fullRevalidationReceipt({
      validationPurpose: "initial-selection",
      patchDigest: PATCH_V1,
      commitSha: REPAIRED_SHA,
      evidenceDigest: "9".repeat(64),
      sandboxId: "daytona-initial-winner",
      daytonaRunId: "initial-round",
      daytonaEvidenceRef:
        "daytona://sandbox/daytona-initial-winner/runs/initial-round",
      braintrustExperimentId: "initial-round",
      braintrustExperimentName: "initial-round",
      braintrustExperimentRef:
        "https://www.braintrust.dev/app/safeflash/experiments/initial-round",
    });
    const event = {
      type: "CANDIDATE_SELECTED" as const,
      at: t,
      candidateId: "candidate-safe",
      patchDigest: PATCH_V1,
      evidenceDigest: "9".repeat(64),
      commitSha: REPAIRED_SHA,
    };
    expect(() => transitionValidationSession(selecting, event)).toThrow(
      /server-normalized Daytona and Braintrust evidence/u,
    );
    const selected = transitionValidationSession(selecting, {
      ...event,
      receipt,
    });
    expect(selected.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(selected.currentValidatedTreeSha).toBe(receipt.validatedTreeSha);
    expect(selected.lastRevalidation).toEqual(receipt);
    expect(selected.revalidationSandboxIds).toEqual([]);

    expect(() =>
      transitionValidationSession(
        {
          ...selecting,
          sandboxAttemptHistory: selecting.sandboxAttemptHistory.map(
            (attempt) => ({ ...attempt, runId: "different-run" }),
          ),
        },
        { ...event, receipt },
      ),
    ).toThrow(/exact eligible receipt/iu);
    expect(() =>
      transitionValidationSession(
        {
          ...selecting,
          sandboxAttemptHistory: [
            ...selecting.sandboxAttemptHistory,
            {
              ...selecting.sandboxAttemptHistory[0]!,
              reservationStatus: "rejected-reuse",
              duplicateSandbox: true,
            },
          ],
        },
        { ...event, receipt },
      ),
    ).toThrow(/exact eligible receipt/iu);

    const mockSelected = transitionValidationSession(
      { ...selecting, mode: "mock" },
      event,
    );
    expect(mockSelected.lastRevalidation).toBeUndefined();
  });

  it("human_approval_required_before_pr", () => {
    const session = awaitingApproval();
    expect(() =>
      transitionValidationSession(session, {
        type: "PR_CREATION_REQUESTED",
        at: t,
      }),
    ).toThrow(InvalidWorkflowTransitionError);

    const approved = transitionValidationSession(session, {
      type: "APPROVAL_RECORDED",
      at: t,
      approval: approvalFor(session),
    });
    expect(
      transitionValidationSession(approved, {
        type: "PR_CREATION_REQUESTED",
        at: t,
      }).state,
    ).toBe("CREATING_PULL_REQUEST");
  });

  it("each_candidate_uses_unique_sandbox", () => {
    const provisioning: ValidationSession = {
      ...createValidationSession({
        id: "session-1",
        incidentId: "incident-1",
        policyId: "policy-1",
        policyVersion: "policy-v1",
        repository: {
          repoUrl: "https://github.example/safe-flash/demo.git",
          commitSha: "0123456789abcdef",
        },
        mode: "live",
        sourceVersion: "workflow-v1",
        at: t,
      }),
      state: "PROVISIONING_SANDBOXES",
      candidateIds: ["candidate-a", "candidate-b", "candidate-c"],
    };

    const withAttemptA = transitionValidationSession(provisioning, {
      type: "DAYTONA_ATTEMPT_RECORDED",
      at: t,
      attempt: {
        candidateId: "candidate-a",
        sandboxId: "sandbox-a",
        runId: "run-a",
        purpose: "initial-candidate",
        capturedAt: t,
        disposition: "completed",
        retryable: false,
      },
    });
    const duplicateSandbox = transitionValidationSession(withAttemptA, {
        type: "DAYTONA_ATTEMPT_RECORDED",
        at: t,
        attempt: {
          candidateId: "candidate-b",
          sandboxId: "sandbox-a",
          runId: "run-b",
          purpose: "initial-candidate",
          capturedAt: t,
          disposition: "completed",
          retryable: false,
        },
      });
    expect(duplicateSandbox.state).toBe("FAILED");
    expect(duplicateSandbox.failure?.recoverable).toBe(false);
    expect(duplicateSandbox.sandboxAttemptHistory.at(-1)).toMatchObject({
      reservationStatus: "rejected-reuse",
      duplicateSandbox: true,
      duplicateRun: false,
    });
    const duplicateRun = transitionValidationSession(withAttemptA, {
        type: "DAYTONA_ATTEMPT_RECORDED",
        at: t,
        attempt: {
          candidateId: "candidate-b",
          sandboxId: "sandbox-b",
          runId: "run-a",
          purpose: "initial-candidate",
          capturedAt: t,
          disposition: "completed",
          retryable: false,
        },
      });
    expect(duplicateRun.state).toBe("FAILED");
    expect(duplicateRun.sandboxAttemptHistory.at(-1)).toMatchObject({
      reservationStatus: "rejected-reuse",
      duplicateSandbox: false,
      duplicateRun: true,
    });
    const withAttemptB = transitionValidationSession(withAttemptA, {
      type: "DAYTONA_ATTEMPT_RECORDED",
      at: t,
      attempt: {
        candidateId: "candidate-b",
        sandboxId: "sandbox-b",
        runId: "run-b",
        purpose: "initial-candidate",
        capturedAt: t,
        disposition: "completed",
        retryable: false,
      },
    });
    const withAttempts = transitionValidationSession(
      JSON.parse(JSON.stringify(withAttemptB)) as ValidationSession,
      {
        type: "DAYTONA_ATTEMPT_RECORDED",
        at: t,
        attempt: {
          candidateId: "candidate-c",
          sandboxId: "sandbox-c",
          runId: "run-c",
          purpose: "initial-candidate",
          capturedAt: t,
          disposition: "completed",
          retryable: false,
        },
      },
    );
    expect(withAttempts.sandboxAttemptHistory).toHaveLength(3);

    expect(() =>
      transitionValidationSession(withAttempts, {
        type: "SANDBOXES_PROVISIONED",
        at: t,
        sandboxIdsByCandidate: {
          "candidate-a": "sandbox-shared",
          "candidate-b": "sandbox-shared",
          "candidate-c": "sandbox-c",
        },
      }),
    ).toThrow(/unique/u);

    expect(
      transitionValidationSession(withAttempts, {
        type: "SANDBOXES_PROVISIONED",
        at: t,
        sandboxIdsByCandidate: {
          "candidate-a": "sandbox-a",
          "candidate-b": "sandbox-b",
          "candidate-c": "sandbox-c",
        },
      }).state,
    ).toBe("BUILDING");
  });

  it("critical_review_finding_blocks_ready_to_merge", () => {
    const critical = reviewFinding("critical");
    expect(evaluateCodeRabbitGate([critical]).passed).toBe(false);

    const session: ValidationSession = {
      ...awaitingApproval(),
      approval: approvalFor(awaitingApproval()),
      state: "AWAITING_CODERABBIT",
      pullRequest: pullRequestFor(awaitingApproval()),
    };
    const blocked = transitionValidationSession(session, {
      type: "REVIEW_FINDINGS_RECEIVED",
      at: t,
      findings: [critical],
      receipt: reviewReceipt("blocked"),
    });

    expect(blocked.state).toBe("REVIEW_BLOCKED");
    expect(() =>
      transitionValidationSession(blocked, {
        type: "MARK_READY_TO_MERGE",
        at: t,
      }),
    ).toThrow(InvalidWorkflowTransitionError);
  });

  it("review_fix_reenters_full_validation_pipeline", () => {
    const initial = awaitingApproval();
    const approved = { ...initial, approval: approvalFor(initial) };
    const blocked: ValidationSession = {
      ...approved,
      state: "REVIEW_BLOCKED",
      reviewFindings: [reviewFinding("high")],
      pullRequest: pullRequestFor(approved),
      reviewReceipt: reviewReceipt("blocked"),
    };

    const repairing = transitionValidationSession(blocked, {
      type: "REPAIR_STARTED",
      at: "2026-07-22T12:01:00.000Z",
    });
    const repairPending = transitionValidationSession(repairing, {
      type: "REPAIR_GENERATED",
      at: "2026-07-22T12:02:00.000Z",
      candidateId: "candidate-safe",
      patchDigest: PATCH_V2,
    });
    const revalidating = transitionValidationSession(repairPending, {
      type: "DAYTONA_ATTEMPT_RECORDED",
      at: "2026-07-22T12:02:30.000Z",
      attempt: {
        candidateId: "candidate-safe",
        sandboxId: "daytona-revalidation-round-2",
        runId: "revalidation-round-2",
        purpose: "review-repair",
        capturedAt: "2026-07-22T12:02:30.000Z",
        disposition: "completed",
        retryable: false,
      },
    });

    expect(revalidating.state).toBe("REVALIDATING");
    expect(revalidating.approval?.invalidatedAt).toBeDefined();
    expect(() =>
      transitionValidationSession(revalidating, {
        type: "MARK_READY_TO_MERGE",
        at: t,
      }),
    ).toThrow(InvalidWorkflowTransitionError);

    for (const incomplete of [
      { buildPassed: false },
      { unitTestsPassed: false },
      { safetyTestsPassed: false },
      { integrityChecksPassed: false },
      { braintrustScored: false },
      { candidateEligible: false },
      { sandboxId: "" },
      { commitSha: INITIAL_SHA },
      {
        executionProvider: "local-process" as unknown as "daytona",
      },
      {
        evaluationProvider: "local-eval" as unknown as "braintrust",
      },
      {
        pullRequestTarget: {
          provider: "github",
          owner: "attacker",
          repository: "demo",
          baseBranch: "main",
        },
      },
    ] satisfies Partial<FullRevalidationReceipt>[]) {
      expect(() =>
        transitionValidationSession(revalidating, {
          type: "REVALIDATION_PASSED",
          at: "2026-07-22T12:03:00.000Z",
          receipt: fullRevalidationReceipt(incomplete),
        }),
      ).toThrow(/build, unit, safety, integrity, and Braintrust/u);
    }

    const previouslyUsed = fullRevalidationReceipt({
      sandboxId: "daytona-previous-revalidation",
    });
    expect(() =>
      transitionValidationSession(
        { ...revalidating, lastRevalidation: previouslyUsed },
        {
          type: "REVALIDATION_PASSED",
          at: "2026-07-22T12:03:00.000Z",
          receipt: fullRevalidationReceipt({
            sandboxId: "daytona-previous-revalidation",
          }),
        },
      ),
    ).toThrow(/fresh Daytona sandbox/u);

    expect(() =>
      transitionValidationSession(
        {
          ...revalidating,
          revalidationSandboxIds: [
            "daytona-older-revalidation",
            "daytona-previous-revalidation",
          ],
        },
        {
          type: "REVALIDATION_PASSED",
          at: "2026-07-22T12:03:00.000Z",
          receipt: fullRevalidationReceipt({
            sandboxId: "daytona-older-revalidation",
            daytonaRunId: "older-round",
            daytonaEvidenceRef:
              "daytona://sandbox/daytona-older-revalidation/runs/older-round",
          }),
        },
      ),
    ).toThrow(/fresh Daytona sandbox/u);

    expect(() =>
      transitionValidationSession(
        { ...revalidating, mode: "mock" },
        {
          type: "REVALIDATION_PASSED",
          at: "2026-07-22T12:03:00.000Z",
          receipt: fullRevalidationReceipt(),
        },
      ),
    ).toThrow(/build, unit, safety, integrity, and Braintrust/u);

    const revalidated = transitionValidationSession(revalidating, {
      type: "REVALIDATION_PASSED",
      at: "2026-07-22T12:03:00.000Z",
      receipt: fullRevalidationReceipt(),
    });

    expect(revalidated.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(revalidated.validationRound).toBe(2);
    expect(revalidated.currentCommitSha).toBe(REPAIRED_SHA);
    expect(revalidated.lastRevalidation).toEqual(fullRevalidationReceipt());
    expect(revalidated.revalidationSandboxIds).toEqual([
      "daytona-revalidation-round-2",
    ]);
    expect(() =>
      transitionValidationSession(revalidated, {
        type: "PR_CREATION_REQUESTED",
        at: t,
      }),
    ).toThrow(/valid approval/u);

    const reapproved = transitionValidationSession(revalidated, {
      type: "APPROVAL_RECORDED",
      at: "2026-07-22T12:04:00.000Z",
      approval: approvalFor(revalidated),
    });
    const creatingPr = transitionValidationSession(reapproved, {
      type: "PR_CREATION_REQUESTED",
      at: "2026-07-22T12:05:00.000Z",
    });
    const awaitingSecondReview = transitionValidationSession(creatingPr, {
      type: "PR_CREATED_OR_UPDATED",
      at: "2026-07-22T12:06:00.000Z",
      pullRequest: pullRequestFor(creatingPr),
    });
    const secondReviewPassed = transitionValidationSession(
      awaitingSecondReview,
      {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: "2026-07-22T12:07:00.000Z",
        findings: [reviewFinding("medium", false, REPAIRED_SHA)],
        receipt: reviewReceipt("passed", REPAIRED_SHA),
      },
    );
    expect(secondReviewPassed.reviewReceipt?.headSha).toBe(REPAIRED_SHA);
    expect(
      transitionValidationSession(secondReviewPassed, {
        type: "MARK_READY_TO_MERGE",
        at: "2026-07-22T12:08:00.000Z",
      }).state,
    ).toBe("READY_TO_MERGE");
  });

  it("review gate permits readiness only after approval and no blockers", () => {
    const initial = awaitingApproval();
    const approval = approvalFor(initial);
    const pullRequest = pullRequestFor(initial);
    const reviewPassed: ValidationSession = {
      ...initial,
      approval,
      pullRequest,
      state: "REVIEW_PASSED",
      reviewFindings: [reviewFinding("medium")],
      reviewReceipt: reviewReceipt("passed"),
    };

    expect(
      transitionValidationSession(reviewPassed, {
        type: "MARK_READY_TO_MERGE",
        at: t,
      }).state,
    ).toBe("READY_TO_MERGE");
  });

  it("does not accept an empty findings array as proof that CodeRabbit passed", () => {
    const initial = awaitingApproval();
    const session: ValidationSession = {
      ...initial,
      approval: approvalFor(initial),
      pullRequest: pullRequestFor(initial),
      state: "AWAITING_CODERABBIT",
    };

    expect(() =>
      transitionValidationSession(session, {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: t,
        findings: [],
        receipt: reviewReceipt("blocked"),
      }),
    ).toThrow(/Independent review evidence/u);

    expect(
      transitionValidationSession(session, {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: t,
        findings: [],
        receipt: reviewReceipt("passed"),
      }).state,
    ).toBe("REVIEW_PASSED");
  });

  it("binds PR creation and independent review to the exact approved head", () => {
    const initial = awaitingApproval();
    const boundApproval = approvalFor(initial);
    expect(() =>
      transitionValidationSession(
        {
          ...initial,
          approval: boundApproval,
          pullRequestTarget: {
            provider: "github",
            owner: "attacker",
            repository: "demo",
            baseBranch: "main",
          },
        },
        { type: "PR_CREATION_REQUESTED", at: t },
      ),
    ).toThrow(/valid approval/u);
    const approved: ValidationSession = {
      ...initial,
      approval: boundApproval,
      state: "CREATING_PULL_REQUEST",
    };
    expect(() =>
      transitionValidationSession(approved, {
        type: "PR_CREATED_OR_UPDATED",
        at: t,
        pullRequest: { ...pullRequestFor(approved), headSha: REPAIRED_SHA },
      }),
    ).toThrow(/approval-bound head/u);
    expect(() =>
      transitionValidationSession(approved, {
        type: "PR_CREATED_OR_UPDATED",
        at: t,
        pullRequest: {
          ...pullRequestFor(approved),
          url: "https://github.com/attacker/demo/pull/1",
        },
      }),
    ).toThrow(/open GitHub PR/u);
    expect(() =>
      transitionValidationSession(approved, {
        type: "PR_CREATED_OR_UPDATED",
        at: t,
        pullRequest: {
          ...pullRequestFor(approved),
          owner: "attacker",
          url: "https://github.com/attacker/demo/pull/1",
        },
      }),
    ).toThrow(/approval-bound head/u);
    expect(() =>
      transitionValidationSession(approved, {
        type: "PR_CREATED_OR_UPDATED",
        at: t,
        pullRequest: {
          ...pullRequestFor(approved),
          baseBranch: "attacker-base",
        },
      }),
    ).toThrow(/approval-bound head/u);

    const awaitingReview = transitionValidationSession(approved, {
      type: "PR_CREATED_OR_UPDATED",
      at: t,
      pullRequest: pullRequestFor(approved),
    });
    expect(() =>
      transitionValidationSession(awaitingReview, {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: t,
        findings: [],
        receipt: reviewReceipt("passed", REPAIRED_SHA),
      }),
    ).toThrow(/exact current PR head/u);

    const manualPass = transitionValidationSession(awaitingReview, {
      type: "REVIEW_FINDINGS_RECEIVED",
      at: t,
      findings: [],
      receipt: {
        ...reviewReceipt("passed"),
        provider: "manual_verified",
        sourceKind: "manual-attestation",
        reviewUrl: "https://github.com/safe-flash/demo/pull/1#manual-review",
        attestedBy: "safety-reviewer",
      },
    });
    expect(manualPass.state).toBe("REVIEW_PASSED");

    expect(() =>
      transitionValidationSession(awaitingReview, {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: t,
        findings: [],
        receipt: {
          ...reviewReceipt("passed"),
          observedBaseSha: "f".repeat(40),
        },
      }),
    ).toThrow(/exact current PR head/u);

    expect(() =>
      transitionValidationSession(awaitingReview, {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: t,
        findings: [],
        receipt: {
          ...reviewReceipt("passed"),
          reviewUrl: `${pullRequestFor(approved).url}evil`,
        },
      }),
    ).toThrow(/exact current PR head/u);

    expect(() =>
      transitionValidationSession(awaitingReview, {
        type: "REVIEW_FINDINGS_RECEIVED",
        at: t,
        findings: [],
        receipt: {
          ...reviewReceipt("passed"),
          reviewUrl: "https://credential@github.com/safe-flash/demo/pull/1",
        },
      }),
    ).toThrow(/exact current PR head/u);
  });
});
