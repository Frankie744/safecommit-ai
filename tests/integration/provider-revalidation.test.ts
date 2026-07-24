import { describe, expect, it } from "vitest";

import {
  computeCommandHash,
  computeEvidenceDigest,
  createValidationSession,
  sha256,
  type CandidatePatch,
  type ValidationSession,
} from "@safeflash/domain";
import {
  evaluateDeterministicScorers,
  type CandidateEvaluationEvidence,
} from "@safeflash/evals";
import {
  DAYTONA_REPOSITORY_PATH,
  DEFAULT_DAYTONA_COMMAND_POLICY,
  ProviderResponseError,
  buildLiveCandidateEvaluationEvidence,
  computeLiveCandidateEvidenceDigest,
  createLiveFullRevalidationReceipt,
  createFireworksSourceContext,
  localTestEnvelope,
  type BraintrustExperimentEvidence,
  type DaytonaValidationEvidence,
  type FireworksCandidateRequest,
  type PreparedCandidatePublication,
  type ProviderEnvelope,
} from "@safeflash/integrations";
import {
  registerOfficialTransport,
  transportEnvelope,
} from "../../packages/integrations/src/provider";

const officialTestTransport = registerOfficialTransport({
  transport: "official-sdk" as const,
});

function officialEnvelope<T>(
  provider: "fireworks" | "daytona" | "braintrust" | "github",
  data: T,
) {
  return transportEnvelope(provider, officialTestTransport, data, at);
}

const BASE_HEAD = "a".repeat(40);
const REPAIRED_HEAD = "b".repeat(40);
const VALIDATED_TREE = "c".repeat(40);
const at = "2026-07-22T12:00:00.000Z";
const policy = {
  id: "policy-1",
  policyVersion: "policy-v1",
  allowedPatchPaths: ["fixtures/battery-controller/src/**"],
  maxChangedFiles: 4,
  maxChangedLines: 100,
} as const;

const candidate: CandidatePatch = {
  candidateId: "candidate-safe",
  strategy: "fail-closed",
  hypothesis: "Latch the sensor fault and disable charging.",
  unifiedDiff:
    "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -1 +1 @@\n-old\n+new\n",
  expectedSafetyEffect: ["charging is disabled"],
  risks: ["manual fault clear is required"],
  testsToRun: ["trusted policy selects the real commands"],
};

function generation(candidatePatch: CandidatePatch, seed = 1) {
  const sourceContext = createFireworksSourceContext({
    commitSha: BASE_HEAD,
    files: [
      {
        path: "fixtures/battery-controller/src/battery_controller.c",
        content: "old\nold2\nold3\n",
      },
    ],
  });
  const request: FireworksCandidateRequest = {
    sessionId: "session-revalidation",
    candidateId: candidatePatch.candidateId,
    strategy: candidatePatch.strategy,
    evaluationProfile:
      candidatePatch.strategy === "fail-closed"
        ? "safety-contender"
        : candidatePatch.strategy === "retry-and-latch"
          ? "safety-contender"
          : "safety-negative-control",
    incident: {
      title: "Sensor disconnect",
      summary: "Missing current evidence must fail closed.",
      evidence: ["timeout"],
    },
    safetyPolicy: {
      policyVersion: policy.policyVersion,
      invariants: ["disable charging"],
      allowedPatchPaths: policy.allowedPatchPaths,
      protectedPaths: ["fixtures/battery-controller/tests/**"],
      maxChangedFiles: policy.maxChangedFiles,
      maxChangedLines: policy.maxChangedLines,
    },
    repository: {
      repoUrl: "https://github.com/safe-flash/demo.git",
      commitSha: BASE_HEAD,
    },
    sourceContext,
    requestedTests: [...candidatePatch.testsToRun],
    seed,
  };
  return {
    request,
    evidence: officialEnvelope("fireworks", {
      candidate: candidatePatch,
      sourceContextDigest: sourceContext.digest,
      requestDigest: computeEvidenceDigest({ schemaVersion: 1, request }),
      requestId: `fw-${candidatePatch.candidateId}`,
      model: "accounts/safeflash/models/test",
      latencyMs: 10,
      totalTokens: 150,
      finishReason: "stop",
      attemptCount: 1,
    }),
    sourceContext: officialEnvelope("github", sourceContext),
  };
}

