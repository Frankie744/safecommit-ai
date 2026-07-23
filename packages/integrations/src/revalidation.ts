import {
  computeCommandHash,
  computeEvidenceDigest,
  computeFullRevalidationAttestationDigest,
  evaluateEligibility,
  selectCandidate,
  sha256,
  type CandidatePatch,
  type FullRevalidationReceipt,
  type SafetyPolicy,
  type ScorerValues,
  type ValidationSession,
} from "@safeflash/domain";
import {
  evaluateDeterministicScorers,
  type CandidateEvaluationEvidence,
} from "@safeflash/evals";
import { validatePatchIntegrity } from "@safeflash/safety-policy";

import type {
  BraintrustExperimentEvidence,
} from "./braintrust";
import type {
  FireworksCandidateEvidence,
  FireworksCandidateRequest,
  FireworksSourceContext,
} from "./fireworks";
import { createFireworksSourceContext } from "./fireworks";
import type { PreparedCandidatePublication } from "./github-publication";
import {
  DAYTONA_REPOSITORY_PATH,
  DEFAULT_DAYTONA_COMMAND_POLICY,
  type DaytonaValidationEvidence,
} from "./daytona";
import {
  isOfficialLiveEnvelope,
  ProviderResponseError,
  type ProviderEnvelope,
} from "./provider";

const SCORE_NAMES = [
  "BuildSuccess",
  "UnitTestPassRate",
  "SafetyInvariant",
  "RegressionProtection",
  "PatchIntegrity",
  "PatchMinimality",
  "ExplanationGroundedness",
  "Reproducibility",
] as const;

const SCORE_KEYS: Readonly<Record<(typeof SCORE_NAMES)[number], keyof ScorerValues>> = {
  BuildSuccess: "buildSuccess",
  UnitTestPassRate: "unitTestPassRate",
  SafetyInvariant: "safetyInvariant",
  RegressionProtection: "regressionProtection",
  PatchIntegrity: "patchIntegrity",
  PatchMinimality: "patchMinimality",
  ExplanationGroundedness: "explanationGroundedness",
  Reproducibility: "reproducibility",
};

const HARD_GATE_NAMES = new Set([
  "BuildSuccess",
  "UnitTestPassRate",
  "SafetyInvariant",
  "PatchIntegrity",
]);

export interface LiveRevalidationReceiptInput {
  purpose: "initial-selection" | "review-repair";
  session: Pick<
    ValidationSession,
    | "sessionId"
    | "state"
    | "mode"
    | "policyVersion"
    | "policyId"
    | "policySnapshot"
    | "repository"
    | "pullRequestTarget"
    | "candidateIds"
    | "selectedCandidateId"
    | "currentPatchDigest"
    | "currentEvidenceDigest"
    | "pullRequest"
    | "sandboxIdsByCandidate"
    | "sandboxAttemptHistory"
    | "revalidationSandboxIds"
  >;
  policy: Pick<
    SafetyPolicy,
    | "id"
    | "policyVersion"
    | "allowedPatchPaths"
    | "maxChangedFiles"
    | "maxChangedLines"
  >;
  candidate: CandidatePatch;
  /** Full Git commit whose tree will be compared with validatedTreeSha by GitHub. */
  commitSha: string;
  /** Locally verified tree for commitSha; must equal Daytona's post-patch tree. */
  commitTreeSha: string;
  daytona: ProviderEnvelope<DaytonaValidationEvidence>;
  braintrust: ProviderEnvelope<BraintrustExperimentEvidence>;
  /** Required only for initial selection and must cover every session candidate. */
  initialTournament?: readonly {
    candidate: CandidatePatch;
    daytona: ProviderEnvelope<DaytonaValidationEvidence>;
  }[];
  generations: readonly {
    request: FireworksCandidateRequest;
    evidence: ProviderEnvelope<FireworksCandidateEvidence>;
    /** Official GitHub evidence for the exact immutable source sent to Fireworks. */
    sourceContext: ProviderEnvelope<FireworksSourceContext>;
  }[];
  /** Official, read-only GitHub publication plan for the selected validated tree. */
  publication: ProviderEnvelope<PreparedCandidatePublication>;
}

function allowedPathPrefixes(paths: readonly string[]): readonly string[] {
  return paths.map((path) => path.replace(/\*\*?$/u, "").replace(/\/+$/u, ""));
}

/**
 * The only scorer input builder used by live orchestration and receipt
 * verification. Provider callers cannot choose their own score values.
 */
