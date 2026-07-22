import { describe, expect, it } from "vitest";

import {
  InvalidWorkflowTransitionError,
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
      mode: "live",
      sourceVersion: "workflow-v1",
      at: t,
    }),
    state: "AWAITING_HUMAN_APPROVAL",
    candidateIds: ["candidate-safe", "candidate-a", "candidate-b"],
    selectedCandidateId: "candidate-safe",
    currentPatchDigest: "patch-v1",
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
    baseBranch: "main",
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
    reviewUrl: "https://github.com/safe-flash/demo/pull/1#review",
    evidenceIds: [`check:${status}`],
    capturedAt: t,
  };
}

function fullRevalidationReceipt(
  changes: Partial<FullRevalidationReceipt> = {},
): FullRevalidationReceipt {
  return {
    candidateId: "candidate-safe",
    patchDigest: "patch-v2",
    commitSha: REPAIRED_SHA,
    evidenceDigest: "evidence-v2",
    executionProvider: "daytona",
    evaluationProvider: "braintrust",
    sandboxId: "daytona-revalidation-round-2",
    daytonaEvidenceRef: "daytona://sandbox/revalidation-round-2/evidence.json",
    braintrustExperimentRef:
      "https://www.braintrust.dev/app/safeflash/experiment/revalidation-round-2",
    buildPassed: true,
    unitTestsPassed: true,
    safetyTestsPassed: true,
    integrityChecksPassed: true,
    braintrustScored: true,
    candidateEligible: true,
    ...changes,
  };
}

describe("validation workflow guards", () => {
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

    expect(() =>
      transitionValidationSession(provisioning, {
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
      transitionValidationSession(provisioning, {
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
    const revalidating = transitionValidationSession(repairing, {
      type: "REPAIR_GENERATED",
      at: "2026-07-22T12:02:00.000Z",
      candidateId: "candidate-safe",
      patchDigest: "patch-v2",
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

    const revalidated = transitionValidationSession(revalidating, {
      type: "REVALIDATION_PASSED",
      at: "2026-07-22T12:03:00.000Z",
      receipt: fullRevalidationReceipt(),
    });

    expect(revalidated.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(revalidated.validationRound).toBe(2);
    expect(revalidated.currentCommitSha).toBe(REPAIRED_SHA);
    expect(revalidated.lastRevalidation).toEqual(fullRevalidationReceipt());
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
    const approved: ValidationSession = {
      ...initial,
      approval: approvalFor(initial),
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