function publicationEvidence(input: {
  sessionId: string;
  candidatePatch: CandidatePatch;
  baseCommitSha: string;
  targetBaseCommitSha: string;
  treeSha: string;
  commitSha: string;
}): ProviderEnvelope<PreparedCandidatePublication> {
  return officialEnvelope("github", {
    schemaVersion: 1,
    sessionId: input.sessionId,
    candidateId: input.candidatePatch.candidateId,
    owner: "safe-flash",
    repository: "demo",
    baseBranch: "main",
    baseCommitSha: input.baseCommitSha,
    targetBaseCommitSha: input.targetBaseCommitSha,
    baseTreeSha: "8".repeat(40),
    headBranch: `safeflash/${input.sessionId}`,
    patchDigest: sha256(input.candidatePatch.unifiedDiff),
    unifiedDiff: input.candidatePatch.unifiedDiff,
    treeSha: input.treeSha,
    commitSha: input.commitSha,
    commitMessage: `SafeFlash: publish ${input.candidatePatch.candidateId} for ${input.sessionId}\n`,
    committedAt: at,
    author: {
      name: "SafeFlash Safety Bot",
      email: "safeflash-safety-bot@users.noreply.github.com",
    },
    changedFiles: [],
    publicationDigest: "9".repeat(64),
  });
}

function session(): ValidationSession {
  const initial = createValidationSession({
    id: "session-revalidation",
    incidentId: "incident-1",
    policyId: "policy-1",
    policyVersion: "policy-v1",
    policySnapshot: {
      allowedPatchPaths: policy.allowedPatchPaths,
      maxChangedFiles: policy.maxChangedFiles,
      maxChangedLines: policy.maxChangedLines,
    },
    repository: {
      repoUrl: "https://github.com/safe-flash/demo.git",
      commitSha: "0".repeat(40),
    },
    pullRequestTarget: {
      provider: "github",
      owner: "safe-flash",
      repository: "demo",
      baseBranch: "main",
    },
    mode: "live",
    sourceVersion: "workflow-v1",
    at,
  });
  return {
    ...initial,
    state: "REVALIDATING",
    candidateIds: [candidate.candidateId],
    selectedCandidateId: candidate.candidateId,
    currentPatchDigest: sha256(candidate.unifiedDiff),
    currentEvidenceDigest: "d".repeat(64),
    pullRequest: {
      id: "pr-1",
      sessionId: initial.sessionId,
      createdAt: at,
      updatedAt: at,
      source: "github",
      sourceVersion: "api-v1",
      candidateId: candidate.candidateId,
      provider: "github",
      owner: "safe-flash",
      repository: "demo",
      number: 1,
      url: "https://github.com/safe-flash/demo/pull/1",
      headSha: BASE_HEAD,
      headTreeSha: "e".repeat(40),
      baseBranch: "main",
      baseSha: BASE_HEAD,
      status: "open",
    },
    sandboxAttemptHistory: [
      {
        candidateId: candidate.candidateId,
        sandboxId: "daytona-fresh-sandbox",
        runId: "repair-run-2",
        purpose: "review-repair",
        capturedAt: at,
        disposition: "completed",
        retryable: false,
        reservationStatus: "reserved",
        duplicateSandbox: false,
        duplicateRun: false,
      },
    ],
  };
}

function passingEvaluation(
  overrides: Partial<CandidateEvaluationEvidence> = {},
): CandidateEvaluationEvidence {
  return {
    candidateId: candidate.candidateId,
    build: { exitCode: 0 },
    unitTests: { passed: 20, total: 20 },
    safetyTests: { passed: 6, total: 6, criticalFailures: [] },
    regressionTests: { passed: 10, total: 10 },
    integrity: { passed: true, violations: [] },
    patch: {
      changedFiles: 1,
      changedLines: 8,
      maxChangedFiles: 4,
      maxChangedLines: 100,
      binaryFiles: 0,
      dependenciesAdded: 0,
    },
    explanation: { supportedClaims: 3, totalClaims: 3 },
    reproduction: {
      attempted: true,
      sameCommit: true,
      sameConfiguration: true,
      artifactHashesMatch: true,
    },
    ...overrides,
  };
}

