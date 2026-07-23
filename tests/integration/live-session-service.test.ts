import { afterEach, describe, expect, it } from "vitest";

import type {
  HumanApproval,
  PullRequestRecord,
  ReviewFinding,
  ValidationSession,
} from "@safeflash/domain";
import type {
  LiveCandidateEvidenceSummary,
  LiveHumanDecisionInput,
  LiveWorkflowProgressEvent,
  LiveWorkflowSnapshot,
} from "@safeflash/orchestrator";

import { GET as getCopilotInfo } from "../../apps/web/app/api/copilotkit/info/route";
import { POST as createSessionRoute } from "../../apps/web/app/api/sessions/route";
import { getActiveSessionService } from "../../apps/web/server/active-session-service";
import {
  LiveSessionService,
  type LiveWorkflowPort,
} from "../../apps/web/server/live-session-service";
import { SessionServiceError } from "../../apps/web/server/session-service";

const AT = "2026-07-22T20:00:00.000Z";
const LATER = "2026-07-22T20:01:00.000Z";
const BASE_SHA = "1".repeat(40);
const INITIAL_SHA = "2".repeat(40);
const REPAIRED_SHA = "3".repeat(40);
const INITIAL_TREE = "a".repeat(40);
const REPAIRED_TREE = "b".repeat(40);
const FULL_INITIAL_DIGEST = "a".repeat(64);
const FULL_REPAIRED_DIGEST = "e".repeat(64);
const PATCH_INITIAL = "b".repeat(64);
const PATCH_REPAIRED = "f".repeat(64);
const POLICY_VERSION = "battery-controller-p0-v1";
const SESSION_ID = "live-contract-1";
const CANDIDATE_IDS = ["candidate-a", "candidate-b", "candidate-c"] as const;

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

const scores = {
  buildSuccess: 1,
  unitTestPassRate: 1,
  safetyInvariant: 1,
  regressionProtection: 1,
  patchIntegrity: 1,
  patchMinimality: 0.9,
  explanationGroundedness: 0.9,
  reproducibility: 1,
} as const;

function candidateSummary(
  index: number,
  options: {
    selected?: boolean;
    repaired?: boolean;
    eligible?: boolean;
    safetyPassed?: number;
  } = {},
): LiveCandidateEvidenceSummary {
  const id = CANDIDATE_IDS[index]!;
  const repaired = options.repaired === true;
  const eligible = options.eligible ?? options.selected === true;
  const round = repaired ? 2 : 1;
  const experimentId = repaired ? "experiment-repair" : "experiment-initial";
  const tree = repaired
    ? REPAIRED_TREE
    : options.selected
      ? INITIAL_TREE
      : `${index + 4}`.repeat(40);
  const sandboxId = repaired ? "sandbox-repair-c" : `sandbox-initial-${id}`;
  const safetyPassed = options.safetyPassed ?? (eligible ? 4 : 3);
  return {
    candidate: {
      candidateId: id,
      strategy:
        index === 0
          ? "range-validation"
          : index === 1
            ? "retry-and-latch"
            : "fail-closed",
      hypothesis: repaired
        ? "Repair the exact CodeRabbit blocker and retain fail-closed behavior."
        : `Real hypothesis for ${id}.`,
      unifiedDiff: `diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -1 +1 @@\n-${id}\n+${id}-${repaired ? "repair" : "initial"}\n`,
      expectedSafetyEffect: ["Charging fails closed."],
      risks: ["False positive shutdown."],
      testsToRun: ["trusted-safety-tests"],
    },
    evaluationProfile: eligible
      ? "safety-contender"
      : "safety-negative-control",
    generation: {
      provider: "fireworks",
      model: "accounts/test/models/safeflash",
      requestId: `request-${id}-${round}`,
      latencyMs: 50 + index,
      totalTokens: 100 + index,
      sourceContextDigest: "8".repeat(64),
      requestDigest: `${index + 1}`.repeat(64),
      capturedAt: repaired ? LATER : AT,
    },
    validation: {
      provider: "daytona",
      sandboxId,
      runId: `run-${id}-${round}`,
      baseCommitSha: repaired ? INITIAL_SHA : BASE_SHA,
      patchDigest: repaired
        ? PATCH_REPAIRED
        : `${index + 5}`.repeat(64),
      policyDigest: "9".repeat(64),
      passed: eligible,
      validatedTreeSha: options.selected || repaired ? tree : null,
      build: { exitCode: 0 },
      unitTests: { passed: 5, total: 5 },
      safetyTests: {
        passed: safetyPassed,
        total: 4,
        criticalFailures:
          safetyPassed === 4 ? [] : ["sensor-disconnect-fail-closed"],
      },
      regressionTests: { passed: 3, total: 3 },
      integrity: { passed: true, violations: [] },
      commands: [
        {
          id: `run-${id}-${round}:build`,
          exitCode: 0,
          timedOut: false,
          durationMs: 12,
          stdoutHash: "7".repeat(64),
          artifactHash: tree,
        },
      ],
      capturedAt: repaired ? LATER : AT,
    },
    scoring: {
      provider: "braintrust",
      resultId: `${experimentId}-${id}-eval-result`,
      eligible,
      weightedScore: eligible ? 0.91 : 0.79 - index / 100,
      hardGateFailures: eligible ? [] : ["safetyInvariant"],
      // Deliberately differs from the full revalidation receipt digest.
      evidenceDigest: `${index + 2}`.repeat(64),
      values: eligible ? scores : { ...scores, safetyInvariant: 0 },
      experimentId,
      experimentName: `${SESSION_ID}-${experimentId}`,
      experimentUrl: `https://braintrust.test/experiments/${experimentId}`,
      traceId: `${experimentId}-${id}-trace`,
      traceUrl: `https://braintrust.test/traces/${experimentId}-${id}`,
      validationRound: round,
      capturedAt: repaired ? LATER : AT,
    },
  };
}