export function buildLiveCandidateEvaluationEvidence(input: {
  candidate: CandidatePatch;
  daytona: DaytonaValidationEvidence;
  policy: LiveRevalidationReceiptInput["policy"];
}): CandidateEvaluationEvidence {
  const integrity = validatePatchIntegrity(input.candidate.unifiedDiff, {
    allowedPathPrefixes: allowedPathPrefixes(input.policy.allowedPatchPaths),
    maxChangedFiles: input.policy.maxChangedFiles,
    maxChangedLines: input.policy.maxChangedLines,
  });
  const commandExit = (id: (typeof DEFAULT_DAYTONA_COMMAND_POLICY)[number]["id"]): number | null =>
    input.daytona.commands.find(
      (command) => command.id === `${input.daytona.runId}:${id}`,
    )?.exitCode ?? null;
  const buildPassed = commandExit("build") === 0;
  const unitExit = commandExit("unit-tests");
  const safetyExit = commandExit("safety-tests");
  // The trusted unit CTest label is the repository's regression suite in P0.
  const regressionExit = unitExit;
  const unitPassed = unitExit === 0;
  const safetyPassed = safetyExit === 0;
  const regressionPassed = regressionExit === 0;
  const trustedIntegrityPassed =
    integrity.valid &&
    commandExit("patch-check") === 0 &&
    commandExit("patch-apply") === 0 &&
    commandExit("staged-diff-whitespace") === 0;
  const claimCount = Math.max(1, input.candidate.expectedSafetyEffect.length + 1);
  return {
    candidateId: input.candidate.candidateId,
    build: { exitCode: commandExit("build") },
    unitTests: { passed: unitPassed ? 1 : 0, total: unitExit === null ? 0 : 1 },
    safetyTests: {
      passed: safetyPassed ? 1 : 0,
      total: safetyExit === null ? 0 : 1,
      criticalFailures: safetyPassed ? [] : ["trusted safety test command failed"],
    },
    regressionTests: {
      passed: regressionPassed ? 1 : 0,
      total: regressionExit === null ? 0 : 1,
    },
    integrity: {
      passed: trustedIntegrityPassed,
      violations: integrity.violations.map((violation) => violation.code),
    },
    patch: {
      changedFiles: integrity.changedFiles.length,
      changedLines: integrity.addedLines + integrity.removedLines,
      maxChangedFiles: input.policy.maxChangedFiles,
      maxChangedLines: input.policy.maxChangedLines,
      binaryFiles: integrity.violations.some(
        (violation) => violation.code === "BINARY_PATCH",
      )
        ? 1
        : 0,
      dependenciesAdded: 0,
    },
    explanation: {
      supportedClaims: input.daytona.passed && buildPassed ? claimCount : 0,
      totalClaims: claimCount,
    },
    reproduction: {
      attempted: false,
      sameCommit: false,
      sameConfiguration: false,
      artifactHashesMatch: false,
    },
  };
}

function requireFullGitId(label: string, value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) {
    throw new ProviderResponseError(
      "daytona",
      `${label} must be a full immutable Git object ID`,
      false,
    );
  }
  return value;
}

function scorerValues(
  scores: BraintrustExperimentEvidence["candidateResults"][number]["scores"],
): ScorerValues {
  if (
    scores.length !== SCORE_NAMES.length ||
    new Set(scores.map((score) => score.name)).size !== SCORE_NAMES.length
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Revalidation requires each of the eight deterministic scorers exactly once",
      false,
    );
  }
  const values = {} as ScorerValues;
  for (const name of SCORE_NAMES) {
    const score = scores.find((item) => item.name === name);
    if (
      score === undefined ||
      !Number.isFinite(score.score) ||
      score.score < 0 ||
      score.score > 1 ||
      score.metadata.deterministic !== true ||
      score.metadata.hardGate !== HARD_GATE_NAMES.has(name)
    ) {
      throw new ProviderResponseError(
        "braintrust",
        `Invalid deterministic scorer evidence: ${name}`,
        false,
      );
    }
    values[SCORE_KEYS[name]] = score.score;
  }
  return values;
}

function canonicalDaytonaEvidence(evidence: DaytonaValidationEvidence) {
  return {
    runId: evidence.runId,
    sessionId: evidence.sessionId,
    candidateId: evidence.candidateId,
    sandboxId: evidence.sandboxId,
    baseCommitSha: evidence.commitSha,
    patchDigest: evidence.patchDigest,
    policyDigest: evidence.policyDigest,
    validatedTreeSha: evidence.validatedTreeSha,
    commands: evidence.commands.map((command) => ({
      id: command.id,
      commandHash: command.commandHash,
      artifactHash: command.artifactHash ?? null,
      stdoutHash: command.stdoutHash ?? null,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
    })),
  };
}