function daytonaEvidence(): ProviderEnvelope<DaytonaValidationEvidence> {
  const runId = "repair-run-2";
  const sandboxId = "daytona-fresh-sandbox";
  const commands = DEFAULT_DAYTONA_COMMAND_POLICY.map((definition, index) => {
    const output =
      definition.id === "verify-commit"
        ? BASE_HEAD
        : definition.id === "validated-tree"
          ? VALIDATED_TREE
          : definition.id === "artifact-manifest"
            ? "artifact manifest"
            : "ok";
    const argv = ["/bin/sh", "-lc", definition.command];
    return {
      id: `${runId}:${definition.id}`,
      sessionId: "session-revalidation",
      createdAt: new Date(index * 10).toISOString(),
      updatedAt: new Date(index * 10 + 1).toISOString(),
      source: "daytona",
      sourceVersion: "@daytona/sdk@0.200.1",
      candidateId: candidate.candidateId,
      sandboxId,
      commitSha: BASE_HEAD,
      argv,
      commandHash: computeCommandHash(argv, DAYTONA_REPOSITORY_PATH),
      artifactHash:
        definition.id === "artifact-manifest" ? sha256(output) : undefined,
      exitCode: 0,
      durationMs: 1,
      stdoutSummary: output,
      stderrSummary: "",
      stdoutHash: sha256(output),
      timedOut: false,
    };
  });
  return officialEnvelope("daytona", {
    runId,
    sessionId: "session-revalidation",
    candidateId: candidate.candidateId,
    sandboxId,
    commitSha: BASE_HEAD,
    patchDigest: sha256(candidate.unifiedDiff),
    policyDigest: computeEvidenceDigest({
      policyVersion: policy.policyVersion,
      allowedPatchPaths: policy.allowedPatchPaths,
      maxChangedFiles: policy.maxChangedFiles,
      maxChangedLines: policy.maxChangedLines,
    }),
    validatedTreeSha: VALIDATED_TREE,
    isolatedFilesystem: true,
    networkBlockedBeforePatch: true,
    retained: false,
    destroyed: true,
    passed: true,
    commands,
  });
}

function braintrustEvidence(
  daytona: DaytonaValidationEvidence,
): ProviderEnvelope<BraintrustExperimentEvidence> {
  const evaluationEvidence = buildLiveCandidateEvaluationEvidence({
    candidate,
    daytona,
    policy,
  });
  const scores = evaluateDeterministicScorers(evaluationEvidence).scores;
  const evidenceDigest = computeLiveCandidateEvidenceDigest({
    policyVersion: "policy-v1",
    daytona,
    scores,
  });
  return officialEnvelope("braintrust", {
    projectName: "SafeFlash",
    experimentName: "review-revalidation-2",
    projectId: "project-live-1",
    experimentId: "experiment-live-2",
    experimentUrl:
      "https://www.braintrust.dev/app/safeflash/experiments/review-revalidation-2",
    resultCount: 1,
    candidateResults: [
      {
        candidateId: candidate.candidateId,
        resultId: "eval-result-review-revalidation-2",
        evidenceDigest,
        evaluationEvidence,
        scores,
        metadata: {
          sessionId: "session-revalidation",
          patchDigest: sha256(candidate.unifiedDiff),
          sandboxId: daytona.sandboxId,
          validatedTreeSha: VALIDATED_TREE,
          policyVersion: "policy-v1",
        },
      },
    ],
  });
}

function inputs() {
  const currentSession = session();
  const daytona = daytonaEvidence();
  const braintrust = braintrustEvidence(daytona.data);
  return {
    purpose: "review-repair" as const,
    session: currentSession,
    policy,
    candidate,
    commitSha: REPAIRED_HEAD,
    commitTreeSha: VALIDATED_TREE,
    daytona,
    braintrust,
    generations: [generation(candidate)],
    publication: publicationEvidence({
      sessionId: currentSession.sessionId,
      candidatePatch: candidate,
      baseCommitSha: BASE_HEAD,
      targetBaseCommitSha: currentSession.repository.commitSha,
      treeSha: VALIDATED_TREE,
      commitSha: REPAIRED_HEAD,
    }),
  };
}

