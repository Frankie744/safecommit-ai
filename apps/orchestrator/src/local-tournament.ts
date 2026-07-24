import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  CandidatePatchSchema,
  computeCommandHash,
  computeEvidenceDigest,
  selectCandidate,
  sha256,
  type CandidateDecision,
  type CandidatePatch,
  type CommandEvidence,
  type JsonObject,
  type OperatingMode,
  type ScorerValues,
} from "@safeflash/domain";
import {
  validatePatchIntegrity,
  type PatchIntegrityResult,
} from "../../../packages/safety-policy/src/index";

import {
  EMPTY_TOURNAMENT_REPLAY,
  JsonlEventStore,
  LOCAL_TEST_PROVENANCE,
  reduceTournamentEvent,
  replayEvents,
  type LocalTestProvenance,
  type TournamentReplayState,
} from "./event-store";
import {
  DEFAULT_DEMO_SCENARIO_ID,
  type DemoScenarioId,
} from "./demo-scenarios";
import {
  executableProfile,
  type ExecutableIncidentProfile,
  type ExecutableProfileId,
} from "./executable-profiles";

const LOCAL_SOURCE_VERSION = "local-tournament-v1";
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export class LiveTournamentProviderRequiredError extends Error {
  constructor(mode: OperatingMode) {
    super(
      `SafeFlash ${mode} mode has no configured tournament provider; refusing to fall back to local-test/mock execution`,
    );
    this.name = "LiveTournamentProviderRequiredError";
  }
}

export interface Toolchain {
  cmakePath: string;
  ctestPath: string;
  generator: string;
  visualStudioRoot?: string;
  multiConfig: boolean;
}

export interface LocalCommandResult extends CommandEvidence {
  commandId: string;
}

export interface TestSuiteEvidence {
  executed: boolean;
  passed: number;
  total: number;
  exitCode: number | null;
}

export interface LocalCandidateResult {
  candidate: CandidatePatch;
  provenance: LocalTestProvenance;
  sandboxId: string;
  sandboxDirectory: string;
  fixtureHashBeforePatch: string;
  fixtureHashAfterPatch: string;
  integrity: PatchIntegrityResult;
  commands: readonly LocalCommandResult[];
  buildPassed: boolean;
  unitTests: TestSuiteEvidence;
  safetyTests: TestSuiteEvidence;
  scores: ScorerValues;
  eligible: boolean;
  weightedScore: number;
  hardGateFailures: readonly string[];
  evidenceDigest: string;
}

export interface LocalTournamentResult {
  sessionId: string;
  profile: ExecutableIncidentProfile;
  provenance: LocalTestProvenance;
  eventLogPath: string;
  toolchain: Toolchain;
  candidates: readonly LocalCandidateResult[];
  decision: CandidateDecision;
  replayedState: TournamentReplayState;
}

export interface LocalTournamentOptions {
  sessionId: string;
  profileId?: ExecutableProfileId;
  workspaceRoot?: string;
  commandTimeoutMs?: number;
  now?: () => Date;
  scenarioId?: DemoScenarioId;
}

export interface LiveTournamentProvider {
  run(options: LocalTournamentOptions): Promise<ExternalTournamentResult>;
}

export interface ExternalTournamentResult {
  provenance:
    | { mode: "live"; kind: "live"; provider: string }
    | {
        mode: "cached";
        kind: "recorded-live";
        provider: string;
        evidenceRef: string;
      };
  [key: string]: unknown;
}

export interface SafetyTournamentOptions extends LocalTournamentOptions {
  mode: OperatingMode;
  provider?: LiveTournamentProvider;
}