export function computeLiveCandidateEvidenceDigest(input: {
  policyVersion: string;
  daytona: DaytonaValidationEvidence;
  scores: BraintrustExperimentEvidence["candidateResults"][number]["scores"];
}): string {
  return computeEvidenceDigest({
    schemaVersion: 1,
    kind: "safeflash-live-candidate-evaluation",
    policyVersion: input.policyVersion,
    daytona: canonicalDaytonaEvidence(input.daytona),
    scores: input.scores,
  });
}

function assertDaytonaEvidence(
  input: LiveRevalidationReceiptInput,
  patchDigest: string,
  requirePassing: boolean,
): void {
  const { daytona, session, candidate } = input;
  const data = daytona.data;
  const expectedBase =
    input.purpose === "review-repair"
      ? session.pullRequest?.headSha
      : session.repository.commitSha;
  const usedSandboxes = new Set([
    ...Object.values(session.sandboxIdsByCandidate),
    ...(session.revalidationSandboxIds ?? []),
  ]);
  const sandboxPurposeValid =
    input.purpose === "initial-selection"
      ? session.sandboxIdsByCandidate[candidate.candidateId] === data.sandboxId &&
        !(session.revalidationSandboxIds ?? []).includes(data.sandboxId)
      : !usedSandboxes.has(data.sandboxId);
  const sandboxDispositionValid =
    data.retained === false && data.destroyed === true;
  if (
    daytona.provider !== "daytona" ||
    !isOfficialLiveEnvelope(daytona) ||
    data.sessionId !== session.sessionId ||
    data.candidateId !== candidate.candidateId ||
    expectedBase === undefined ||
    data.commitSha.toLowerCase() !== expectedBase.toLowerCase() ||
    data.patchDigest !== patchDigest ||
    data.policyDigest !==
      computeEvidenceDigest({
        policyVersion: input.policy.policyVersion,
        allowedPatchPaths: input.policy.allowedPatchPaths,
        maxChangedFiles: input.policy.maxChangedFiles,
        maxChangedLines: input.policy.maxChangedLines,
      }) ||
    !sandboxPurposeValid ||
    data.isolatedFilesystem !== true ||
    data.networkBlockedBeforePatch !== true ||
    !sandboxDispositionValid ||
    data.commands.length === 0 ||
    data.commands.length > DEFAULT_DAYTONA_COMMAND_POLICY.length
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Live revalidation evidence is stale, incomplete, reused, or not bound to the repaired candidate",
      false,
    );
  }
  let firstFailure = -1;
  for (const [index, command] of data.commands.entries()) {
    const definition = DEFAULT_DAYTONA_COMMAND_POLICY[index]!;
    const expectedArgv = ["/bin/sh", "-lc", definition.command];
    if (
      command.id !== `${data.runId}:${definition.id}` ||
      command.sessionId !== session.sessionId ||
      command.candidateId !== candidate.candidateId ||
      command.sandboxId !== data.sandboxId ||
      command.commitSha.toLowerCase() !== data.commitSha.toLowerCase() ||
      JSON.stringify(command.argv) !== JSON.stringify(expectedArgv) ||
      command.commandHash !==
        computeCommandHash(expectedArgv, DAYTONA_REPOSITORY_PATH) ||
      command.timedOut ||
      !/^[0-9a-f]{64}$/iu.test(command.stdoutHash ?? "") ||
      (definition.id === "artifact-manifest" &&
        !/^[0-9a-f]{64}$/iu.test(command.artifactHash ?? "")) ||
      (definition.id !== "artifact-manifest" &&
        command.artifactHash !== undefined)
    ) {
      throw new ProviderResponseError(
        "daytona",
        `Daytona command evidence failed exact policy binding: ${definition.id}`,
        false,
      );
    }
    if (command.exitCode !== 0 && firstFailure === -1) firstFailure = index;
    if (firstFailure !== -1 && index > firstFailure) {
      throw new ProviderResponseError(
        "daytona",
        "Daytona command evidence continued after the first failing command",
        false,
      );
    }
    if (
      definition.id === "validated-tree" &&
      command.exitCode === 0 &&
      command.stdoutSummary.trim() !== data.validatedTreeSha
    ) {
      throw new ProviderResponseError(
        "daytona",
        "Daytona validated-tree command does not match the reported tree SHA",
        false,
      );
    }
  }
  const validatedTreeCommand = data.commands.find(
    (command) => command.id === `${data.runId}:validated-tree`,
  );
  const treePresent =
    validatedTreeCommand?.exitCode === 0 &&
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(data.validatedTreeSha ?? "");
  const expectedPassed =
    data.commands.length === DEFAULT_DAYTONA_COMMAND_POLICY.length &&
    data.commands.every((command) => command.exitCode === 0 && !command.timedOut) &&
    treePresent;
  if (
    data.passed !== expectedPassed ||
    (treePresent && validatedTreeCommand!.stdoutSummary.trim() !== data.validatedTreeSha) ||
    (!treePresent && data.validatedTreeSha !== undefined) ||
    (requirePassing && !expectedPassed)
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Daytona passed/tree fields are inconsistent with the exact command prefix",
      false,
    );
  }
}