const initialCandidates: readonly CandidatePatch[] = [
  candidate,
  {
    ...candidate,
    candidateId: "candidate-lower-eligible",
    strategy: "retry-and-latch",
    unifiedDiff:
      "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -1,3 +1,6 @@\n-old\n-old2\n-old3\n+new\n+new2\n+new3\n+new4\n+new5\n+new6\n",
  },
  {
    ...candidate,
    candidateId: "candidate-build-fails",
    strategy: "range-validation",
    unifiedDiff:
      "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -2 +2 @@\n-old2\n+unsafe\n",
  },
] as const;

function initialSession(): ValidationSession {
  const initial = createValidationSession({
    id: "session-revalidation",
    incidentId: "incident-1",
    policyId: policy.id,
    policyVersion: policy.policyVersion,
    policySnapshot: {
      allowedPatchPaths: policy.allowedPatchPaths,
      maxChangedFiles: policy.maxChangedFiles,
      maxChangedLines: policy.maxChangedLines,
    },
    repository: {
      repoUrl: "https://github.com/safe-flash/demo.git",
      commitSha: BASE_HEAD,
    },
    pullRequestTarget: {
      provider: "github",
      owner: "safe-flash",
      repository: "demo",
      baseBranch: "main",
    },
    mode: "live",
    sourceVersion: "workflow-v1",
    at,
  });
  return {
    ...initial,
    state: "SELECTING",
    candidateIds: initialCandidates.map((item) => item.candidateId),
    sandboxIdsByCandidate: Object.fromEntries(
      initialCandidates.map((item, index) => [
        item.candidateId,
        `daytona-initial-${index + 1}`,
      ]),
    ),
    sandboxAttemptHistory: initialCandidates.map((item, index) => ({
      candidateId: item.candidateId,
      sandboxId: `daytona-initial-${index + 1}`,
      runId: `initial-run-${index + 1}`,
      purpose: "initial-candidate" as const,
      capturedAt: at,
      disposition: "completed" as const,
      retryable: false,
      reservationStatus: "reserved" as const,
      duplicateSandbox: false,
      duplicateRun: false,
    })),
  };
}

function initialDaytona(
  candidatePatch: CandidatePatch,
  index: number,
  failAt?: "patch-check" | "build" | "safety-tests",
): ProviderEnvelope<DaytonaValidationEvidence> {
  const runId = `initial-run-${index + 1}`;
  const sandboxId = `daytona-initial-${index + 1}`;
  const tree = String(index + 3).repeat(40);
  const commands = [] as DaytonaValidationEvidence["commands"][number][];
  for (const [commandIndex, definition] of DEFAULT_DAYTONA_COMMAND_POLICY.entries()) {
    const output =
      definition.id === "verify-commit"
        ? BASE_HEAD
        : definition.id === "validated-tree"
          ? tree
          : definition.id === "artifact-manifest"
            ? `artifact manifest ${index}`
            : "ok";
    const argv = ["/bin/sh", "-lc", definition.command];
    const exitCode = failAt === definition.id ? 1 : 0;
    commands.push({
      id: `${runId}:${definition.id}`,
      sessionId: "session-revalidation",
      createdAt: new Date(commandIndex * 10).toISOString(),
      updatedAt: new Date(commandIndex * 10 + 1).toISOString(),
      source: "daytona",
      sourceVersion: "@daytona/sdk@0.200.1",
      candidateId: candidatePatch.candidateId,
      sandboxId,
      commitSha: BASE_HEAD,
      argv,
      commandHash: computeCommandHash(argv, DAYTONA_REPOSITORY_PATH),
      artifactHash:
        definition.id === "artifact-manifest" ? sha256(output) : undefined,
      exitCode,
      durationMs: 1,
      stdoutSummary: output,
      stderrSummary: "",
      stdoutHash: sha256(output),
      timedOut: false,
    });
    if (exitCode !== 0) break;
  }
  const treeWasProduced = commands.some(
    (command) => command.id === `${runId}:validated-tree` && command.exitCode === 0,
  );
  return officialEnvelope("daytona", {
    runId,
    sessionId: "session-revalidation",
    candidateId: candidatePatch.candidateId,
    sandboxId,
    commitSha: BASE_HEAD,
    patchDigest: sha256(candidatePatch.unifiedDiff),
    policyDigest: computeEvidenceDigest({
      policyVersion: policy.policyVersion,
      allowedPatchPaths: policy.allowedPatchPaths,
      maxChangedFiles: policy.maxChangedFiles,
      maxChangedLines: policy.maxChangedLines,
    }),
    validatedTreeSha: treeWasProduced ? tree : undefined,
    isolatedFilesystem: true,
    networkBlockedBeforePatch: true,
    retained: false,
    destroyed: true,
    passed: failAt === undefined,
    commands,
  });
}