function approval(
  currentSha = INITIAL_SHA,
  evidenceDigest = FULL_INITIAL_DIGEST,
  invalidatedAt?: string,
): HumanApproval {
  return {
    id: "approval-1",
    sessionId: SESSION_ID,
    createdAt: AT,
    updatedAt: invalidatedAt ?? AT,
    source: "web-live",
    sourceVersion: "v1",
    candidateId: "candidate-c",
    approverId: "operator",
    approverDisplayName: "Contract operator",
    decision: "approved",
    actedAt: AT,
    evidenceDigest,
    patchDigest:
      evidenceDigest === FULL_REPAIRED_DIGEST ? PATCH_REPAIRED : PATCH_INITIAL,
    policyVersion: POLICY_VERSION,
    commitSha: currentSha,
    pullRequestTarget: {
      provider: "github",
      owner: "safe-flash",
      repository: "firmware",
      baseBranch: "main",
    },
    bindingDigest: "6".repeat(64),
    invalidatedAt,
    invalidationReason: invalidatedAt ? "Evidence changed after repair." : undefined,
  };
}

function pullRequest(): PullRequestRecord {
  return {
    id: "github-pr-17",
    sessionId: SESSION_ID,
    createdAt: AT,
    updatedAt: LATER,
    source: "github",
    sourceVersion: INITIAL_SHA,
    candidateId: "candidate-c",
    provider: "github",
    owner: "safe-flash",
    repository: "firmware",
    number: 17,
    url: "https://github.com/safe-flash/firmware/pull/17",
    headSha: INITIAL_SHA,
    headTreeSha: INITIAL_TREE,
    baseBranch: "main",
    baseSha: BASE_SHA,
    status: "open",
  };
}

function reviewFinding(): ReviewFinding {
  return {
    id: "coderabbit-finding-1",
    sessionId: SESSION_ID,
    createdAt: LATER,
    updatedAt: LATER,
    source: "coderabbit",
    sourceVersion: INITIAL_SHA,
    provider: "coderabbit",
    reviewUrl: "https://github.com/safe-flash/firmware/pull/17#discussion_r1",
    externalId: "discussion-1",
    severity: "high",
    title: "Fault latch can be cleared too early",
    body: "Preserve the latch until a trusted reset.",
    filePath: "fixtures/battery-controller/src/battery_controller.c",
    line: 42,
    resolved: false,
  };
}

