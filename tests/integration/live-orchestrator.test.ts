import { describe, expect, it } from "vitest";

import {
  computeCommandHash,
  computeEvidenceDigest,
  sha256,
  type CandidatePatch,
  type PullRequestRecord,
} from "@safeflash/domain";
import { evaluateDeterministicScorers } from "@safeflash/evals";
import {
  LiveSafetyWorkflow,
  P0_LIVE_WORKFLOW_REGISTRY,
  requireSafeLiveSessionId,
  type LiveWorkflowProgressEvent,
  type LiveWorkflowDependencies,
  type LiveWorkflowSnapshot,
  type PreparedCandidatePublication as WorkflowPublication,
} from "@safeflash/orchestrator";
import {
  DAYTONA_REPOSITORY_PATH,
  DEFAULT_DAYTONA_COMMAND_POLICY,
  DaytonaAttemptError,
  ProviderResponseError,
  createFireworksSourceContext,
  type BraintrustExperimentCase,
  type BraintrustExperimentEvidence,
  type CodeRabbitInspectionEvidence,
  type DaytonaValidationEvidence,
  type DaytonaValidationRequest,
  type FireworksCandidateEvidence,
  type FireworksCandidateRequest,
  type FireworksSourceContext,
  type PreparedCandidatePublication,
  type ProviderEnvelope,
} from "@safeflash/integrations";
import {
  registerOfficialTransport,
  transportEnvelope,
} from "../../packages/integrations/src/provider";

const BASE_COMMIT = "a".repeat(40);
const AT = "2026-07-22T18:00:00.000Z";
const REPO_URL = "https://github.com/safe-flash/demo.git";
const officialTransport = registerOfficialTransport({
  transport: "official-sdk" as const,
});

function officialEnvelope<T>(
  provider:
    | "fireworks"
    | "daytona"
    | "braintrust"
    | "github"
    | "coderabbit",
  data: T,
): ProviderEnvelope<T> {
  return transportEnvelope(provider, officialTransport, data, AT);
}

function sourceContext(commitSha: string): FireworksSourceContext {
  return createFireworksSourceContext({
    commitSha,
    files: [
      {
        path: "fixtures/battery-controller/include/battery_controller.h",
        content: "#pragma once\nvoid battery_controller_step(void);\n",
      },
      {
        path: "fixtures/battery-controller/src/battery_controller.c",
        content: "void battery_controller_step(void) {}\n",
      },
    ],
  });
}

function candidateFor(request: FireworksCandidateRequest, variant: string): CandidatePatch {
  return {
    candidateId: request.candidateId,
    strategy: request.strategy,
    hypothesis: `Exercise ${request.evaluationProfile} with ${variant}.`,
    unifiedDiff:
      "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n" +
      "--- a/fixtures/battery-controller/src/battery_controller.c\n" +
      "+++ b/fixtures/battery-controller/src/battery_controller.c\n" +
      "@@ -1 +1 @@\n" +
      "-void battery_controller_step(void) {}\n" +
      `+void battery_controller_step(void) { /* ${variant} */ }\n`,
    expectedSafetyEffect: [`${variant} is evaluated by trusted tests`],
    risks: [
      request.evaluationProfile === "safety-negative-control"
        ? "The diagnostic control intentionally leaves the safety invariant observable."
        : "The repair requires exact-head review.",
    ],
    testsToRun: [...request.requestedTests],
  };
}

function generationEnvelope(
  request: FireworksCandidateRequest,
  candidate: CandidatePatch,
): ProviderEnvelope<FireworksCandidateEvidence> {
  return officialEnvelope("fireworks", {
    candidate,
    sourceContextDigest: request.sourceContext.digest,
    requestDigest: computeEvidenceDigest({ schemaVersion: 1, request }),
    requestId: `fw-${request.candidateId}-${request.seed}`,
    model: "accounts/safeflash/models/test",
    latencyMs: 11,
    finishReason: "stop",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    attemptCount: 1,
  });
}