function initialInputs(selectedIndex = 0) {
  const currentSession = initialSession();
  const daytonas = initialCandidates.map((item, index) =>
    initialDaytona(item, index, index === 2 ? "safety-tests" : undefined),
  );
  const candidateResults = initialCandidates.map((item, index) => {
    const evaluationEvidence = buildLiveCandidateEvaluationEvidence({
      candidate: item,
      daytona: daytonas[index]!.data,
      policy,
    });
    const scores = evaluateDeterministicScorers(evaluationEvidence).scores;
    return {
      candidateId: item.candidateId,
      resultId: `eval-result-initial-${index + 1}`,
      evidenceDigest: computeLiveCandidateEvidenceDigest({
        policyVersion: policy.policyVersion,
        daytona: daytonas[index]!.data,
        scores,
      }),
      evaluationEvidence,
      scores,
      metadata: {
        sessionId: currentSession.sessionId,
        patchDigest: sha256(item.unifiedDiff),
        sandboxId: daytonas[index]!.data.sandboxId,
        validatedTreeSha: daytonas[index]!.data.validatedTreeSha ?? null,
        policyVersion: policy.policyVersion,
      },
    };
  });
  const braintrust = officialEnvelope("braintrust", {
    projectName: "SafeFlash",
    experimentName: "initial-tournament",
    projectId: "project-live-1",
    experimentId: "experiment-initial",
    experimentUrl:
      "https://www.braintrust.dev/app/safeflash/experiments/initial-tournament",
    resultCount: candidateResults.length,
    candidateResults,
  });
  return {
    purpose: "initial-selection" as const,
    session: currentSession,
    policy,
    candidate: initialCandidates[selectedIndex]!,
    commitSha: "f".repeat(40),
    commitTreeSha: daytonas[selectedIndex]!.data.validatedTreeSha!,
    daytona: daytonas[selectedIndex]!,
    braintrust,
    generations: initialCandidates.map((item, index) => generation(item, index + 1)),
    initialTournament: initialCandidates.map((item, index) => ({
      candidate: item,
      daytona: daytonas[index]!,
    })),
    publication: publicationEvidence({
      sessionId: currentSession.sessionId,
      candidatePatch: initialCandidates[selectedIndex]!,
      baseCommitSha: BASE_HEAD,
      targetBaseCommitSha: currentSession.repository.commitSha,
      treeSha: daytonas[selectedIndex]!.data.validatedTreeSha!,
      commitSha: "f".repeat(40),
    }),
  };
}