interface SpawnResult {
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const CHILD_ENVIRONMENT_ALLOWLIST = [
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
] as const;

/**
 * Local execution is only for the three repository-owned demo patches. Even
 * those binaries receive a minimal environment so provider credentials can
 * never be read with getenv().
 */
export function buildLocalChildEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set<string>(CHILD_ENVIRONMENT_ALLOWLIST);
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) =>
      value !== undefined && allowed.has(name.toUpperCase()),
    ),
  ) as NodeJS.ProcessEnv;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value)) {
    throw new Error(`Unsafe local sandbox path segment: ${value}`);
  }
  return value;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function executableOnPath(name: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? "";
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function runSpawn(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  const startedAt = performance.now();
  return new Promise<SpawnResult>((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: buildLocalChildEnvironment(),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            env: buildLocalChildEnvironment(),
            shell: false,
            stdio: "ignore",
            windowsHide: true,
          },
        );
        killer.unref();
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function redactAndSummarize(text: string, maxLength = 8_000): string {
  let safe = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      value.length >= 4 &&
      /(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL)/iu.test(name)
    ) {
      safe = safe.replaceAll(value, "[REDACTED]");
    }
  }
  if (process.env.USERPROFILE) {
    safe = safe.replaceAll(process.env.USERPROFILE, "%USERPROFILE%");
  }
  safe = safe
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|authorization)\b(\s*[:=]\s*)([^\s;]+)/gimu,
      "$1$2[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
  if (safe.length <= maxLength) return safe;
  return `${safe.slice(0, maxLength)}\n...[truncated ${safe.length - maxLength} characters]`;
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  if (await fileExists(directory)) await visit(directory);
  return output.sort();
}

async function hashArtifacts(buildDirectory: string): Promise<string> {
  const files = (await listFiles(buildDirectory)).filter((path) =>
    /\.(?:exe|lib|a|dll|so|dylib)$/iu.test(path),
  );
  const manifest = await Promise.all(
    files.map(async (path) => ({
      path: relative(buildDirectory, path).replaceAll("\\", "/"),
      hash: await hashFile(path),
    })),
  );
  return computeEvidenceDigest(manifest);
}

async function determineGitRevision(workspaceRoot: string): Promise<string> {
  const result = await runSpawn("git", ["rev-parse", "HEAD"], workspaceRoot, 10_000);
  const head = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/iu.test(head)) {
    return "LOCAL_UNCOMMITTED_TREE";
  }
  const status = await runSpawn(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      "fixtures/battery-controller",
      "fixtures/motor-controller",
      "demo/candidate-patches",
      "apps/orchestrator",
      "packages/domain",
      "packages/safety-policy",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ],
    workspaceRoot,
    10_000,
  );
  if (status.exitCode !== 0) return "LOCAL_UNCOMMITTED_TREE";
  return status.stdout.trim() === "" ? head : `${head}-DIRTY`;
}

export async function discoverLocalToolchain(): Promise<Toolchain> {
  const configuredCmake = process.env.SAFEFLASH_CMAKE_PATH?.trim();
  const configuredVsRoot = process.env.SAFEFLASH_VISUAL_STUDIO_ROOT?.trim();
  const candidates = [
    configuredCmake,
    configuredVsRoot
      ? join(
          configuredVsRoot,
          "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe",
        )
      : undefined,
    process.platform === "win32"
      ? "D:/visual_studio/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
      : undefined,
    await executableOnPath("cmake"),
  ].filter((value): value is string => Boolean(value));
  let resolvedCmake: string | undefined;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      resolvedCmake = resolve(candidate);
      break;
    }
  }
  if (resolvedCmake === undefined) {
    throw new Error("CMake is unavailable for local-test tournament execution");
  }

  const ctestPath = join(dirname(resolvedCmake), process.platform === "win32" ? "ctest.exe" : "ctest");
  if (!(await fileExists(ctestPath))) {
    throw new Error(`CTest was not found next to CMake: ${ctestPath}`);
  }
  const help = await runSpawn(resolvedCmake, ["--help"], process.cwd(), 10_000);
  if (help.exitCode !== 0) throw new Error("Unable to query CMake generators");

  let generator: string;
  let visualStudioRoot = configuredVsRoot;
  const defaultVisualStudio = /^\*\s*(Visual Studio[^=\r\n]+?)\s*=/mu.exec(help.stdout);
  if (defaultVisualStudio) {
    generator = defaultVisualStudio[1]!.trim();
    if (!visualStudioRoot) {
      const normalized = resolvedCmake.replaceAll("\\", "/");
      const marker = "/Common7/IDE/";
      const markerIndex = normalized.toLowerCase().indexOf(marker.toLowerCase());
      if (markerIndex > 0) visualStudioRoot = normalized.slice(0, markerIndex);
    }
  } else if (/^\s*Ninja\s*=/mu.test(help.stdout)) {
    generator = "Ninja";
  } else {
    throw new Error("No supported Visual Studio or Ninja CMake generator was found");
  }

  return {
    cmakePath: resolvedCmake,
    ctestPath,
    generator,
    visualStudioRoot,
    multiConfig: generator.startsWith("Visual Studio"),
  };
}