function daytonaEnvelope(
  request: DaytonaValidationRequest,
  ordinal: number,
  failSafety: boolean,
  sandboxOrdinal = ordinal,
): ProviderEnvelope<DaytonaValidationEvidence> {
  const sandboxId = `daytona-sandbox-${sandboxOrdinal}`;
  const treeSha = (ordinal % 15).toString(16).repeat(40);
  const commands: DaytonaValidationEvidence["commands"][number][] = [];
  for (const [index, definition] of DEFAULT_DAYTONA_COMMAND_POLICY.entries()) {
    const output =
      definition.id === "verify-commit"
        ? request.repository.commitSha
        : definition.id === "validated-tree"
          ? treeSha
          : definition.id === "artifact-manifest"
            ? `manifest-${ordinal}`
            : "ok";
    const argv = ["/bin/sh", "-lc", definition.command];
    const exitCode = failSafety && definition.id === "safety-tests" ? 1 : 0;
    commands.push({
      id: `${request.runId}:${definition.id}`,
      sessionId: request.sessionId,
      createdAt: new Date(index * 10).toISOString(),
      updatedAt: new Date(index * 10 + 1).toISOString(),
      source: "daytona",
      sourceVersion: "@daytona/sdk@0.200.1",
      candidateId: request.candidate.candidateId,
      sandboxId,
      commitSha: request.repository.commitSha,
      argv,
      commandHash: computeCommandHash(argv, DAYTONA_REPOSITORY_PATH),
      artifactHash:
        definition.id === "artifact-manifest" ? sha256(output) : undefined,
      exitCode,
      durationMs: 2,
      stdoutSummary: output,
      stderrSummary: exitCode === 0 ? "" : "trusted safety failure",
      stdoutHash: sha256(output),
      timedOut: false,
    });
    if (exitCode !== 0) break;
  }
  const validatedTreeProduced = commands.some(
    (command) => command.id === `${request.runId}:validated-tree`,
  );
  return officialEnvelope("daytona", {
    runId: request.runId,
    sessionId: request.sessionId,
    candidateId: request.candidate.candidateId,
    sandboxId,
    commitSha: request.repository.commitSha,
    patchDigest: sha256(request.candidate.unifiedDiff),
    policyDigest: computeEvidenceDigest(request.policy),
    validatedTreeSha: validatedTreeProduced ? treeSha : undefined,
    isolatedFilesystem: true,
    networkBlockedBeforePatch: true,
    retained: false,
    destroyed: true,
    passed: !failSafety,
    commands,
  });
}

function binding(snapshot: LiveWorkflowSnapshot) {
  const session = snapshot.session;
  if (
    session.selectedCandidateId === undefined ||
    session.currentPatchDigest === undefined ||
    session.currentEvidenceDigest === undefined ||
    session.currentCommitSha === undefined
  ) {
    throw new Error("missing approval binding");
  }
  return {
    candidateId: session.selectedCandidateId,
    patchDigest: session.currentPatchDigest,
    evidenceDigest: session.currentEvidenceDigest,
    commitSha: session.currentCommitSha,
    policyVersion: session.policyVersion,
  };
}

interface HarnessOptions {
  publishFailures?: number;
  reviews?: readonly ("pending" | "blocked" | "passed")[];
  forgePublication?: boolean;
  failFirstContenderValidation?: boolean;
  repairValidationFailures?: number;
  daytonaDelaysMs?: readonly number[];
  daytonaGatesByCall?: Readonly<Record<number, Promise<void>>>;
  sandboxOrdinalByCall?: Readonly<Record<number, number>>;
  attemptFailuresByCall?: Readonly<
    Record<number, { retryable: boolean; disposition: "failed-destroyed" | "failed-retained" | "cleanup-failed" }>
  >;
  reviewBaseDrift?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const requestsByCandidate = new Map<string, FireworksCandidateRequest>();
  const prepareInputs: Array<Parameters<LiveWorkflowDependencies["publication"]["prepareCandidatePublication"]>[0]> = [];
  const traceNames: string[] = [];
  const traceEvents: Array<
    Parameters<LiveWorkflowDependencies["braintrust"]["traceStage"]>[0]
  > = [];
  let daytonaOrdinal = 0;
  let experimentOrdinal = 0;
  let datasetCalls = 0;
  let publishCalls = 0;
  let reviewCalls = 0;
  let generationCalls = 0;
  let repairValidationFailures = options.repairValidationFailures ?? 0;
  const requestedRunIds: string[] = [];
  const reviewSchedule = [...(options.reviews ?? ["passed"])] as Array<
    "pending" | "blocked" | "passed"
  >;