function snapshot(
  state:
    | "AWAITING_HUMAN_APPROVAL"
    | "REVIEW_BLOCKED"
    | "READY_TO_MERGE",
  options: { approved?: boolean; repaired?: boolean } = {},
): LiveWorkflowSnapshot {
  const repaired = options.repaired === true;
  const currentSha = repaired ? REPAIRED_SHA : INITIAL_SHA;
  const tree = repaired ? REPAIRED_TREE : INITIAL_TREE;
  const fullDigest = repaired ? FULL_REPAIRED_DIGEST : FULL_INITIAL_DIGEST;
  const patchDigest = repaired ? PATCH_REPAIRED : PATCH_INITIAL;
  const pr = state === "REVIEW_BLOCKED" || state === "READY_TO_MERGE" || repaired
    ? pullRequest()
    : undefined;
  const finding = state === "REVIEW_BLOCKED" || repaired ? reviewFinding() : undefined;
  const session: ValidationSession = {
    id: SESSION_ID,
    sessionId: SESSION_ID,
    createdAt: AT,
    updatedAt: repaired || state !== "AWAITING_HUMAN_APPROVAL" ? LATER : AT,
    source: "live-workflow",
    sourceVersion: "v1",
    mode: "live",
    runKind: "tournament",
    state,
    incidentId: "battery-sensor-disconnect",
    policyId: "battery-controller-p0-policy",
    policyVersion: POLICY_VERSION,
    policySnapshot: {
      allowedPatchPaths: ["fixtures/battery-controller/src/**"],
      maxChangedFiles: 1,
      maxChangedLines: 120,
    },
    repository: {
      repoUrl: "https://github.com/safe-flash/firmware.git",
      commitSha: BASE_SHA,
    },
    pullRequestTarget: {
      provider: "github",
      owner: "safe-flash",
      repository: "firmware",
      baseBranch: "main",
    },
    candidateIds: [...CANDIDATE_IDS],
    sandboxIdsByCandidate: {
      "candidate-a": "sandbox-initial-candidate-a",
      "candidate-b": "sandbox-initial-candidate-b",
      "candidate-c": "sandbox-initial-candidate-c",
    },
    sandboxAttemptHistory: [],
    selectedCandidateId: "candidate-c",
    currentPatchDigest: patchDigest,
    currentEvidenceDigest: fullDigest,
    currentCommitSha: currentSha,
    currentValidatedTreeSha: tree,
    approval:
      options.approved || repaired
        ? approval(
            repaired ? INITIAL_SHA : currentSha,
            repaired ? FULL_INITIAL_DIGEST : fullDigest,
            repaired ? LATER : undefined,
          )
        : undefined,
    pullRequest: pr,
    reviewFindings: finding ? [finding] : [],
    reviewReceipt: finding
      ? {
          provider: "coderabbit",
          sourceKind: "live-api",
          status: "blocked",
          pullNumber: 17,
          headSha: INITIAL_SHA,
          expectedBaseRef: "main",
          expectedBaseSha: BASE_SHA,
          observedBaseRef: "main",
          observedBaseSha: BASE_SHA,
          reviewUrl: "https://github.com/safe-flash/firmware/pull/17",
          evidenceIds: ["discussion-1"],
          capturedAt: LATER,
        }
      : state === "READY_TO_MERGE"
        ? {
            provider: "coderabbit",
            sourceKind: "live-api",
            status: "passed",
            pullNumber: 17,
            headSha: INITIAL_SHA,
            expectedBaseRef: "main",
            expectedBaseSha: BASE_SHA,
            observedBaseRef: "main",
            observedBaseSha: BASE_SHA,
            reviewUrl: "https://github.com/safe-flash/firmware/pull/17",
            evidenceIds: ["check-1"],
            capturedAt: LATER,
          }
        : undefined,
    revalidationSandboxIds: repaired ? ["sandbox-repair-c"] : [],
    validationRound: repaired ? 2 : 1,
  };
  const candidates = [
    candidateSummary(0, { eligible: false, safetyPassed: 3 }),
    candidateSummary(1, { eligible: false, safetyPassed: 3 }),
    candidateSummary(2, {
      selected: true,
      repaired,
      eligible: true,
      safetyPassed: 4,
    }),
  ];
  const selected = candidates[2]!;
  return {
    session,
    selectedCandidate: selected.candidate,
    candidates,
    decision: {
      id: `decision-${repaired ? "repair" : "initial"}`,
      sessionId: SESSION_ID,
      createdAt: repaired ? LATER : AT,
      updatedAt: repaired ? LATER : AT,
      source: "braintrust",
      sourceVersion: selected.scoring.experimentId,
      winnerCandidateId: "candidate-c",
      rankings: candidates.map((candidate) => ({
        candidateId: candidate.candidate.candidateId,
        eligible: candidate.scoring.eligible,
        weightedScore: candidate.scoring.weightedScore,
        hardGateFailures: candidate.scoring.hardGateFailures,
        evidenceDigest: candidate.scoring.evidenceDigest,
      })),
      rationale: "Hard gates precede weighted ranking.",
      selectionPolicyVersion: "safety-tournament-v1",
    },
    providerEvidence: {
      braintrustDatasetId: "dataset-p0",
      braintrustDatasetUrl: "https://braintrust.test/datasets/p0",
      braintrustExperimentId: selected.scoring.experimentId,
      braintrustExperimentUrl: selected.scoring.experimentUrl,
      braintrustTraceId: selected.scoring.traceId,
      braintrustTraceUrl: selected.scoring.traceUrl,
      stageTraceIds: [selected.scoring.traceId],
      stageTraceUrls: [selected.scoring.traceUrl],
      daytonaSandboxId: selected.validation.sandboxId,
      daytonaRunId: selected.validation.runId,
      preparedCommitSha: currentSha,
      preparedTreeSha: tree,
      headBranch: `safeflash/${SESSION_ID}`,
    },
  };
}