function deterministicSuiteEvidence(
  executed: boolean,
  exitCode: number | null,
  timedOut: boolean,
  expectedTotal: number,
): TestSuiteEvidence {
  if (!executed) return { executed: false, passed: 0, total: 0, exitCode: null };
  const passed = exitCode === 0 && !timedOut ? expectedTotal : 0;
  return { executed: true, passed, total: expectedTotal, exitCode };
}

function scoreValues(
  buildPassed: boolean,
  unitTests: TestSuiteEvidence,
  safetyTests: TestSuiteEvidence,
  integrity: PatchIntegrityResult,
): ScorerValues {
  const unitRate =
    unitTests.exitCode === 0 && unitTests.total > 0
      ? unitTests.passed / unitTests.total
      : 0;
  const safetyRate =
    safetyTests.exitCode === 0 && safetyTests.total > 0
      ? safetyTests.passed / safetyTests.total
      : 0;
  const changedLines = integrity.addedLines + integrity.removedLines;
  return {
    buildSuccess: buildPassed ? 1 : 0,
    unitTestPassRate: Number(unitRate.toFixed(6)),
    safetyInvariant:
      safetyTests.executed && safetyTests.exitCode === 0 && safetyRate === 1 ? 1 : 0,
    regressionProtection: Number(unitRate.toFixed(6)),
    patchIntegrity: integrity.valid ? 1 : 0,
    patchMinimality: Number(Math.max(0, 1 - changedLines / 400).toFixed(6)),
    explanationGroundedness: 1,
    reproducibility: 0,
  };
}

async function executeCommandEvidence(input: {
  commandId: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  sessionId: string;
  candidateId: string;
  sandboxId: string;
  commitSha: string;
  buildDirectory: string;
  now: () => Date;
}): Promise<LocalCommandResult> {
  const startedAt = input.now();
  const result = await runSpawn(
    input.executable,
    input.args,
    input.cwd,
    input.timeoutMs,
  );
  const finishedAt = input.now();
  const artifactHash = await hashArtifacts(input.buildDirectory);
  return {
    id: `${input.sandboxId}:${input.commandId}`,
    sessionId: input.sessionId,
    createdAt: startedAt.toISOString(),
    updatedAt: finishedAt.toISOString(),
    source: "local-test",
    sourceVersion: LOCAL_SOURCE_VERSION,
    candidateId: input.candidateId,
    sandboxId: input.sandboxId,
    commitSha: input.commitSha,
    argv: [input.executable, ...input.args],
    commandHash: computeCommandHash(
      [input.executable, ...input.args],
      input.cwd,
    ),
    artifactHash,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutSummary: redactAndSummarize(result.stdout),
    stderrSummary: redactAndSummarize(result.stderr),
    stdoutHash: sha256(result.stdout),
    stderrHash: sha256(result.stderr),
    timedOut: result.timedOut,
    commandId: input.commandId,
  };
}

