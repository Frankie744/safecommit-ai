import { describe, expect, it } from "vitest";

import {
  InvalidWorkflowTransitionError,
  createHumanApproval,
  createValidationSession,
  evaluateCodeRabbitGate,
  transitionValidationSession,
  type PullRequestRecord,
  type ReviewFinding,
  type ValidationSession,
} from "../../packages/domain/src/index";

const t = "2026-07-22T12:00:00.000Z";

function awaitingApproval(): ValidationSession {
  return {
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
    commitSha: "0123456789abcdef",
  });
}

function reviewFinding(
  severity: ReviewFinding["severity"],
  resolved = false,
): ReviewFinding {
  return {
    id: `finding-${severity}`,
    sessionId: "session-1",
    createdAt: t,
    updatedAt: t,
    source: "github-review",
    sourceVersion: "coderabbit-v1",
    provider: "coderabbit",
    reviewUrl: "https://github.example/pr/1#review",
    externalId: `external-${severity}`,
    severity,
    title: `${severity} finding`,
    body: "Review evidence",
    resolved,
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
    };
    const blocked = transitionValidationSession(session, {
      type: "REVIEW_FINDINGS_RECEIVED",
      at: t,
      findings: [critical],
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

    const revalidated = transitionValidationSession(revalidating, {
      type: "REVALIDATION_PASSED",
      at: "2026-07-22T12:03:00.000Z",
      patchDigest: "patch-v2",
      evidenceDigest: "evidence-v2",
    });

    expect(revalidated.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(revalidated.validationRound).toBe(2);
    expect(() =>
      transitionValidationSession(revalidated, {
        type: "PR_CREATION_REQUESTED",
        at: t,
      }),
    ).toThrow(/valid approval/u);
  });

  it("review gate permits readiness only after approval and no blockers", () => {
    const initial = awaitingApproval();
    const approval = approvalFor(initial);
    const pullRequest: PullRequestRecord = {
      id: "pr-1",
      sessionId: initial.sessionId,
      createdAt: t,
      updatedAt: t,
      source: "github",
      sourceVersion: "api-v1",
      candidateId: initial.selectedCandidateId!,
      provider: "github",
      owner: "safe-flash",
      repository: "demo",
      number: 1,
      url: "https://github.example/pr/1",
      headSha: "abcdef",
      baseBranch: "main",
      status: "open",
    };
    const reviewPassed: ValidationSession = {
      ...initial,
      approval,
      pullRequest,
      state: "REVIEW_PASSED",
      reviewFindings: [reviewFinding("medium")],
    };

    expect(
      transitionValidationSession(reviewPassed, {
        type: "MARK_READY_TO_MERGE",
        at: t,
      }).state,
    ).toBe("READY_TO_MERGE");
  });
});