type PlannedResult = LiveWorkflowSnapshot | Error;

function invalidatedReadySnapshot(): LiveWorkflowSnapshot {
  const value = snapshot("READY_TO_MERGE", { approved: true });
  return {
    ...value,
    session: {
      ...value.session,
      state: "FAILED",
      updatedAt: LATER,
      approval:
        value.session.approval === undefined
          ? undefined
          : {
              ...value.session.approval,
              invalidatedAt: LATER,
              invalidationReason:
                "Remote PR head changed after the review passed.",
            },
      reviewReceipt: undefined,
      reviewFindings: [],
      failure: {
        reason: "Remote PR head changed after the review passed.",
        recoverable: false,
        retryAction: "start-new-live-validation",
        failedFrom: "READY_TO_MERGE",
      },
    },
  };
}

class FakeLiveWorkflow implements LiveWorkflowPort {
  readonly start = new Deferred<LiveWorkflowSnapshot>();
  readonly decisions: LiveHumanDecisionInput[] = [];
  readonly progress: LiveWorkflowProgressEvent[] = [];
  readonly listeners = new Set<(event: LiveWorkflowProgressEvent) => void>();
  publishPlan: PlannedResult[] = [snapshot("READY_TO_MERGE", { approved: true })];
  repairPlan: PlannedResult[] = [snapshot("AWAITING_HUMAN_APPROVAL", { repaired: true })];
  refreshPlan: PlannedResult[] = [
    snapshot("READY_TO_MERGE", { approved: true }),
  ];
  validationGates?: readonly Deferred<void>[];
  publishCalls = 0;
  repairCalls = 0;
  refreshCalls = 0;