describe("live review revalidation receipt", () => {
  it("binds initial selection to all mapped Daytona sandboxes and the highest eligible Braintrust result", () => {
    const receipt = createLiveFullRevalidationReceipt(initialInputs());
    expect(receipt.validationPurpose).toBe("initial-selection");
    expect(receipt.candidateId).toBe(candidate.candidateId);

    expect(() =>
      createLiveFullRevalidationReceipt(initialInputs(1)),
    ).toThrow(/highest eligible candidate/u);

    const missing = initialInputs();
    missing.initialTournament = missing.initialTournament.slice(0, 2);
    expect(() => createLiveFullRevalidationReceipt(missing)).toThrow(
      /exact purpose-bound candidate evidence set/u,
    );

    const wrongPolicy = initialInputs();
    wrongPolicy.session = { ...wrongPolicy.session, policyId: "other-policy" };
    expect(() => createLiveFullRevalidationReceipt(wrongPolicy)).toThrow(
      /session-bound server policy/u,
    );

    const widenedPolicy = initialInputs();
    expect(() =>
      createLiveFullRevalidationReceipt({
        ...widenedPolicy,
        policy: { ...widenedPolicy.policy, maxChangedLines: 10_000 },
      }),
    ).toThrow(/session-bound server policy/u);
  });

  it("freezes the package-internal official transport authority", () => {
    expect(Object.isFrozen(officialTestTransport)).toBe(true);
    expect(
      Reflect.set(officialTestTransport, "transport", "local-test"),
    ).toBe(false);
    const envelope = daytonaEvidence();
    expect(Object.isFrozen(envelope.data)).toBe(true);
    expect(Object.isFrozen(envelope.data.commands)).toBe(true);
    expect(Reflect.set(envelope.data, "passed", false)).toBe(false);
    expect(() =>
      (envelope.data.commands as DaytonaValidationEvidence["commands"] &
        unknown[]).push(envelope.data.commands[0]!),
    ).toThrow(TypeError);
  });

  it("derives every pass field and evidence reference from exact live envelopes", () => {
    const receipt = createLiveFullRevalidationReceipt(inputs());
    expect(receipt).toMatchObject({
      sourceKind: "live-provider-evidence",
      validationPurpose: "review-repair",
      candidateId: candidate.candidateId,
      patchDigest: sha256(candidate.unifiedDiff),
      commitSha: REPAIRED_HEAD,
      validatedTreeSha: VALIDATED_TREE,
      sandboxId: "daytona-fresh-sandbox",
      daytonaRunId: "repair-run-2",
      braintrustProjectId: "project-live-1",
      braintrustExperimentId: "experiment-live-2",
      braintrustExperimentName: "review-revalidation-2",
      buildPassed: true,
      unitTestsPassed: true,
      safetyTestsPassed: true,
      integrityChecksPassed: true,
      braintrustScored: true,
      candidateEligible: true,
    });
    expect(receipt.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.attestationDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("requires finite Fireworks telemetry and binds it into the evidence digest", () => {
    for (const telemetry of [
      { latencyMs: Number.NaN },
      { totalTokens: -1 },
      { totalTokens: 1.5 },
    ]) {
      const invalid = inputs();
      const original = invalid.generations[0]!;
      invalid.generations = [
        {
          ...original,
          evidence: officialEnvelope("fireworks", {
            ...original.evidence.data,
            ...telemetry,
          }),
        },
      ];
      expect(() => createLiveFullRevalidationReceipt(invalid)).toThrow(
        /Fireworks generation is not official or bound/iu,
      );
    }

    const baseline = createLiveFullRevalidationReceipt(inputs());
    const changed = inputs();
    const original = changed.generations[0]!;
    changed.generations = [
      {
        ...original,
        evidence: officialEnvelope("fireworks", {
          ...original.evidence.data,
          latencyMs: original.evidence.data.latencyMs + 1,
          totalTokens: original.evidence.data.totalTokens + 1,
        }),
      },
    ];
    const changedReceipt = createLiveFullRevalidationReceipt(changed);
    expect(changedReceipt.evidenceDigest).not.toBe(baseline.evidenceDigest);
    expect(changedReceipt.attestationDigest).not.toBe(baseline.attestationDigest);
  });

  it("requires destroyed Daytona evidence and rejects retained or ambiguous states", () => {
    const destroyed = inputs();
    expect(createLiveFullRevalidationReceipt(destroyed).sandboxId).toBe(
      destroyed.daytona.data.sandboxId,
    );

    for (const disposition of [
      { retained: false, destroyed: false },
      { retained: true, destroyed: false },
      { retained: true, destroyed: true },
    ] as const) {
      const invalid = inputs();
      invalid.daytona = officialEnvelope("daytona", {
        ...invalid.daytona.data,
        ...disposition,
      });
      invalid.braintrust = braintrustEvidence(invalid.daytona.data);
      expect(() => createLiveFullRevalidationReceipt(invalid)).toThrow(
        /Live revalidation evidence/u,
      );
    }
  });

  it("rejects local provenance, command replacement, stale sandbox, and mismatched Braintrust metadata", () => {
    const local = inputs();
    local.daytona = localTestEnvelope("daytona", local.daytona.data);
    expect(() => createLiveFullRevalidationReceipt(local)).toThrow(
      ProviderResponseError,
    );

    const forged = inputs();
    forged.daytona = structuredClone(forged.daytona);
    expect(forged.daytona.provenance.kind).toBe("live");
    expect(() => createLiveFullRevalidationReceipt(forged)).toThrow(
      /Live revalidation evidence/u,
    );

    const modifiedCommand = inputs();
    const daytonaCopy = structuredClone(modifiedCommand.daytona.data);
    const safetyIndex = DEFAULT_DAYTONA_COMMAND_POLICY.findIndex(
      (definition) => definition.id === "safety-tests",
    );
    modifiedCommand.daytona = officialEnvelope("daytona", {
      ...daytonaCopy,
      commands: daytonaCopy.commands.map((command, index) =>
        index === safetyIndex
          ? { ...command, argv: ["/bin/sh", "-lc", "true"] }
          : command,
      ),
    });
    expect(() => createLiveFullRevalidationReceipt(modifiedCommand)).toThrow(
      /exact policy binding/u,
    );

    const reused = inputs();
    reused.session = {
      ...reused.session,
      revalidationSandboxIds: [reused.daytona.data.sandboxId],
    };
    expect(() => createLiveFullRevalidationReceipt(reused)).toThrow(/reused/u);

    const mismatched = inputs();
    const braintrustCopy = structuredClone(mismatched.braintrust.data);
    braintrustCopy.candidateResults[0]!.metadata.validatedTreeSha = "f".repeat(40);
    mismatched.braintrust = officialEnvelope("braintrust", braintrustCopy);
    expect(() => createLiveFullRevalidationReceipt(mismatched)).toThrow(
      /metadata/u,
    );
  });

  it("requires exact reserved attempt history and rejects any observed identifier reuse", () => {
    const missing = inputs();
    missing.session = { ...missing.session, sandboxAttemptHistory: [] };
    expect(() => createLiveFullRevalidationReceipt(missing)).toThrow(
      /reserved Daytona attempt history/iu,
    );

    const wrongPurpose = inputs();
    wrongPurpose.session = {
      ...wrongPurpose.session,
      sandboxAttemptHistory: wrongPurpose.session.sandboxAttemptHistory.map(
        (attempt) => ({ ...attempt, purpose: "initial-candidate" as const }),
      ),
    };
    expect(() => createLiveFullRevalidationReceipt(wrongPurpose)).toThrow(
      /exact purpose, candidate, sandbox, and run bindings/iu,
    );

    const rejectedReuse = inputs();
    rejectedReuse.session = {
      ...rejectedReuse.session,
      sandboxAttemptHistory: [
        ...rejectedReuse.session.sandboxAttemptHistory,
        {
          candidateId: candidate.candidateId,
          sandboxId: rejectedReuse.daytona.data.sandboxId,
          runId: "rejected-reused-run",
          purpose: "review-repair",
          capturedAt: at,
          disposition: "completed",
          retryable: false,
          reservationStatus: "rejected-reuse",
          duplicateSandbox: true,
          duplicateRun: false,
        },
      ],
    };
    expect(() => createLiveFullRevalidationReceipt(rejectedReuse)).toThrow(
      /reserved Daytona attempt history/iu,
    );

    const wrongRun = initialInputs();
    wrongRun.session = {
      ...wrongRun.session,
      sandboxAttemptHistory: wrongRun.session.sandboxAttemptHistory.map(
        (attempt, index) =>
          index === 0 ? { ...attempt, runId: "other-run" } : attempt,
      ),
    };
    expect(() => createLiveFullRevalidationReceipt(wrongRun)).toThrow(
      /exact purpose, candidate, sandbox, and run bindings/iu,
    );
  });

  it("recomputes hard-gate eligibility instead of trusting a boolean", () => {
    const unsafe = inputs();
    const braintrustCopy = structuredClone(unsafe.braintrust.data);
    const unsafeEvaluation = passingEvaluation({
      safetyTests: {
        passed: 0,
        total: 1,
        criticalFailures: ["sensor disconnect remained energized"],
      },
    });
    const unsafeScores = evaluateDeterministicScorers(unsafeEvaluation).scores;
    const unsafeDigest = computeLiveCandidateEvidenceDigest({
      policyVersion: unsafe.session.policyVersion,
      daytona: unsafe.daytona.data,
      scores: unsafeScores,
    });
    unsafe.braintrust = officialEnvelope("braintrust", {
      ...braintrustCopy,
      candidateResults: braintrustCopy.candidateResults.map((result) => ({
        ...result,
        evaluationEvidence: unsafeEvaluation,
        scores: unsafeScores,
        evidenceDigest: unsafeDigest,
      })),
    });
    expect(() => createLiveFullRevalidationReceipt(unsafe)).toThrow(
      /server-recomputed Daytona evidence/u,
    );
  });
});