  const dependencies: LiveWorkflowDependencies = {
    fireworks: {
      async generateTournament(requests) {
        generationCalls += requests.length;
        return requests.map((request, index) => {
          requestsByCandidate.set(request.candidateId, structuredClone(request));
          const candidate = candidateFor(request, `initial-${index + 1}`);
          return generationEnvelope(request, candidate);
        });
      },
      async generateCandidate(request) {
        generationCalls += 1;
        requestsByCandidate.set(request.candidateId, structuredClone(request));
        const candidate = candidateFor(request, `repair-${generationCalls}`);
        return generationEnvelope(request, candidate);
      },
    },
    daytona: {
      async validateCandidate(request) {
        daytonaOrdinal += 1;
        const ordinal = daytonaOrdinal;
        requestedRunIds.push(request.runId);
        const generation = requestsByCandidate.get(request.candidate.candidateId);
        if (generation === undefined) throw new Error("missing generation request");
        const isRepair = request.repository.commitSha !== BASE_COMMIT;
        const forcedRepairFailure = isRepair && repairValidationFailures > 0;
        if (forcedRepairFailure) repairValidationFailures -= 1;
        const delayMs =
          isRepair || ordinal > 3
            ? 0
            : (options.daytonaDelaysMs?.[ordinal - 1] ?? 0);
        const gate = options.daytonaGatesByCall?.[ordinal];
        if (gate !== undefined) await gate;
        if (delayMs > 0) {
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, delayMs);
          });
        }
        const attemptFailure = options.attemptFailuresByCall?.[ordinal];
        if (attemptFailure !== undefined) {
          throw new DaytonaAttemptError({
            attempt: {
              sandboxId: `daytona-sandbox-${ordinal}`,
              runId: request.runId,
              candidateId: request.candidate.candidateId,
              capturedAt: AT,
              disposition: attemptFailure.disposition,
            },
            retryable: attemptFailure.retryable,
          });
        }
        return daytonaEnvelope(
          request,
          ordinal,
          generation.evaluationProfile === "safety-negative-control" ||
            (options.failFirstContenderValidation === true &&
              !isRepair &&
              ordinal === 1) ||
            forcedRepairFailure,
          options.sandboxOrdinalByCall?.[ordinal] ?? ordinal,
        );
      },
    },
    braintrust: {
      async seedFirmwareSafetyDataset() {
        datasetCalls += 1;
        return officialEnvelope("braintrust", {
          datasetId: "dataset-live",
          datasetName: "SafeFlash Firmware Safety",
          datasetVersion: "dataset-v1",
          datasetUrl: "https://www.braintrust.dev/app/test/datasets/dataset-live",
          rowIds: ["row-1"],
          totalRecords: 1,
        });
      },
      async runCandidateExperiment(
        experimentName: string,
        cases: readonly BraintrustExperimentCase[],
      ) {
        experimentOrdinal += 1;
        const evidence: BraintrustExperimentEvidence = {
          projectName: "SafeFlash",
          experimentName,
          projectId: "project-live",
          experimentId: `experiment-${experimentOrdinal}`,
          experimentUrl: `https://www.braintrust.dev/app/test/experiments/${encodeURIComponent(experimentName)}`,
          resultCount: cases.length,
          candidateResults: cases.map((testCase) => ({
            candidateId: testCase.candidateId,
            evidenceDigest: testCase.evidenceDigest,
            evaluationEvidence: structuredClone(testCase.evaluationEvidence),
            scores: evaluateDeterministicScorers(testCase.evaluationEvidence).scores,
            metadata: structuredClone(testCase.metadata),
          })),
        };
        return officialEnvelope("braintrust", evidence);
      },
      async traceStage(event) {
        traceNames.push(event.name);
        traceEvents.push(structuredClone(event));
        const ordinal = traceNames.length;
        return officialEnvelope("braintrust", {
          traceId: `trace-${ordinal}`,
          spanId: `span-${ordinal}`,
          traceUrl: `https://www.braintrust.dev/app/test/traces/trace-${ordinal}`,
        });
      },
    },
    publication: {
      async prepareCandidatePublication(input) {
        prepareInputs.push(structuredClone(input));
        const ordinal = prepareInputs.length;
        const commitSha = (ordinal === 1 ? "d" : "e").repeat(40);
        const data: PreparedCandidatePublication = {
          schemaVersion: 1,
          sessionId: input.sessionId,
          candidateId: input.candidate.candidateId,
          owner: "safe-flash",
          repository: "demo",
          baseBranch: "main",
          baseCommitSha: input.baseCommitSha,
          targetBaseCommitSha: input.targetBaseCommitSha,
          baseTreeSha: "b".repeat(40),
          headBranch: `safeflash/${input.sessionId}`,
          patchDigest: sha256(input.candidate.unifiedDiff),
          unifiedDiff: input.candidate.unifiedDiff,
          treeSha: input.expectedTreeSha,
          commitSha,
          commitMessage: `SafeFlash: publish ${input.candidate.candidateId} for ${input.sessionId}\n`,
          committedAt: AT,
          author: {
            name: "SafeFlash Safety Bot",
            email: "safeflash-safety-bot@users.noreply.github.com",
          },
          changedFiles: [],
          publicationDigest: (ordinal === 1 ? "4" : "5").repeat(64),
        };
        const publication = options.forgePublication
          ? ({
              provider: "github",
              provenance: { mode: "live", kind: "live", capturedAt: AT },
              data,
            } as ProviderEnvelope<PreparedCandidatePublication>)
          : officialEnvelope("github", data);
        return {
          headBranch: data.headBranch,
          baseCommitSha: data.baseCommitSha,
          commitSha: data.commitSha,
          treeSha: data.treeSha,
          publication,
        } satisfies WorkflowPublication;
      },
      async publishApprovedCandidate(input) {
        publishCalls += 1;
        if (publishCalls <= (options.publishFailures ?? 0)) {
          throw new ProviderResponseError(
            "github",
            "transient publication failure",
            true,
          );
        }
        const record: PullRequestRecord = {
          id: "pr-1",
          sessionId: input.session.sessionId,
          createdAt: AT,
          updatedAt: AT,
          source: "github",
          sourceVersion: "api-v1",
          candidateId: input.candidate.candidateId,
          provider: "github",
          owner: "safe-flash",
          repository: "demo",
          number: 17,
          url: "https://github.com/safe-flash/demo/pull/17",
          headSha: input.prepared.commitSha,
          headTreeSha: input.prepared.treeSha,
          baseBranch: "main",
          baseSha: BASE_COMMIT,
          status: "open",
        };
        return officialEnvelope("github", record);
      },
    },
    coderabbit: {
      async waitForReview(request) {
        const status = reviewSchedule[reviewCalls] ?? "passed";
        reviewCalls += 1;
        const blocked = status === "blocked";
        const evidence: CodeRabbitInspectionEvidence = {
          pullNumber: request.pullNumber,
          headSha: request.headSha,
          observedPrHeadSha: request.headSha,
          expectedBaseRef: request.expectedBaseRef,
          expectedBaseSha: request.expectedBaseSha,
          observedBaseRef: request.expectedBaseRef,
          observedBaseSha: options.reviewBaseDrift
            ? "f".repeat(40)
            : request.expectedBaseSha,
          requiresFullRevalidation: options.reviewBaseDrift === true,
          status,
          passed: status === "passed",
          timedOut: status === "pending",
          findings: blocked
            ? [
                {
                  finding: {
                    id: `finding-${reviewCalls}`,
                    sessionId: request.sessionId,
                    createdAt: AT,
                    updatedAt: AT,
                    source: "coderabbit",
                    sourceVersion: request.headSha,
                    provider: "coderabbit",
                    reviewUrl: "https://github.com/safe-flash/demo/checks/123",
                    externalId: `check-${reviewCalls}`,
                    severity: "high",
                    title: "Handle the exact disconnect edge",
                    body: "The current head needs an explicit guard.",
                    filePath:
                      "fixtures/battery-controller/src/battery_controller.c",
                    line: 1,
                    resolved: false,
                  },
                  rawSeverity: "high",
                  sourceKind: "check",
                  headSha: request.headSha,
                },
              ]
            : [],
          exactHeadEvidenceIds: [`check-${reviewCalls}`],
          staleEvidenceIds: [],
          reason: status,
        };
        return officialEnvelope("coderabbit", evidence);
      },
    },
    repository: {
      owner: "safe-flash",
      name: "demo",
      baseBranch: "main",
      repoUrl: REPO_URL,
      async resolveBaseCommit() {
        return BASE_COMMIT;
      },
      async readSourceContext(_sessionId, commitSha) {
        return officialEnvelope("github", sourceContext(commitSha));
      },
    },
    now: () => new Date(AT),
  };

  return {
    workflow: new LiveSafetyWorkflow(dependencies),
    get generationCalls() {
      return generationCalls;
    },
    get daytonaCalls() {
      return daytonaOrdinal;
    },
    requestedRunIds,
    get publishCalls() {
      return publishCalls;
    },
    get reviewCalls() {
      return reviewCalls;
    },
    get datasetCalls() {
      return datasetCalls;
    },
    prepareInputs,
    traceNames,
    traceEvents,
  };
}