function configureArguments(toolchain: Toolchain, fixture: string, build: string): string[] {
  const args = ["-S", fixture, "-B", build, "-G", toolchain.generator];
  if (toolchain.multiConfig) {
    args.push("-A", "x64");
    if (toolchain.visualStudioRoot) {
      args.push(`-DCMAKE_GENERATOR_INSTANCE=${toolchain.visualStudioRoot}`);
    }
  } else {
    args.push("-DCMAKE_BUILD_TYPE=Debug");
  }
  return args;
}

function buildArguments(toolchain: Toolchain, build: string): string[] {
  const args = ["--build", build];
  if (toolchain.multiConfig) args.push("--config", "Debug");
  args.push("--parallel", "2");
  return args;
}

function ctestArguments(toolchain: Toolchain, build: string, label: string): string[] {
  const args = ["--test-dir", build];
  if (toolchain.multiConfig) args.push("-C", "Debug");
  args.push("-V", "-L", label, "--output-on-failure", "--no-tests=error");
  return args;
}

async function copyFixture(
  workspaceRoot: string,
  repositoryRoot: string,
  profile: ExecutableIncidentProfile,
): Promise<void> {
  const source = join(workspaceRoot, profile.fixtureDirectory);
  const destination = join(repositoryRoot, profile.fixtureDirectory);
  if (!(await fileExists(source))) throw new Error(`Fixture does not exist: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
}

async function validateOneCandidate(input: {
  candidate: CandidatePatch;
  sessionId: string;
  workspaceRoot: string;
  sandboxRoot: string;
  toolchain: Toolchain;
  commandTimeoutMs: number;
  commitSha: string;
  eventStore: JsonlEventStore;
  now: () => Date;
  profile: ExecutableIncidentProfile;
}): Promise<LocalCandidateResult> {
  const candidate = CandidatePatchSchema.parse(input.candidate);
  const integrity = validatePatchIntegrity(candidate.unifiedDiff, {
    allowedPathPrefixes: [`${input.profile.fixtureDirectory}/src/`],
    maxChangedFiles: 1,
    maxChangedLines: 120,
  });
  if (
    !integrity.valid ||
    integrity.changedFiles.length !== 1 ||
    integrity.changedFiles[0] !== input.profile.sourceFile
  ) {
    throw new Error(
      `${candidate.candidateId} failed local patch integrity: ${integrity.violations.map((item) => item.code).join(", ")}`,
    );
  }

  const sandboxId = `localtest-${safeSegment(candidate.candidateId)}-${randomUUID().slice(0, 8)}`;
  const sandboxDirectory = join(input.sandboxRoot, sandboxId);
  const repositoryRoot = join(sandboxDirectory, "repository");
  const buildDirectory = join(sandboxDirectory, "build");
  const patchPath = join(sandboxDirectory, "candidate.patch");
  await mkdir(sandboxDirectory, { recursive: false });
  await copyFixture(input.workspaceRoot, repositoryRoot, input.profile);
  await writeFile(patchPath, candidate.unifiedDiff, "utf8");

  const sourcePath = join(repositoryRoot, input.profile.sourceFile);
  const fixtureHashBeforePatch = await hashFile(sourcePath);
  const commands: LocalCommandResult[] = [];
  const runCommand = async (
    commandId: string,
    executable: string,
    args: readonly string[],
    cwd = repositoryRoot,
  ): Promise<LocalCommandResult> => {
    const evidence = await executeCommandEvidence({
      commandId,
      executable,
      args,
      cwd,
      timeoutMs: input.commandTimeoutMs,
      sessionId: input.sessionId,
      candidateId: candidate.candidateId,
      sandboxId,
      commitSha: input.commitSha,
      buildDirectory,
      now: input.now,
    });
    commands.push(evidence);
    await input.eventStore.append({
      sessionId: input.sessionId,
      eventType: "COMMAND_COMPLETED",
      occurredAt: input.now().toISOString(),
      payload: {
        candidateId: candidate.candidateId,
        sandboxId,
        commandId,
        argv: [...evidence.argv],
        exitCode: evidence.exitCode,
        durationMs: evidence.durationMs,
        timedOut: evidence.timedOut,
        commandHash: evidence.commandHash,
        artifactHash: evidence.artifactHash ?? null,
        stdoutSummary: evidence.stdoutSummary,
        stderrSummary: evidence.stderrSummary,
        stdoutHash: evidence.stdoutHash ?? null,
        stderrHash: evidence.stderrHash ?? null,
      },
    });
    return evidence;
  };

  await input.eventStore.append({
    sessionId: input.sessionId,
    eventType: "CANDIDATE_VALIDATION_STARTED",
    occurredAt: input.now().toISOString(),
    payload: {
      candidateId: candidate.candidateId,
      sandboxId,
      strategy: candidate.strategy,
      provenanceKind: LOCAL_TEST_PROVENANCE.kind,
      profileId: input.profile.id,
      profileVersion: input.profile.profileVersion,
      commandPolicyId: input.profile.commandPolicyId,
    },
  });

  const gitExecutable = (await executableOnPath("git")) ?? "git";
  const gitInit = await runCommand("git-init", gitExecutable, ["init", "--quiet"]);
  if (gitInit.exitCode !== 0) {
    throw new Error(`${candidate.candidateId} failed to initialize its isolated Git repository`);
  }
  const applyCheck = await runCommand(
    "patch-check",
    gitExecutable,
    ["apply", "--check", "--whitespace=error-all", patchPath],
  );
  if (applyCheck.exitCode !== 0) {
    throw new Error(`${candidate.candidateId} failed git apply --check`);
  }
  const apply = await runCommand(
    "patch-apply",
    gitExecutable,
    ["apply", "--whitespace=error-all", patchPath],
  );
  if (apply.exitCode !== 0) throw new Error(`${candidate.candidateId} failed git apply`);
  const fixtureHashAfterPatch = await hashFile(sourcePath);
  if (fixtureHashAfterPatch === fixtureHashBeforePatch) {
    throw new Error(`${candidate.candidateId} did not change the target source file`);
  }

  const configure = await runCommand(
    "configure",
    input.toolchain.cmakePath,
    configureArguments(
      input.toolchain,
      join(repositoryRoot, input.profile.fixtureDirectory),
      buildDirectory,
    ),
  );
  let build: LocalCommandResult | undefined;
  let unit: LocalCommandResult | undefined;
  let safety: LocalCommandResult | undefined;
  if (configure.exitCode === 0) {
    build = await runCommand(
      "build",
      input.toolchain.cmakePath,
      buildArguments(input.toolchain, buildDirectory),
    );
  }
  if (build?.exitCode === 0) {
    // Candidate sandboxes run concurrently. Within one build tree, keep CTest
    // suites sequential so they cannot race on CTest's shared Temporary logs.
    unit = await runCommand(
      "unit-tests",
      input.toolchain.ctestPath,
      ctestArguments(input.toolchain, buildDirectory, "unit"),
    );
    safety = await runCommand(
      "safety-tests",
      input.toolchain.ctestPath,
      ctestArguments(input.toolchain, buildDirectory, "safety"),
    );
  }

  const buildPassed =
    configure.exitCode === 0 &&
    !configure.timedOut &&
    build?.exitCode === 0 &&
    !build.timedOut;
  const unitTests = deterministicSuiteEvidence(
    unit !== undefined,
    unit?.exitCode ?? null,
    unit?.timedOut ?? false,
    input.profile.expectedUnitTests,
  );
  const safetyTests = deterministicSuiteEvidence(
    safety !== undefined,
    safety?.exitCode ?? null,
    safety?.timedOut ?? false,
    input.profile.expectedSafetyTests,
  );
  const scores = scoreValues(buildPassed, unitTests, safetyTests, integrity);
  const evidenceDigest = computeEvidenceDigest({
    provenance: LOCAL_TEST_PROVENANCE,
    profile: {
      id: input.profile.id,
      profileVersion: input.profile.profileVersion,
      commandPolicyId: input.profile.commandPolicyId,
      hardwareClass: input.profile.hardwareClass,
      fixtureDirectory: input.profile.fixtureDirectory,
      sourceFile: input.profile.sourceFile,
      expectedUnitTests: input.profile.expectedUnitTests,
      expectedSafetyTests: input.profile.expectedSafetyTests,
    },
    candidate,
    sandboxId,
    fixtureHashBeforePatch,
    fixtureHashAfterPatch,
    integrity,
    commands,
    scores,
  });

  return {
    candidate,
    provenance: LOCAL_TEST_PROVENANCE,
    sandboxId,
    sandboxDirectory,
    fixtureHashBeforePatch,
    fixtureHashAfterPatch,
    integrity,
    commands,
    buildPassed,
    unitTests,
    safetyTests,
    scores,
    eligible: false,
    weightedScore: 0,
    hardGateFailures: [],
    evidenceDigest,
  };
}

export async function runLocalTournament(
  options: LocalTournamentOptions,
): Promise<LocalTournamentResult> {
  const now = options.now ?? (() => new Date());
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sessionId = safeSegment(options.sessionId);
  const profile = executableProfile(
    options.profileId ?? "battery-sensor-disconnect",
  );
  const scenarioId = options.scenarioId ?? DEFAULT_DEMO_SCENARIO_ID;
  if (scenarioId === "provider-failure") {
    throw new Error(
      "The provider-failure scenario is a fail-closed API fixture and cannot execute a local tournament.",
    );
  }
  // This host runner deliberately accepts only repository-owned fixtures.
  // Fireworks/model-authored candidates must use Daytona live execution.
  const scenarioCandidates = profile.candidatesForScenario(scenarioId);
  const candidates = scenarioCandidates.map((candidate) =>
    CandidatePatchSchema.parse(candidate),
  );
  if (
    candidates.length !== 3 ||
    new Set(candidates.map((candidate) => candidate.candidateId)).size !== 3 ||
    new Set(candidates.map((candidate) => candidate.strategy)).size !== 3
  ) {
    throw new Error("Local tournament requires exactly three unique candidates and strategies");
  }
  const sandboxRoot = join(workspaceRoot, ".safeflash", "local-sandboxes");
  await mkdir(sandboxRoot, { recursive: true });
  const eventLogPath = join(sandboxRoot, `localtest-${sessionId}.events.jsonl`);
  if (await fileExists(eventLogPath)) {
    throw new Error(`Local tournament session already exists: ${sessionId}`);
  }
  const eventStore = new JsonlEventStore(eventLogPath);
  const toolchain = await discoverLocalToolchain();
  const commitSha = await determineGitRevision(workspaceRoot);
  await eventStore.append({
    sessionId,
    eventType: "TOURNAMENT_STARTED",
    occurredAt: now().toISOString(),
    payload: {
      candidateCount: candidates.length,
      execution: "parallel-local-copy",
      provider: "local-process",
      mode: "mock",
      warning: LOCAL_TEST_PROVENANCE.notice,
      scenarioId,
      profileId: profile.id,
      profileVersion: profile.profileVersion,
      commandPolicyId: profile.commandPolicyId,
      hardwareClass: profile.hardwareClass,
      fixtureDirectory: profile.fixtureDirectory,
      sourceFile: profile.sourceFile,
      sourceCommitSha: commitSha,
      toolchain: {
        cmakePath: toolchain.cmakePath,
        ctestPath: toolchain.ctestPath,
        generator: toolchain.generator,
      },
    },
  });

  try {
    const settledResults = await Promise.allSettled(
      candidates.map((candidate) =>
        validateOneCandidate({
          candidate,
          sessionId,
          workspaceRoot,
          sandboxRoot,
          toolchain,
          commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          commitSha,
          eventStore,
          now,
          profile,
        }),
      ),
    );
    const failed = settledResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) throw failed.reason;
    const rawResults = settledResults.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("Unreachable rejected local tournament result");
      }
      return result.value;
    });
    const decision = selectCandidate(
      rawResults.map((result) => ({
        candidateId: result.candidate.candidateId,
        values: result.scores,
        evidenceDigest: result.evidenceDigest,
      })),
      {
        id: `localtest-decision-${sessionId}`,
        sessionId,
        source: "local-test",
        sourceVersion: LOCAL_SOURCE_VERSION,
        at: now().toISOString(),
        selectionPolicyVersion: "safety-tournament-v1",
      },
    );
    const candidatesWithDecision = rawResults.map((result) => {
      const ranking = decision.rankings.find(
        (item) => item.candidateId === result.candidate.candidateId,
      );
      if (!ranking) throw new Error("Selector omitted a tournament candidate");
      return {
        ...result,
        eligible: ranking.eligible,
        weightedScore: ranking.weightedScore,
        hardGateFailures: ranking.hardGateFailures,
      };
    });
    await Promise.all(
      candidatesWithDecision.map((result) =>
        eventStore.append({
          sessionId,
          eventType: "CANDIDATE_VALIDATION_COMPLETED",
          occurredAt: now().toISOString(),
          payload: {
            candidateId: result.candidate.candidateId,
            sandboxId: result.sandboxId,
            buildPassed: result.buildPassed,
            unitTestsPassed:
              result.unitTests.executed && result.unitTests.exitCode === 0,
            safetyTestsPassed:
              result.safetyTests.executed && result.safetyTests.exitCode === 0,
            eligible: result.eligible,
            weightedScore: result.weightedScore,
            hardGateFailures: [...result.hardGateFailures],
            evidenceDigest: result.evidenceDigest,
          },
        }),
      ),
    );
    await eventStore.append({
      sessionId,
      eventType: "TOURNAMENT_COMPLETED",
      occurredAt: now().toISOString(),
      payload: {
        winnerCandidateId: decision.winnerCandidateId,
        decisionId: decision.id,
        rationale: decision.rationale,
      },
    });
    const events = await eventStore.readAll();
    const replayedState = replayEvents(
      events,
      EMPTY_TOURNAMENT_REPLAY,
      reduceTournamentEvent,
    );
    return {
      sessionId,
      profile,
      provenance: LOCAL_TEST_PROVENANCE,
      eventLogPath,
      toolchain,
      candidates: candidatesWithDecision,
      decision,
      replayedState,
    };
  } catch (error) {
    await eventStore.append({
      sessionId,
      eventType: "TOURNAMENT_FAILED",
      occurredAt: now().toISOString(),
      payload: {
        reason: error instanceof Error ? error.message : "Unknown local tournament failure",
      },
    });
    throw error;
  }
}

export async function runSafetyTournament(
  options: SafetyTournamentOptions,
): Promise<LocalTournamentResult | ExternalTournamentResult> {
  if (options.mode !== "mock") {
    if (!options.provider) throw new LiveTournamentProviderRequiredError(options.mode);
    const result = await options.provider.run(options);
    const expectedKind = options.mode === "live" ? "live" : "recorded-live";
    if (
      result.provenance.mode !== options.mode ||
      result.provenance.kind !== expectedKind ||
      result.provenance.provider.trim() === "" ||
      (options.mode === "cached" &&
        (result.provenance.mode !== "cached" ||
          result.provenance.evidenceRef.trim() === ""))
    ) {
      throw new LiveTournamentProviderRequiredError(options.mode);
    }
    return result;
  }
  if (options.provider) {
    throw new Error("Mock/local-test mode must not invoke a live tournament provider");
  }
  return runLocalTournament(options);
}