function assertBraintrustUrl(urlValue: string, experimentName: string): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust Experiment did not return a canonical evidence URL",
      false,
    );
  }
  if (
    url.protocol !== "https:" ||
    !["braintrust.dev", "www.braintrust.dev"].includes(
      url.hostname.toLowerCase(),
    ) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.includes(encodeURIComponent(experimentName))
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust Experiment URL is not bound to the returned Experiment ID",
      false,
    );
  }
}

export function createLiveFullRevalidationReceipt(
  input: LiveRevalidationReceiptInput,
): FullRevalidationReceipt {
  const { session, candidate, daytona, braintrust } = input;
  const patchDigest = sha256(candidate.unifiedDiff);
  if (
    input.policy.id !== session.policyId ||
    input.policy.policyVersion !== session.policyVersion ||
    session.policySnapshot === undefined ||
    computeEvidenceDigest(session.policySnapshot) !==
      computeEvidenceDigest({
        allowedPatchPaths: input.policy.allowedPatchPaths,
        maxChangedFiles: input.policy.maxChangedFiles,
        maxChangedLines: input.policy.maxChangedLines,
      }) ||
    input.policy.allowedPatchPaths.length === 0 ||
    !Number.isSafeInteger(input.policy.maxChangedFiles) ||
    input.policy.maxChangedFiles < 1 ||
    !Number.isSafeInteger(input.policy.maxChangedLines) ||
    input.policy.maxChangedLines < 1
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Live validation policy must come from the exact session-bound server policy",
      false,
    );
  }
  const initialSelectionContext =
    input.purpose === "initial-selection" &&
    session.state === "SELECTING" &&
    session.candidateIds.includes(candidate.candidateId) &&
    session.selectedCandidateId === undefined &&
    session.currentPatchDigest === undefined &&
    session.pullRequest === undefined &&
    input.commitSha.toLowerCase() !== session.repository.commitSha.toLowerCase();
  const reviewRepairContext =
    input.purpose === "review-repair" &&
    session.state === "REVALIDATING" &&
    session.selectedCandidateId === candidate.candidateId &&
    session.currentPatchDigest === patchDigest &&
    session.pullRequest !== undefined &&
    input.commitSha.toLowerCase() !== session.pullRequest.headSha.toLowerCase();
  if (
    session.mode !== "live" ||
    session.pullRequestTarget === undefined ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(input.commitSha) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(input.commitTreeSha) ||
    (!initialSelectionContext && !reviewRepairContext)
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Revalidation candidate, patch digest, or repaired commit does not match the current session",
      false,
    );
  }
  const roundValidations =
    input.purpose === "initial-selection"
      ? input.initialTournament
      : [{ candidate, daytona }];
  if (
    roundValidations === undefined ||
    roundValidations.length !==
      (input.purpose === "initial-selection" ? session.candidateIds.length : 1) ||
    (input.purpose === "initial-selection" && roundValidations.length !== 3) ||
    (input.purpose === "review-repair" && input.initialTournament !== undefined)
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Validation round must provide the exact purpose-bound candidate evidence set",
      false,
    );
  }
  const validationIds = roundValidations.map(
    (validation) => validation.candidate.candidateId,
  );
  if (
    new Set(validationIds).size !== validationIds.length ||
    [...validationIds]
      .sort()
      .some(
        (candidateId, index) =>
          candidateId !==
          [...(input.purpose === "initial-selection"
            ? session.candidateIds
            : [candidate.candidateId])].sort()[index],
      ) ||
    new Set(
      roundValidations.map((validation) => validation.daytona.data.sandboxId),
    ).size !== roundValidations.length
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Validation round candidates and Daytona sandboxes must exactly and uniquely match the session",
      false,
    );
  }
  const attemptHistory = session.sandboxAttemptHistory ?? [];
  const historySandboxIds = attemptHistory.map((attempt) => attempt.sandboxId);
  const historyRunIds = attemptHistory.map((attempt) => attempt.runId);
  const historyIsValid =
    attemptHistory.length > 0 &&
    attemptHistory.every(
      (attempt) =>
        attempt.reservationStatus === "reserved" &&
        !attempt.duplicateSandbox &&
        !attempt.duplicateRun,
    ) &&
    new Set(historySandboxIds).size === historySandboxIds.length &&
    new Set(historyRunIds).size === historyRunIds.length;
  const expectedPurposes =
    input.purpose === "initial-selection"
      ? new Set<string>(["initial-candidate", "profile-replacement"])
      : new Set<string>(["review-repair"]);
  const everyRoundAttemptWasReserved = roundValidations.every(
    (validation) => {
      const evidence = validation.daytona.data;
      return attemptHistory.some(
        (attempt) =>
          attempt.reservationStatus === "reserved" &&
          attempt.disposition === "completed" &&
          expectedPurposes.has(attempt.purpose) &&
          attempt.candidateId === validation.candidate.candidateId &&
          attempt.sandboxId === evidence.sandboxId &&
          attempt.runId === evidence.runId,
      );
    },
  );
  if (!historyIsValid || !everyRoundAttemptWasReserved) {
    throw new ProviderResponseError(
      "daytona",
      "Validation receipt requires append-only reserved Daytona attempt history with exact purpose, candidate, sandbox, and run bindings",
      false,
    );
  }
  const selectedValidation = roundValidations.find(
    (validation) => validation.candidate.candidateId === candidate.candidateId,
  );
  if (
    selectedValidation === undefined ||
    selectedValidation.daytona !== daytona ||
    sha256(selectedValidation.candidate.unifiedDiff) !== patchDigest
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Selected candidate must reuse its exact official Daytona round envelope",
      false,
    );
  }
  if (
    input.generations.length !== roundValidations.length ||
    new Set(
      input.generations.map((generation) => generation.request.candidateId),
    ).size !== input.generations.length
  ) {
    throw new ProviderResponseError(
      "fireworks",
      "Validation receipt requires one unique official Fireworks generation per candidate",
      false,
    );
  }
  const sharedGenerationContexts = new Set(
    input.generations.map(({ request }) => {
      const {
        candidateId: _candidateId,
        strategy: _strategy,
        evaluationProfile: _evaluationProfile,
        seed: _seed,
        ...shared
      } = request;
      return computeEvidenceDigest(shared);
    }),
  );
  if (
    (input.purpose === "initial-selection" &&
      (new Set(input.generations.map(({ request }) => request.strategy)).size !== 3 ||
        input.generations.filter(
          ({ request }) => request.evaluationProfile === "safety-contender",
        ).length !== 2 ||
        input.generations.filter(
          ({ request }) => request.evaluationProfile === "safety-negative-control",
        ).length !== 1 ||
        new Set(input.generations.map(({ request }) => request.seed)).size !== 3 ||
        new Set(
          roundValidations.map(({ candidate: item }) => sha256(item.unifiedDiff)),
        ).size !== 3 ||
        sharedGenerationContexts.size !== 1)) ||
    (input.purpose === "review-repair" &&
      (sharedGenerationContexts.size !== 1 ||
        input.generations[0]?.request.evaluationProfile !== "safety-contender"))
  ) {
    throw new ProviderResponseError(
      "fireworks",
      "Live tournament generations require two genuine safety contenders, one server-owned negative control, and unique strategies, seeds, and patches over one exact shared context",
      false,
    );
  }
  for (const validation of roundValidations) {
    const generation = input.generations.find(
      (item) => item.request.candidateId === validation.candidate.candidateId,
    );
    if (
      generation === undefined ||
      generation.evidence.provider !== "fireworks" ||
      !isOfficialLiveEnvelope(generation.evidence) ||
      generation.sourceContext.provider !== "github" ||
      !isOfficialLiveEnvelope(generation.sourceContext) ||
      generation.request.sessionId !== session.sessionId ||
      generation.request.strategy !== validation.candidate.strategy ||
      generation.request.repository.repoUrl !== session.repository.repoUrl ||
      generation.request.repository.commitSha.toLowerCase() !==
        validation.daytona.data.commitSha.toLowerCase() ||
      generation.sourceContext.data.commitSha.toLowerCase() !==
        validation.daytona.data.commitSha.toLowerCase() ||
      generation.request.sourceContext.commitSha.toLowerCase() !==
        validation.daytona.data.commitSha.toLowerCase() ||
      computeEvidenceDigest(generation.request.sourceContext) !==
        computeEvidenceDigest(generation.sourceContext.data) ||
      computeEvidenceDigest(
        createFireworksSourceContext({
          commitSha: generation.sourceContext.data.commitSha,
          files: generation.sourceContext.data.files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        }),
      ) !== computeEvidenceDigest(generation.sourceContext.data) ||
      generation.request.safetyPolicy.policyVersion !== session.policyVersion ||
      computeEvidenceDigest({
        allowedPatchPaths:
          generation.request.safetyPolicy.allowedPatchPaths,
        maxChangedFiles: generation.request.safetyPolicy.maxChangedFiles,
        maxChangedLines: generation.request.safetyPolicy.maxChangedLines,
      }) !==
        computeEvidenceDigest({
          allowedPatchPaths: input.policy.allowedPatchPaths,
          maxChangedFiles: input.policy.maxChangedFiles,
          maxChangedLines: input.policy.maxChangedLines,
        }) ||
      generation.evidence.data.sourceContextDigest !==
        generation.request.sourceContext.digest ||
      generation.evidence.data.requestDigest !==
        computeEvidenceDigest({ schemaVersion: 1, request: generation.request }) ||
      generation.evidence.data.model.trim() === "" ||
      !Number.isFinite(generation.evidence.data.latencyMs) ||
      generation.evidence.data.latencyMs < 0 ||
      !Number.isSafeInteger(generation.evidence.data.totalTokens) ||
      generation.evidence.data.totalTokens < 0 ||
      generation.evidence.data.finishReason !== "stop" ||
      generation.evidence.data.attemptCount < 1 ||
      generation.evidence.data.candidate.candidateId !==
        validation.candidate.candidateId ||
      computeEvidenceDigest(generation.evidence.data.candidate) !==
        computeEvidenceDigest(validation.candidate)
    ) {
      throw new ProviderResponseError(
        "fireworks",
        "Fireworks generation is not official or bound to the exact session, source, policy, and candidate",
        false,
      );
    }
  }
  for (const validation of roundValidations) {
    assertDaytonaEvidence(
      { ...input, candidate: validation.candidate, daytona: validation.daytona },
      sha256(validation.candidate.unifiedDiff),
      validation.candidate.candidateId === candidate.candidateId,
    );
  }
  const daytonaData = daytona.data;
  const validatedTreeSha = requireFullGitId(
    "validatedTreeSha",
    daytonaData.validatedTreeSha,
  );
  if (validatedTreeSha.toLowerCase() !== input.commitTreeSha.toLowerCase()) {
    throw new ProviderResponseError(
      "daytona",
      "Prepared candidate commit tree does not match the Daytona-validated post-patch tree",
      false,
    );
  }
  const publication = input.publication;
  if (
    publication.provider !== "github" ||
    !isOfficialLiveEnvelope(publication) ||
    publication.data.schemaVersion !== 1 ||
    publication.data.sessionId !== session.sessionId ||
    publication.data.candidateId !== candidate.candidateId ||
    publication.data.owner !== session.pullRequestTarget.owner ||
    publication.data.repository !== session.pullRequestTarget.repository ||
    publication.data.baseBranch !== session.pullRequestTarget.baseBranch ||
    publication.data.baseCommitSha.toLowerCase() !==
      daytonaData.commitSha.toLowerCase() ||
    publication.data.targetBaseCommitSha.toLowerCase() !==
      session.repository.commitSha.toLowerCase() ||
    publication.data.patchDigest !== patchDigest ||
    publication.data.unifiedDiff !== candidate.unifiedDiff ||
    publication.data.treeSha.toLowerCase() !== validatedTreeSha.toLowerCase() ||
    publication.data.commitSha.toLowerCase() !== input.commitSha.toLowerCase() ||
    !/^[0-9a-f]{64}$/iu.test(publication.data.publicationDigest)
  ) {
    throw new ProviderResponseError(
      "github",
      "Prepared GitHub publication is not official or bound to the selected Daytona tree and session target",
      false,
    );
  }

  const experiment = braintrust.data;
  const expectedExperimentCandidates =
    input.purpose === "initial-selection" ? session.candidateIds : [candidate.candidateId];
  const experimentCandidateIds = experiment.candidateResults.map(
    (result) => result.candidateId,
  );
  if (
    braintrust.provider !== "braintrust" ||
    !isOfficialLiveEnvelope(braintrust) ||
    experiment.projectId.trim() === "" ||
    experiment.experimentId.trim() === "" ||
    experiment.resultCount !== expectedExperimentCandidates.length ||
    experiment.candidateResults.length !== expectedExperimentCandidates.length ||
    new Set(experimentCandidateIds).size !== experimentCandidateIds.length ||
    [...expectedExperimentCandidates]
      .sort()
      .some((candidateId, index) =>
        candidateId !== [...experimentCandidateIds].sort()[index],
      )
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Live Braintrust Experiment results must exactly match the validation round candidates",
      false,
    );
  }
  assertBraintrustUrl(experiment.experimentUrl, experiment.experimentName);
  const candidateResult = experiment.candidateResults.find(
    (result) => result.candidateId === candidate.candidateId,
  );
  if (candidateResult === undefined) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust Experiment omitted the selected candidate result",
      false,
    );
  }
  const normalizedResults = experiment.candidateResults.map((result) => {
    const validation = roundValidations.find(
      (item) => item.candidate.candidateId === result.candidateId,
    );
    if (validation === undefined) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust returned a candidate without exact Daytona evidence",
        false,
      );
    }
    const expectedEvaluationEvidence = buildLiveCandidateEvaluationEvidence({
      candidate: validation.candidate,
      daytona: validation.daytona.data,
      policy: input.policy,
    });
    const recomputedScores = evaluateDeterministicScorers(
      result.evaluationEvidence,
    ).scores;
    const expectedEvidenceDigest = computeLiveCandidateEvidenceDigest({
      policyVersion: session.policyVersion,
      daytona: validation.daytona.data,
      scores: result.scores,
    });
    const metadata = result.metadata;
    if (
      result.evaluationEvidence.candidateId !== result.candidateId ||
      computeEvidenceDigest(result.evaluationEvidence) !==
        computeEvidenceDigest(expectedEvaluationEvidence) ||
      result.evidenceDigest !== expectedEvidenceDigest ||
      metadata.sessionId !== session.sessionId ||
      metadata.patchDigest !== sha256(validation.candidate.unifiedDiff) ||
      metadata.sandboxId !== validation.daytona.data.sandboxId ||
      metadata.validatedTreeSha !==
        (validation.daytona.data.validatedTreeSha ?? null) ||
      metadata.policyVersion !== session.policyVersion ||
      computeEvidenceDigest(recomputedScores) !==
        computeEvidenceDigest(result.scores)
    ) {
      throw new ProviderResponseError(
        "braintrust",
        "Braintrust scorer row or metadata does not match server-recomputed Daytona evidence",
        false,
      );
    }
    return {
      candidateId: result.candidateId,
      values: scorerValues(result.scores),
      evidenceDigest: result.evidenceDigest,
    };
  });
  const decision = selectCandidate(normalizedResults, {
    id: `${session.sessionId}-${input.purpose}-selection`,
    sessionId: session.sessionId,
    source: "braintrust",
    sourceVersion: experiment.experimentId,
    at: braintrust.provenance.capturedAt,
    selectionPolicyVersion: session.policyVersion,
  });
  if (input.purpose === "initial-selection") {
    const contenderIds = input.generations
      .filter(({ request }) => request.evaluationProfile === "safety-contender")
      .map(({ request }) => request.candidateId);
    const contenderRankings = decision.rankings.filter((ranking) =>
      contenderIds.includes(ranking.candidateId),
    );
    const safetyControlId = input.generations.find(
      ({ request }) => request.evaluationProfile === "safety-negative-control",
    )?.request.candidateId;
    const safetyControl = decision.rankings.find(
      (ranking) => ranking.candidateId === safetyControlId,
    );
    if (
      contenderRankings.length !== 2 ||
      contenderRankings.some((ranking) => !ranking.eligible) ||
      !contenderIds.includes(decision.winnerCandidateId ?? "") ||
      safetyControl?.eligible !== false ||
      !safetyControl.hardGateFailures.some((failure) =>
        failure.startsWith("SafetyInvariant"),
      )
    ) {
      throw new ProviderResponseError(
        "braintrust",
        "Initial live tournament must compare two eligible safety contenders and independently reject the server-owned negative control at the safety hard gate",
        false,
      );
    }
  }
  if (
    input.purpose === "initial-selection" &&
    (!decision.rankings.some((ranking) => ranking.eligible) ||
      !decision.rankings.some((ranking) => !ranking.eligible))
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Initial live tournament must contain both eligible and independently rejected candidates",
      false,
    );
  }
  if (
    input.purpose === "initial-selection" &&
    decision.winnerCandidateId !== candidate.candidateId
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Initial selection is not the highest eligible candidate in the live Braintrust Experiment",
      false,
    );
  }
  const metadata = candidateResult.metadata;
  const recomputedScores = evaluateDeterministicScorers(
    candidateResult.evaluationEvidence,
  ).scores;
  if (
    candidateResult.candidateId !== candidate.candidateId ||
    candidateResult.evaluationEvidence.candidateId !== candidate.candidateId ||
    computeEvidenceDigest(candidateResult.scores) !==
      computeEvidenceDigest(recomputedScores) ||
    metadata.sessionId !== session.sessionId ||
    metadata.patchDigest !== patchDigest ||
    metadata.sandboxId !== daytonaData.sandboxId ||
    metadata.validatedTreeSha !== validatedTreeSha ||
    metadata.policyVersion !== session.policyVersion
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust result metadata is not bound to the exact Daytona candidate evidence",
      false,
    );
  }
  const values = scorerValues(recomputedScores);
  const hardGateFailures = evaluateEligibility(values);
  const caseEvidenceDigest = computeLiveCandidateEvidenceDigest({
    policyVersion: session.policyVersion,
    daytona: daytonaData,
    scores: recomputedScores,
  });
  if (
    candidateResult.evidenceDigest !== caseEvidenceDigest ||
    hardGateFailures.length > 0
  ) {
    throw new ProviderResponseError(
      "braintrust",
      "Braintrust result digest or non-negotiable eligibility gate failed",
      false,
    );
  }

  const daytonaEvidenceRef = `daytona://sandbox/${encodeURIComponent(
    daytonaData.sandboxId,
  )}/runs/${encodeURIComponent(daytonaData.runId)}`;
  const evidenceDigest = computeEvidenceDigest({
    schemaVersion: 1,
    kind: "safeflash-live-full-revalidation",
    validationPurpose: input.purpose,
    policyVersion: session.policyVersion,
    policy: input.policy,
    pullRequestTarget: session.pullRequestTarget,
    candidateId: candidate.candidateId,
    patchDigest,
    commitSha: input.commitSha,
    validatedTreeSha,
    daytona: canonicalDaytonaEvidence(daytonaData),
    braintrust: {
      projectId: experiment.projectId,
      experimentId: experiment.experimentId,
      experimentUrl: experiment.experimentUrl,
      caseEvidenceDigest,
      values,
    },
    fireworks: input.generations.map(({ request, evidence }) => ({
      candidateId: request.candidateId,
      requestDigest: evidence.data.requestDigest,
      sourceContextDigest: evidence.data.sourceContextDigest,
      requestId: evidence.data.requestId ?? null,
      model: evidence.data.model,
      latencyMs: evidence.data.latencyMs,
      totalTokens: evidence.data.totalTokens,
      attemptCount: evidence.data.attemptCount,
      githubSourceDigest: input.generations.find(
        (generation) => generation.request.candidateId === request.candidateId,
      )!.sourceContext.data.digest,
    })),
    githubPublication: {
      publicationDigest: publication.data.publicationDigest,
      capturedAt: publication.provenance.capturedAt,
    },
  });
  const evidence = {
    sourceKind: "live-provider-evidence" as const,
    mode: "live" as const,
    validationPurpose: input.purpose,
    sessionId: session.sessionId,
    policyVersion: session.policyVersion,
    candidateId: candidate.candidateId,
    patchDigest,
    commitSha: input.commitSha,
    validatedTreeSha,
    pullRequestTarget: { ...session.pullRequestTarget },
    evidenceDigest,
    executionProvider: "daytona" as const,
    evaluationProvider: "braintrust" as const,
    sandboxId: daytonaData.sandboxId,
    daytonaRunId: daytonaData.runId,
    daytonaEvidenceRef,
    braintrustProjectId: experiment.projectId,
    braintrustExperimentId: experiment.experimentId,
    braintrustExperimentName: experiment.experimentName,
    braintrustExperimentRef: experiment.experimentUrl,
    buildPassed: true,
    unitTestsPassed: true,
    safetyTestsPassed: true,
    integrityChecksPassed: true,
    braintrustScored: true,
    candidateEligible: true,
  };
  return {
    ...evidence,
    attestationDigest: computeFullRevalidationAttestationDigest(evidence),
  };
}