async function approve(
  workflow: LiveSafetyWorkflow,
  snapshot: LiveWorkflowSnapshot,
) {
  return workflow.recordHumanDecision({
    sessionId: snapshot.session.sessionId,
    approverId: "human-reviewer",
    decision: "approved",
    expected: binding(snapshot),
  });
}

describe("official live orchestrator composition", () => {
  it("binds the exact temperature-disconnect telemetry and six immutable invariants", () => {
    expect(P0_LIVE_WORKFLOW_REGISTRY.incident).toMatchObject({
      temperatureC: 0,
      sensorFault: true,
      chargingEnabled: true,
    });
    expect(P0_LIVE_WORKFLOW_REGISTRY.policy.invariants).toHaveLength(6);
    expect(P0_LIVE_WORKFLOW_REGISTRY.policy.invariants.join(" ")).toMatch(
      /BATTERY_STALE_SAMPLE_LIMIT/iu,
    );
    expect(P0_LIVE_WORKFLOW_REGISTRY.policy.invariants.join(" ")).toMatch(
      /Normal fresh temperatures/iu,
    );
    expect(() => requireSafeLiveSessionId("../../outside")).toThrow(/safe/iu);
    expect(() => requireSafeLiveSessionId("live/child")).toThrow(/safe/iu);
    expect(requireSafeLiveSessionId("live-safe_01")).toBe("live-safe_01");
  });

  it("runs two real contenders plus a rejected control and serializes evidence-bound approval", async () => {
    const test = harness({ daytonaDelaysMs: [30, 5, 15] });
    const observedEvents: LiveWorkflowProgressEvent[] = [];
    const unsubscribe = test.workflow.subscribeProgress(
      "live-contract-start",
      (event) => observedEvents.push(event),
    );
    const snapshot = await test.workflow.startTournament("live-contract-start");
    unsubscribe();

    expect(snapshot.session.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(test.generationCalls).toBe(3);
    expect(test.daytonaCalls).toBe(3);
    expect(new Set(Object.values(snapshot.session.sandboxIdsByCandidate)).size).toBe(3);
    expect(snapshot.session.sandboxAttemptHistory).toHaveLength(3);
    expect(
      new Set(snapshot.session.sandboxAttemptHistory.map((attempt) => attempt.runId))
        .size,
    ).toBe(3);
    expect(snapshot.decision.rankings.filter((ranking) => ranking.eligible)).toHaveLength(2);
    expect(snapshot.decision.rankings.filter((ranking) => !ranking.eligible)).toHaveLength(1);
    expect(snapshot.selectedCandidate.candidateId).toBe(
      snapshot.decision.winnerCandidateId,
    );
    expect(snapshot.candidates).toHaveLength(3);
    expect(
      snapshot.candidates.filter(
        (item) => item.evaluationProfile === "safety-contender",
      ),
    ).toHaveLength(2);
    expect(
      snapshot.candidates.filter(
        (item) => item.evaluationProfile === "safety-negative-control",
      ),
    ).toHaveLength(1);
    for (const item of snapshot.candidates) {
      expect(item.candidate.unifiedDiff).toContain("diff --git");
      expect(item.validation.sandboxId).toMatch(/^daytona-sandbox-/u);
      expect(item.validation.runId).not.toBe("");
      expect(item.validation.commands.length).toBeGreaterThan(0);
      expect(item.validation.unitTests.total).toBeGreaterThan(0);
      expect(item.validation.safetyTests.total).toBeGreaterThan(0);
      expect(item.scoring.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(item.scoring.experimentUrl).toContain("braintrust.dev");
    }
    const observedStages = observedEvents.map((event) => event.stage);
    expect(observedStages).toEqual(
      expect.arrayContaining([
        "workflow-started",
        "repository-ingested",
        "incident-analyzed",
        "candidates-generated",
        "candidate-validated",
        "scoring-finished",
        "candidate-selected",
      ]),
    );
    expect(test.workflow.getProgress(snapshot.session.sessionId)).toHaveLength(
      observedStages.length,
    );
    expect(
      observedEvents.find((event) => event.stage === "workflow-started")
        ?.provider,
    ).toBeUndefined();
    expect(
      observedEvents.find((event) => event.stage === "repository-ingested")
        ?.provider,
    ).toBe("github");
    const generatedProgress = observedEvents.find(
      (event) => event.stage === "candidates-generated",
    );
    expect(generatedProgress?.candidates).toHaveLength(3);
    for (const candidate of generatedProgress?.candidates ?? []) {
      expect(candidate.unifiedDiff).toContain("diff --git");
      expect(candidate.hypothesis).not.toBe("");
      expect(candidate.patchDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(candidate.generationCapturedAt).toBe(AT);
    }
    const validationProgress = observedEvents.filter(
      (event) => event.stage === "candidate-validated",
    );
    expect(validationProgress.map((event) => event.candidateId)).toEqual([
      "candidate-2-retry-and-latch",
      "candidate-3-range-validation",
      "candidate-1-fail-closed",
    ]);
    for (const event of validationProgress) {
      expect(event.validation?.sandboxId).toMatch(/^daytona-sandbox-/u);
      expect(event.validation?.runId).not.toBe("");
      expect(event.validation?.capturedAt).toBe(AT);
      expect(event.validation?.unitTests.total).toBeGreaterThan(0);
      expect(event.validation?.safetyTests.total).toBeGreaterThan(0);
      expect(typeof event.validation?.integrity.passed).toBe("boolean");
    }
    expect(snapshot.providerEvidence.stageTraceUrls.length).toBeGreaterThanOrEqual(8);
    expect(test.publishCalls).toBe(0);

    await expect(
      test.workflow.publishApprovedAndReview(snapshot.session.sessionId),
    ).rejects.toThrow(/approval|approved/iu);
    expect(test.publishCalls).toBe(0);

    const stale = binding(snapshot);
    await expect(
      test.workflow.recordHumanDecision({
        sessionId: snapshot.session.sessionId,
        approverId: "human-reviewer",
        decision: "approved",
        expected: { ...stale, evidenceDigest: "0".repeat(64) },
      }),
    ).rejects.toThrow(/stale/iu);

    const decisions = await Promise.allSettled([
      approve(test.workflow, snapshot),
      test.workflow.recordHumanDecision({
        sessionId: snapshot.session.sessionId,
        approverId: "second-reviewer",
        decision: "rejected",
        expected: stale,
      }),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);

    const reviewed = await test.workflow.publishApprovedAndReview(
      snapshot.session.sessionId,
    );
    expect(reviewed.session.state).toBe("READY_TO_MERGE");
    expect(test.publishCalls).toBe(1);
    expect(test.reviewCalls).toBe(1);
    expect(test.traceNames).toContain("safeflash.github-approved-publication");
    expect(test.traceNames).toContain("safeflash.coderabbit-independent-review");
    const progress = test.workflow.getProgress(snapshot.session.sessionId);
    expect(
      progress.find((event) => event.stage === "publication-requested")?.provider,
    ).toBeUndefined();
    expect(
      progress.find((event) => event.stage === "pull-request-published")?.provider,
    ).toBe("github");
  });

  it("resumes a failed publication and pending CodeRabbit poll without a duplicate PR write", async () => {
    const test = harness({ publishFailures: 1, reviews: ["pending", "passed"] });
    const snapshot = await test.workflow.startTournament("live-contract-resume");
    await approve(test.workflow, snapshot);

    await expect(
      test.workflow.publishApprovedAndReview(snapshot.session.sessionId),
    ).rejects.toThrow(/transient publication/iu);
    expect(test.workflow.getSession(snapshot.session.sessionId).state).toBe(
      "CREATING_PULL_REQUEST",
    );

    let pendingError: unknown;
    try {
      await test.workflow.publishApprovedAndReview(snapshot.session.sessionId);
    } catch (error) {
      pendingError = error;
    }
    expect(pendingError).toBeInstanceOf(ProviderResponseError);
    expect((pendingError as ProviderResponseError).retryable).toBe(true);
    expect((pendingError as Error).message).toMatch(/still pending/iu);
    expect(test.workflow.getSession(snapshot.session.sessionId).state).toBe(
      "AWAITING_CODERABBIT",
    );

    const completed = await test.workflow.publishApprovedAndReview(
      snapshot.session.sessionId,
    );
    expect(completed.session.state).toBe("READY_TO_MERGE");
    expect(test.publishCalls).toBe(2);
    expect(test.reviewCalls).toBe(2);
    expect(test.datasetCalls).toBe(1);
  });

  it("settles every parallel Daytona attempt before releasing a failed start for retry", async () => {
    let releaseSecond!: () => void;
    let releaseThird!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const thirdGate = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
    const test = harness({
      attemptFailuresByCall: {
        1: { retryable: true, disposition: "failed-destroyed" },
      },
      daytonaGatesByCall: { 2: secondGate, 3: thirdGate },
    });
    const firstAttempt = test.workflow.startTournament(
      "live-contract-partial-retry",
    );
    let firstSettled = false;
    void firstAttempt.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    for (let tick = 0; tick < 50 && test.daytonaCalls < 3; tick += 1) {
      await Promise.resolve();
    }
    expect(test.daytonaCalls).toBe(3);
    expect(firstSettled).toBe(false);
    await expect(
      test.workflow.startTournament("live-contract-partial-retry"),
    ).rejects.toThrow(/already exists or is starting/iu);

    releaseSecond();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(firstSettled).toBe(false);
    releaseThird();
    await expect(firstAttempt).rejects.toMatchObject({
      name: "DaytonaAttemptError",
      retryable: true,
    });
    expect(
      test.workflow.getSandboxAttemptHistory("live-contract-partial-retry"),
    ).toHaveLength(3);

    const resumed = await test.workflow.startTournament(
      "live-contract-partial-retry",
    );
    expect(resumed.session.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(test.daytonaCalls).toBe(6);
    expect(new Set(test.requestedRunIds).size).toBe(6);
    expect(test.requestedRunIds).toEqual(
      Array.from(
        { length: 6 },
        (_, index) =>
          `live-contract-partial-retry-daytona-${String(index + 1).padStart(6, "0")}`,
      ),
    );
    expect(resumed.session.sandboxAttemptHistory).toHaveLength(6);
    expect(
      resumed.session.sandboxAttemptHistory.find(
        (attempt) => attempt.disposition === "failed-destroyed",
      ),
    ).toMatchObject({ retryable: true, reservationStatus: "reserved" });
  });

  it("fails nonretryably instead of entering READY when the PR base drifts during review", async () => {
    const test = harness({ reviewBaseDrift: true });
    const snapshot = await test.workflow.startTournament("live-contract-base-drift");
    await approve(test.workflow, snapshot);

    let caught: unknown;
    try {
      await test.workflow.publishApprovedAndReview(snapshot.session.sessionId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderResponseError);
    expect(caught).toMatchObject({ provider: "coderabbit", retryable: false });
    expect((caught as Error).message).toMatch(/base moved/iu);
    expect(test.workflow.getSession(snapshot.session.sessionId).state).toBe(
      "AWAITING_CODERABBIT",
    );
  });

  it("uses one bounded real-provider regeneration when a contender misses a hard gate", async () => {
    const test = harness({ failFirstContenderValidation: true });
    const snapshot = await test.workflow.startTournament(
      "live-contract-profile-regeneration",
    );
    expect(snapshot.session.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(test.generationCalls).toBe(4);
    expect(test.daytonaCalls).toBe(4);
    expect(test.datasetCalls).toBe(1);
    expect(snapshot.session.sandboxAttemptHistory).toHaveLength(4);
    expect(
      snapshot.session.sandboxAttemptHistory.filter(
        (attempt) => attempt.purpose === "profile-replacement",
      ),
    ).toHaveLength(1);
    expect(
      new Set(
        snapshot.session.sandboxAttemptHistory.map(
          (attempt) => attempt.sandboxId,
        ),
      ).size,
    ).toBe(4);
    expect(snapshot.candidates.filter((item) => item.scoring.eligible)).toHaveLength(2);
    expect(test.traceNames).toContain("safeflash.fireworks-profile-regenerated");
    expect(
      test.traceEvents.find(
        (event) => event.name === "safeflash.fireworks-profile-regenerated",
      )?.output,
    ).toMatchObject({
      requestId: expect.any(String),
      model: "accounts/safeflash/models/test",
      latencyMs: 11,
      totalTokens: 150,
    });
  });

  it("rejects a profile replacement that reuses the discarded slot sandbox", async () => {
    const test = harness({
      failFirstContenderValidation: true,
      sandboxOrdinalByCall: { 4: 1 },
    });
    await expect(
      test.workflow.startTournament("live-contract-profile-reuse"),
    ).rejects.toThrow(/globally unique sandbox ID and run ID/iu);
    expect(test.daytonaCalls).toBe(4);
    expect(
      test.workflow.getSandboxAttemptHistory("live-contract-profile-reuse"),
    ).toHaveLength(4);
    expect(
      test.workflow
        .getSandboxAttemptHistory("live-contract-profile-reuse")
        .at(-1),
    ).toMatchObject({
      reservationStatus: "rejected-reuse",
      duplicateSandbox: true,
    });
  });

  it("repairs a blocked exact head in a fresh sandbox, invalidates approval, and updates the same PR", async () => {
    const test = harness({
      reviews: ["blocked", "passed"],
      repairValidationFailures: 1,
    });
    const initial = await test.workflow.startTournament("live-contract-repair");
    const oldBinding = binding(initial);
    await approve(test.workflow, initial);
    const blocked = await test.workflow.publishApprovedAndReview(
      initial.session.sessionId,
    );
    expect(blocked.session.state).toBe("REVIEW_BLOCKED");
    const initialEvidenceByCandidate = new Map(
      initial.candidates.map((item) => [item.candidate.candidateId, item]),
    );

    const repaired = await test.workflow.repairBlockedReview(
      initial.session.sessionId,
    );
    expect(repaired.session.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(repaired.session.approval?.invalidatedAt).toBeDefined();
    expect(repaired.session.currentEvidenceDigest).not.toBe(
      oldBinding.evidenceDigest,
    );
    expect(repaired.providerEvidence.daytonaSandboxId).not.toBe(
      initial.providerEvidence.daytonaSandboxId,
    );
    expect(repaired.candidates).toHaveLength(3);
    for (const item of repaired.candidates) {
      const before = initialEvidenceByCandidate.get(item.candidate.candidateId)!;
      if (item.candidate.candidateId === repaired.selectedCandidate.candidateId) {
        expect(item.validation.sandboxId).not.toBe(before.validation.sandboxId);
        expect(item.scoring.experimentId).not.toBe(before.scoring.experimentId);
      } else {
        expect(item.validation.sandboxId).toBe(before.validation.sandboxId);
        expect(item.scoring.experimentId).toBe(before.scoring.experimentId);
      }
    }
    expect(test.prepareInputs).toHaveLength(2);
    expect(test.prepareInputs[1]!.baseCommitSha).toBe(
      blocked.session.pullRequest?.headSha,
    );
    expect(test.prepareInputs[1]!.targetBaseCommitSha).toBe(BASE_COMMIT);

    await expect(
      test.workflow.recordHumanDecision({
        sessionId: initial.session.sessionId,
        approverId: "human-reviewer",
        decision: "approved",
        expected: oldBinding,
      }),
    ).rejects.toThrow(/stale/iu);
    await expect(
      test.workflow.publishApprovedAndReview(initial.session.sessionId),
    ).rejects.toThrow(/approval|approved/iu);
    expect(test.publishCalls).toBe(1);

    await approve(test.workflow, repaired);
    const ready = await test.workflow.publishApprovedAndReview(
      initial.session.sessionId,
    );
    expect(ready.session.state).toBe("READY_TO_MERGE");
    expect(ready.session.pullRequest?.number).toBe(17);
    expect(test.publishCalls).toBe(2);
    expect(test.reviewCalls).toBe(2);
    expect(test.generationCalls).toBe(5);
    expect(test.daytonaCalls).toBe(5);
    expect(repaired.session.sandboxAttemptHistory).toHaveLength(5);
    expect(
      repaired.session.sandboxAttemptHistory.filter(
        (attempt) => attempt.purpose === "review-repair",
      ),
    ).toHaveLength(2);
    expect(test.traceNames).toContain("safeflash.review-repair-revalidated");
    expect(
      test.traceEvents.find(
        (event) => event.name === "safeflash.fireworks-review-repair-generated",
      )?.output,
    ).toMatchObject({
      requestId: expect.any(String),
      model: "accounts/safeflash/models/test",
      latencyMs: 11,
      totalTokens: 150,
    });
  });

  it("rejects a repair retry that reuses the failed repair sandbox", async () => {
    const test = harness({
      reviews: ["blocked"],
      repairValidationFailures: 1,
      sandboxOrdinalByCall: { 5: 4 },
    });
    const initial = await test.workflow.startTournament(
      "live-contract-repair-reuse",
    );
    await approve(test.workflow, initial);
    const blocked = await test.workflow.publishApprovedAndReview(
      initial.session.sessionId,
    );
    expect(blocked.session.state).toBe("REVIEW_BLOCKED");

    await expect(
      test.workflow.repairBlockedReview(initial.session.sessionId),
    ).rejects.toThrow(/globally unique sandbox ID and run ID/iu);
    expect(test.daytonaCalls).toBe(5);
    const history = test.workflow.getSandboxAttemptHistory(
      initial.session.sessionId,
    );
    expect(history).toHaveLength(5);
    expect(history.at(-1)).toMatchObject({
      purpose: "review-repair",
      sandboxId: "daytona-sandbox-4",
      reservationStatus: "rejected-reuse",
      duplicateSandbox: true,
    });
    expect(test.workflow.getSession(initial.session.sessionId).state).toBe(
      "FAILED",
    );
    expect(
      test.workflow.getSession(initial.session.sessionId).sandboxAttemptHistory,
    ).toEqual(history);
  });

  it("uses a fresh monotonic run ID when a repair Daytona attempt fails transiently", async () => {
    const test = harness({
      reviews: ["blocked"],
      attemptFailuresByCall: {
        4: { retryable: true, disposition: "cleanup-failed" },
      },
    });
    const initial = await test.workflow.startTournament(
      "live-contract-repair-transient",
    );
    await approve(test.workflow, initial);
    const blocked = await test.workflow.publishApprovedAndReview(
      initial.session.sessionId,
    );
    expect(blocked.session.state).toBe("REVIEW_BLOCKED");

    await expect(
      test.workflow.repairBlockedReview(initial.session.sessionId),
    ).rejects.toMatchObject({ name: "DaytonaAttemptError", retryable: true });
    const failedHistory = test.workflow.getSandboxAttemptHistory(
      initial.session.sessionId,
    );
    expect(failedHistory.at(-1)).toMatchObject({
      runId: "live-contract-repair-transient-daytona-000004",
      disposition: "cleanup-failed",
      reservationStatus: "reserved",
    });

    const repaired = await test.workflow.repairBlockedReview(
      initial.session.sessionId,
    );
    expect(repaired.session.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(test.requestedRunIds.at(-1)).toBe(
      "live-contract-repair-transient-daytona-000005",
    );
    expect(new Set(test.requestedRunIds).size).toBe(test.requestedRunIds.length);
    expect(repaired.session.sandboxAttemptHistory).toHaveLength(5);
  });

  it("rejects a structurally-live but unbranded GitHub publication before approval", async () => {
    const test = harness({ forgePublication: true });
    await expect(
      test.workflow.startTournament("live-contract-forged"),
    ).rejects.toThrow(/not official/iu);
    expect(
      test.workflow.getSandboxAttemptHistory("live-contract-forged"),
    ).toHaveLength(3);
    await expect(
      test.workflow.startTournament("live-contract-forged"),
    ).rejects.toThrow(/not official/iu);
    const resumedHistory =
      test.workflow.getSandboxAttemptHistory("live-contract-forged");
    expect(resumedHistory).toHaveLength(6);
    expect(resumedHistory.every((attempt) => attempt.reservationStatus === "reserved"))
      .toBe(true);
    expect(new Set(resumedHistory.map((attempt) => attempt.runId)).size).toBe(6);
    expect(test.publishCalls).toBe(0);
  });
});