  private emit(
    state: LiveWorkflowProgressEvent["state"],
    stage: LiveWorkflowProgressEvent["stage"],
    provider?: LiveWorkflowProgressEvent["provider"],
    evidence: Pick<
      LiveWorkflowProgressEvent,
      "candidates" | "candidateId" | "validation"
    > = {},
  ): void {
    const event: LiveWorkflowProgressEvent = {
      sequence: this.progress.length + 1,
      sessionId: SESSION_ID,
      state,
      stage,
      at: this.progress.length === 0 ? AT : LATER,
      provider,
      evidenceId: provider ? `${provider}-evidence-${this.progress.length + 1}` : undefined,
      message: `Real fake-port contract event: ${stage}.`,
      ...evidence,
    };
    this.progress.push(event);
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  subscribeProgress(
    _sessionId: string,
    listener: (event: LiveWorkflowProgressEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getProgress(): readonly LiveWorkflowProgressEvent[] {
    return structuredClone(this.progress);
  }

  async startTournament(): Promise<LiveWorkflowSnapshot> {
    this.emit("INGESTING_REPOSITORY", "workflow-started");
    const result = await this.start.promise;
    this.emit("PROVISIONING_SANDBOXES", "candidates-generated", "fireworks", {
      candidates: result.candidates.map((summary) => ({
        candidateId: summary.candidate.candidateId,
        strategy: summary.candidate.strategy,
        evaluationProfile: summary.evaluationProfile,
        hypothesis: summary.candidate.hypothesis,
        unifiedDiff: summary.candidate.unifiedDiff,
        patchDigest: summary.validation.patchDigest,
        generationCapturedAt: summary.generation.capturedAt,
      })),
    });
    for (const [index, summary] of result.candidates.entries()) {
      const gate = this.validationGates?.[index];
      if (gate !== undefined) await gate.promise;
      this.emit(
        "PROVISIONING_SANDBOXES",
        "candidate-validated",
        "daytona",
        {
          candidateId: summary.candidate.candidateId,
          validation: {
            sandboxId: summary.validation.sandboxId,
            runId: summary.validation.runId,
            passed: summary.validation.passed,
            validatedTreeSha: summary.validation.validatedTreeSha,
            capturedAt: summary.validation.capturedAt,
            build: summary.validation.build,
            unitTests: summary.validation.unitTests,
            safetyTests: summary.validation.safetyTests,
            integrity: summary.validation.integrity,
          },
        },
      );
    }
    this.emit("SCORING", "scoring-finished", "braintrust");
    this.emit("AWAITING_HUMAN_APPROVAL", "candidate-selected", "github");
    return result;
  }

  async recordHumanDecision(
    input: LiveHumanDecisionInput,
  ): Promise<LiveWorkflowSnapshot> {
    this.decisions.push(structuredClone(input));
    this.emit("AWAITING_HUMAN_APPROVAL", "human-decision-recorded", "braintrust");
    return snapshot("AWAITING_HUMAN_APPROVAL", {
      approved: input.decision === "approved",
    });
  }

  async publishApprovedAndReview(): Promise<LiveWorkflowSnapshot> {
    this.publishCalls += 1;
    this.emit("CREATING_PULL_REQUEST", "publication-requested");
    const next = this.publishPlan.shift();
    if (next instanceof Error) throw next;
    const result = next ?? snapshot("READY_TO_MERGE", { approved: true });
    this.emit(
      result.session.state,
      result.session.state === "READY_TO_MERGE"
        ? "ready-to-merge"
        : "independent-review-finished",
      result.session.state === "READY_TO_MERGE" ? "coderabbit" : "coderabbit",
    );
    return result;
  }

  async repairBlockedReview(): Promise<LiveWorkflowSnapshot> {
    this.repairCalls += 1;
    this.emit("REPAIRING_REVIEW_FINDINGS", "repair-started", "coderabbit");
    const next = this.repairPlan.shift();
    if (next instanceof Error) throw next;
    const result = next ?? snapshot("AWAITING_HUMAN_APPROVAL", { repaired: true });
    this.emit(
      "AWAITING_HUMAN_APPROVAL",
      "repair-revalidation-finished",
      "braintrust",
    );
    return result;
  }

  async refreshReadyToMerge(): Promise<LiveWorkflowSnapshot> {
    this.refreshCalls += 1;
    const next = this.refreshPlan.shift();
    if (next instanceof Error) throw next;
    return next ?? snapshot("READY_TO_MERGE", { approved: true });
  }
}

function retryableFailure(): Error {
  return Object.assign(new Error("transient provider failure"), {
    retryable: true,
  });
}

function decisionBody(view: Awaited<ReturnType<LiveSessionService["get"]>>) {
  return {
    decision: "approved" as const,
    candidateId: view.selectedCandidateId!,
    evidenceDigest: view.currentEvidenceDigest!,
    patchDigest: view.currentPatchDigest!,
    commitSha: view.currentCommitSha,
    policyVersion: view.policy.version,
  };
}

async function startedService(workflow = new FakeLiveWorkflow()) {
  const service = new LiveSessionService(workflow, {
    idFactory: () => SESSION_ID,
    now: () => new Date(AT),
  });
  const accepted = await service.create({
    incidentKind: "battery-sensor-disconnect",
    runKind: "tournament",
  });
  workflow.start.resolve(snapshot("AWAITING_HUMAN_APPROVAL"));
  await expect
    .poll(async () => (await service.get(SESSION_ID)).currentEvidenceDigest)
    .toBe(FULL_INITIAL_DIGEST);
  return { service, workflow, accepted, view: await service.get(SESSION_ID) };
}

const originalMode = process.env.SAFEFLASH_DEFAULT_MODE;
const originalApproverId = process.env.SAFEFLASH_APPROVER_ID;

afterEach(() => {
  if (originalMode === undefined) delete process.env.SAFEFLASH_DEFAULT_MODE;
  else process.env.SAFEFLASH_DEFAULT_MODE = originalMode;
  if (originalApproverId === undefined) delete process.env.SAFEFLASH_APPROVER_ID;
  else process.env.SAFEFLASH_APPROVER_ID = originalApproverId;
  globalThis.__safeFlashLiveSessionService = undefined;
});

describe.sequential("live Web session service contract", () => {
  it("returns immediately, consumes real progress, and maps all three distinct provider evidence cards", async () => {
    const workflow = new FakeLiveWorkflow();
    workflow.validationGates = [
      new Deferred<void>(),
      new Deferred<void>(),
      new Deferred<void>(),
    ];
    const service = new LiveSessionService(workflow, {
      idFactory: () => SESSION_ID,
      now: () => new Date(AT),
    });
    const accepted = await service.create({
      incidentKind: "battery-sensor-disconnect",
      runKind: "tournament",
    });
    expect(accepted).toMatchObject({
      state: "INGESTING_REPOSITORY",
      mode: "live",
      candidates: [],
    });
    expect(accepted.events.some((event) => event.title.includes("SCORING"))).toBe(false);

    workflow.start.resolve(snapshot("AWAITING_HUMAN_APPROVAL"));
    await expect.poll(async () => (await service.get(SESSION_ID)).candidates.length).toBe(3);
    const generated = await service.get(SESSION_ID);
    expect(generated.candidates.every((candidate) => candidate.sandbox.status === "pending")).toBe(true);
    expect(generated.candidates.every((candidate) => candidate.diff?.startsWith("diff --git"))).toBe(true);
    workflow.validationGates[0]!.resolve();
    await expect
      .poll(async () => (await service.get(SESSION_ID)).candidates[0]?.sandbox.id)
      .toBe("sandbox-initial-candidate-a");
    const oneValidated = await service.get(SESSION_ID);
    expect(oneValidated.candidates[0]?.tests.total).toBe(5);
    expect(oneValidated.candidates[1]?.sandbox.status).toBe("pending");
    workflow.validationGates[1]!.resolve();
    workflow.validationGates[2]!.resolve();
    await expect
      .poll(async () => (await service.get(SESSION_ID)).currentEvidenceDigest)
      .toBe(FULL_INITIAL_DIGEST);
    const view = await service.get(SESSION_ID);
    expect(view.currentEvidenceDigest).toBe(FULL_INITIAL_DIGEST);
    expect(view.currentEvidenceDigest).not.toBe(view.candidates[2]!.score.provenance.externalId);
    expect(view.candidates).toHaveLength(3);
    expect(view.candidates.map((candidate) => candidate.sandbox.id)).toEqual([
      "sandbox-initial-candidate-a",
      "sandbox-initial-candidate-b",
      "sandbox-initial-candidate-c",
    ]);
    expect(view.candidates.every((candidate) => candidate.diff?.startsWith("diff --git"))).toBe(true);
    expect(view.candidates.every((candidate) => candidate.tests.total === 5)).toBe(true);
    expect(view.candidates.every((candidate) => candidate.sandbox.provenance.kind === "local-test")).toBe(true);
    expect(JSON.stringify(view)).not.toContain('"kind":"live"');
    expect(view.events.map((event) => event.title)).toEqual(
      expect.arrayContaining([
        "CANDIDATES GENERATED",
        "CANDIDATE VALIDATED",
        "SCORING FINISHED",
      ]),
    );
  });

  it("binds approval to currentCommitSha and reaches READY in the background", async () => {
    process.env.SAFEFLASH_APPROVER_ID = "judge-live-7";
    const { service, workflow, view } = await startedService();
    await expect(
      service.decide(SESSION_ID, {
        ...decisionBody(view),
        commitSha: view.repository.commitSha,
      }),
    ).rejects.toMatchObject({
      code: "STALE_OR_TAMPERED_DECISION",
    } satisfies Partial<SessionServiceError>);

    const accepted = await service.decide(SESSION_ID, decisionBody(view));
    expect(accepted.approval?.decision).toBe("approved");
    await expect.poll(async () => (await service.get(SESSION_ID)).state).toBe(
      "READY_TO_MERGE",
    );
    const ready = await service.get(SESSION_ID);
    expect(workflow.decisions[0]?.expected.commitSha).toBe(INITIAL_SHA);
    expect(workflow.decisions[0]?.approverId).toBe("judge-live-7");
    expect(workflow.publishCalls).toBe(1);
    expect(ready.pullRequest?.number).toBe(17);
    expect(ready.review).toMatchObject({ status: "passed", round: 1 });
    expect(
      ready.events.find((event) => event.title === "PUBLICATION REQUESTED")
        ?.provenance.provider,
    ).toBe("safeflash-orchestrator");
    expect(workflow.refreshCalls).toBe(1);
  });

  it("revokes a cached READY view when the read-only remote freshness check reports drift", async () => {
    const workflow = new FakeLiveWorkflow();
    workflow.refreshPlan = [invalidatedReadySnapshot()];
    const { service, view } = await startedService(workflow);
    await service.decide(SESSION_ID, decisionBody(view));
    await expect.poll(async () => (await service.get(SESSION_ID)).state).toBe(
      "FAILED",
    );
    const invalidated = await service.get(SESSION_ID);
    expect(invalidated.failure?.reason).toContain("Remote PR head changed");
    expect(invalidated.approval?.invalidatedAt).toBe(LATER);
    expect(invalidated.review).toBeUndefined();
    expect(workflow.refreshCalls).toBe(1);
  });

  it("repairs a blocked review, retains loser-round provenance, and requires fresh approval", async () => {
    const workflow = new FakeLiveWorkflow();
    workflow.publishPlan = [snapshot("REVIEW_BLOCKED", { approved: true })];
    workflow.repairPlan = [snapshot("AWAITING_HUMAN_APPROVAL", { repaired: true })];
    const { service, view } = await startedService(workflow);
    await service.decide(SESSION_ID, decisionBody(view));
    await expect.poll(async () => (await service.get(SESSION_ID)).currentCommitSha).toBe(
      REPAIRED_SHA,
    );
    const repaired = await service.get(SESSION_ID);
    expect(repaired.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(repaired.approval?.invalidatedAt).toBe(LATER);
    expect(repaired.review).toMatchObject({
      round: 1,
      status: "blocked",
      findings: [
        {
          severity: "high",
          filePath: "fixtures/battery-controller/src/battery_controller.c",
          line: 42,
        },
      ],
    });
    expect(repaired.candidates.map((candidate) => candidate.validationRound)).toEqual([
      1,
      1,
      2,
    ]);
    expect(repaired.candidates[0]!.score.experimentId).toBe("experiment-initial");
    expect(repaired.candidates[2]!.score.experimentId).toBe("experiment-repair");
    expect(repaired.candidates[2]!.diff).toContain("candidate-c-repair");
    expect(workflow.publishCalls).toBe(1);
    expect(workflow.repairCalls).toBe(1);
  });

  it("bounds transient publication retries and resumes without a second approval", async () => {
    const workflow = new FakeLiveWorkflow();
    workflow.publishPlan = [
      retryableFailure(),
      retryableFailure(),
      retryableFailure(),
      snapshot("READY_TO_MERGE", { approved: true }),
    ];
    const { service, view } = await startedService(workflow);
    await service.decide(SESSION_ID, decisionBody(view));
    await expect.poll(async () => (await service.get(SESSION_ID)).state).toBe("FAILED");
    expect(await service.get(SESSION_ID)).toMatchObject({
      failure: {
        recoverable: true,
        retryAction: "resume-publication-review",
      },
    });
    await service.retry(SESSION_ID);
    await expect.poll(async () => (await service.get(SESSION_ID)).state).toBe(
      "READY_TO_MERGE",
    );
    expect(workflow.publishCalls).toBe(4);
    expect(workflow.decisions).toHaveLength(1);
  });

  it("resumes the repair checkpoint without republishing the blocked PR", async () => {
    const workflow = new FakeLiveWorkflow();
    workflow.publishPlan = [snapshot("REVIEW_BLOCKED", { approved: true })];
    workflow.repairPlan = [
      retryableFailure(),
      retryableFailure(),
      retryableFailure(),
      snapshot("AWAITING_HUMAN_APPROVAL", { repaired: true }),
    ];
    const { service, view } = await startedService(workflow);
    await service.decide(SESSION_ID, decisionBody(view));
    await expect.poll(async () => (await service.get(SESSION_ID)).state).toBe("FAILED");
    expect((await service.get(SESSION_ID)).failure?.retryAction).toBe(
      "resume-review-repair",
    );
    await service.retry(SESSION_ID);
    await expect.poll(async () => (await service.get(SESSION_ID)).currentCommitSha).toBe(
      REPAIRED_SHA,
    );
    expect(workflow.publishCalls).toBe(1);
    expect(workflow.repairCalls).toBe(4);
  });

  it("routes live POST as 202 with an injected fake and fails closed for cached/unknown modes", async () => {
    const workflow = new FakeLiveWorkflow();
    const service = new LiveSessionService(workflow, {
      idFactory: () => SESSION_ID,
      now: () => new Date(AT),
    });
    process.env.SAFEFLASH_DEFAULT_MODE = "live";
    globalThis.__safeFlashLiveSessionService = service;
    const response = await createSessionRoute(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incidentKind: "battery-sensor-disconnect",
          runKind: "tournament",
        }),
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { session: { state: string } };
    expect(body.session.state).toBe("INGESTING_REPOSITORY");

    globalThis.__safeFlashLiveSessionService = undefined;
    process.env.SAFEFLASH_DEFAULT_MODE = "cached";
    expect(() => getActiveSessionService()).toThrowError(
      expect.objectContaining({
        code: "RECORDED_LIVE_CONFIGURATION_UNAVAILABLE",
      }),
    );
    process.env.SAFEFLASH_DEFAULT_MODE = "hybrid";
    expect(() => getActiveSessionService()).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SESSION_MODE" }),
    );
  });

  it("reports a live UI bridge without claiming a live chat model", async () => {
    process.env.SAFEFLASH_DEFAULT_MODE = "live";
    const response = await getCopilotInfo();
    const body = (await response.json()) as {
      available: boolean;
      mode: string;
      agents: unknown[];
      provenance: { kind: string; verified: boolean };
      uiBridge: { available: boolean; sessionMode: string };
      chatRuntime: { available: boolean; model: unknown };
    };
    expect(body).toMatchObject({
      available: false,
      mode: "chat-runtime-not-configured",
      agents: [],
      provenance: { kind: "unknown", verified: false },
      uiBridge: { available: true, sessionMode: "live" },
      chatRuntime: { available: false, model: null },
    });
  });
});
