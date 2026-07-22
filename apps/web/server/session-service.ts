import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  computeEvidenceDigest,
  createHumanApproval,
  createValidationSession,
  isApprovalValid,
  sha256,
  transitionValidationSession,
  type ApprovalDecision,
  type ValidationSession,
  type WorkflowEvent,
} from "@safeflash/domain";
import {
  JsonlEventStore,
  runLocalTournament,
  type LocalCandidateResult,
  type LocalTournamentOptions,
  type LocalTournamentResult,
  type StoredEvent,
} from "@safeflash/orchestrator";
import { z } from "zod";

import type {
  CandidateEvidenceView,
  CandidateView,
  EvidenceProvenance,
  SessionView,
  TimelineEventView,
} from "../lib/session-types";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const STORE_VERSION = 1 as const;
const POLICY_VERSION = "battery-safety-v1";
const SOURCE_VERSION = "web-session-service-v1";

const LOCAL_PROVENANCE: EvidenceProvenance = Object.freeze({
  kind: "local-test",
  provider: "local-process",
  verified: false,
});

export const CreateSessionRequestSchema = z
  .object({
    incidentKind: z.literal("battery-sensor-disconnect"),
    runKind: z.literal("tournament"),
  })
  .strict();

export const DecisionRequestSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "changes_requested"]),
    reason: z.string().trim().min(1).max(2_000).optional(),
    candidateId: z.string().min(1).max(96),
    evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    patchDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    commitSha: z.string().min(7).max(64),
    policyVersion: z.string().min(1).max(128),
    approverDisplayName: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

interface PersistedSession {
  storeVersion: typeof STORE_VERSION;
  session: ValidationSession;
  view: SessionView;
  tournamentEventLogPath: string;
  persistedAt: string;
}

export class SessionServiceError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 500 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionServiceError";
  }
}

export interface SessionServiceOptions {
  workspaceRoot?: string;
  storageDirectory?: string;
  now?: () => Date;
  runTournament?: (
    options: LocalTournamentOptions,
  ) => Promise<LocalTournamentResult>;
}

function assertSafeSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionServiceError(400, "INVALID_SESSION_ID", "Invalid session identifier.");
  }
  return sessionId;
}

function asIso(now: () => Date): string {
  return now().toISOString();
}

function applyEvents(
  session: ValidationSession,
  events: readonly WorkflowEvent[],
): ValidationSession {
  return events.reduce(transitionValidationSession, session);
}

function candidateCommand(
  result: LocalCandidateResult,
  commandId: string,
) {
  return result.commands.find((command) => command.commandId === commandId);
}

function evidenceView(
  status: CandidateEvidenceView["status"],
  summary: string,
  command: ReturnType<typeof candidateCommand>,
): CandidateEvidenceView {
  return {
    status,
    summary,
    exitCode: command?.exitCode,
    artifactHash: command?.artifactHash,
    provenance: { ...LOCAL_PROVENANCE },
  };
}

function mapCandidate(
  result: LocalCandidateResult,
  winnerCandidateId: string | null,
): CandidateView {
  const buildCommand = candidateCommand(result, "build");
  const unitCommand = candidateCommand(result, "unit-tests");
  const safetyCommand = candidateCommand(result, "safety-tests");
  const eliminatedReason = result.eligible
    ? undefined
    : result.hardGateFailures.join("; ") || "Candidate failed a non-compensable gate.";

  return {
    id: result.candidate.candidateId,
    label: result.candidate.candidateId,
    strategy: result.candidate.strategy,
    hypothesis: result.candidate.hypothesis,
    selected: result.candidate.candidateId === winnerCandidateId,
    eliminatedReason,
    sandbox: {
      id: result.sandboxId,
      status: result.eligible ? "passed" : "failed",
      isolated: true,
      provenance: { ...LOCAL_PROVENANCE },
    },
    build: evidenceView(
      result.buildPassed ? "passed" : "failed",
      result.buildPassed ? "Real local CMake build passed." : "Real local CMake build failed.",
      buildCommand,
    ),
    tests: {
      ...evidenceView(
        !result.unitTests.executed
          ? "not-run"
          : result.unitTests.exitCode === 0
            ? "passed"
            : "failed",
        `${result.unitTests.passed}/${result.unitTests.total} local unit tests passed.`,
        unitCommand,
      ),
      passed: result.unitTests.passed,
      total: result.unitTests.total,
    },
    safetyGate: {
      ...evidenceView(
        !result.safetyTests.executed
          ? "not-run"
          : result.safetyTests.exitCode === 0
            ? "passed"
            : "failed",
        `${result.safetyTests.passed}/${result.safetyTests.total} local safety tests passed.`,
        safetyCommand,
      ),
      hardGatePassed: result.eligible,
      failures: [...result.hardGateFailures],
    },
    score: {
      weighted: result.weightedScore,
      eligible: result.eligible,
      provenance: { ...LOCAL_PROVENANCE },
    },
    diff: result.candidate.unifiedDiff,
  };
}

function eventSummary(event: StoredEvent): string {
  switch (event.eventType) {
    case "TOURNAMENT_STARTED":
      return "Three deterministic candidates entered isolated local filesystem copies.";
    case "CANDIDATE_VALIDATION_COMPLETED":
      return `Candidate ${String(event.payload.candidateId ?? "unknown")} completed local validation.`;
    case "TOURNAMENT_COMPLETED":
      return `Local selector chose ${String(event.payload.winnerCandidateId ?? "no eligible candidate")}.`;
    case "TOURNAMENT_FAILED":
      return "Local tournament failed; no candidate may proceed.";
    default:
      return "Local validation evidence was recorded.";
  }
}

function timelineEvent(event: StoredEvent): TimelineEventView {
  return {
    id: event.eventHash,
    sequence: event.sequence,
    state:
      event.eventType === "TOURNAMENT_COMPLETED"
        ? "AWAITING_HUMAN_APPROVAL"
        : event.eventType,
    title: event.eventType.replaceAll("_", " "),
    summary: eventSummary(event),
    occurredAt: event.occurredAt,
    provenance: { ...LOCAL_PROVENANCE },
  };
}

function appendViewEvent(
  view: SessionView,
  input: { title: string; summary: string; at: string; state: string },
): SessionView {
  const sequence = view.events.length + 1;
  return {
    ...view,
    updatedAt: input.at,
    events: [
      ...view.events,
      {
        id: computeEvidenceDigest({
          sessionId: view.id,
          sequence,
          title: input.title,
          at: input.at,
        }),
        sequence,
        state: input.state,
        title: input.title,
        summary: input.summary,
        occurredAt: input.at,
        provenance: { ...LOCAL_PROVENANCE },
      },
    ],
  };
}

function parsePersisted(value: unknown, expectedId?: string): PersistedSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionServiceError(500, "CORRUPT_SESSION", "Stored session is not readable.");
  }
  const record = value as Partial<PersistedSession>;
  if (
    record.storeVersion !== STORE_VERSION ||
    typeof record.session !== "object" ||
    record.session === null ||
    typeof record.view !== "object" ||
    record.view === null ||
    typeof record.view.id !== "string" ||
    !SESSION_ID_PATTERN.test(record.view.id) ||
    record.session.sessionId !== record.view.id ||
    (expectedId !== undefined && record.view.id !== expectedId) ||
    typeof record.tournamentEventLogPath !== "string" ||
    typeof record.persistedAt !== "string"
  ) {
    throw new SessionServiceError(500, "CORRUPT_SESSION", "Stored session failed validation.");
  }
  return record as PersistedSession;
}

export class SessionService {
  private readonly workspaceRoot: string;
  private readonly storageDirectory: string;
  private readonly now: () => Date;
  private readonly tournamentRunner: NonNullable<
    SessionServiceOptions["runTournament"]
  >;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: SessionServiceOptions = {}) {
    this.workspaceRoot = resolve(
      options.workspaceRoot ??
        process.env.SAFEFLASH_WORKSPACE_ROOT ??
        process.env.INIT_CWD ??
        /* turbopackIgnore: true */ process.cwd(),
    );
    this.storageDirectory = resolve(
      options.storageDirectory ?? join(this.workspaceRoot, ".safeflash", "web-sessions"),
    );
    this.now = options.now ?? (() => new Date());
    this.tournamentRunner = options.runTournament ?? runLocalTournament;
  }

  private filePath(sessionId: string): string {
    const safeId = assertSafeSessionId(sessionId);
    const path = resolve(this.storageDirectory, `${safeId}.json`);
    if (dirname(path) !== this.storageDirectory) {
      throw new SessionServiceError(400, "INVALID_SESSION_ID", "Invalid session identifier.");
    }
    return path;
  }

  private async withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.queues.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(sessionId) === current) this.queues.delete(sessionId);
    }
  }

  private async persist(record: PersistedSession): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });
    const target = this.filePath(record.view.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
  }

  private async validateEvidence(record: PersistedSession): Promise<void> {
    const evidenceRoot = resolve(
      this.workspaceRoot,
      ".safeflash",
      "local-sandboxes",
    );
    const eventLogPath = resolve(record.tournamentEventLogPath);
    const evidenceRelativePath = relative(evidenceRoot, eventLogPath);
    if (
      evidenceRelativePath === "" ||
      evidenceRelativePath.startsWith("..") ||
      isAbsolute(evidenceRelativePath) ||
      basename(eventLogPath) !== `localtest-${record.view.id}.events.jsonl`
    ) {
      throw new SessionServiceError(
        500,
        "CORRUPT_SESSION",
        "Stored session points outside its verified tournament evidence boundary.",
      );
    }

    const events = await new JsonlEventStore(eventLogPath).readAll();
    const completed = events.at(-1);
    const winnerCandidateId = completed?.payload.winnerCandidateId;
    const winnerCompletion = events.find(
      (event) =>
        event.eventType === "CANDIDATE_VALIDATION_COMPLETED" &&
        event.payload.candidateId === winnerCandidateId,
    );
    const started = events[0];
    const winnerView = record.view.candidates.find(
      (candidate) => candidate.id === winnerCandidateId,
    );
    const patchDigest = winnerView?.diff ? sha256(winnerView.diff) : undefined;

    if (
      completed?.eventType !== "TOURNAMENT_COMPLETED" ||
      typeof winnerCandidateId !== "string" ||
      winnerCompletion?.payload.eligible !== true ||
      typeof winnerCompletion.payload.evidenceDigest !== "string" ||
      started?.eventType !== "TOURNAMENT_STARTED" ||
      typeof started.payload.sourceCommitSha !== "string" ||
      winnerView === undefined ||
      winnerView.selected !== true ||
      patchDigest === undefined ||
      record.session.sessionId !== record.view.id ||
      record.session.state !== record.view.state ||
      record.session.mode !== "mock" ||
      record.view.mode !== "mock" ||
      record.session.selectedCandidateId !== winnerCandidateId ||
      record.view.selectedCandidateId !== winnerCandidateId ||
      record.session.currentEvidenceDigest !==
        winnerCompletion.payload.evidenceDigest ||
      record.view.currentEvidenceDigest !==
        winnerCompletion.payload.evidenceDigest ||
      record.session.currentPatchDigest !== patchDigest ||
      record.view.currentPatchDigest !== patchDigest ||
      record.session.repository.commitSha !== started.payload.sourceCommitSha ||
      record.view.repository.commitSha !== started.payload.sourceCommitSha ||
      record.session.policyVersion !== record.view.policy.version ||
      record.view.pullRequest !== undefined ||
      record.view.events.length < events.length ||
      events.some(
        (event, index) => record.view.events[index]?.id !== event.eventHash,
      )
    ) {
      throw new SessionServiceError(
        500,
        "CORRUPT_SESSION",
        "Stored session no longer matches its hash-chained tournament evidence.",
      );
    }

    if (record.session.approval !== undefined) {
      const approval = record.session.approval;
      const viewApproval = record.view.approval;
      if (
        viewApproval === undefined ||
        viewApproval.decision !== approval.decision ||
        viewApproval.bindingDigest !== approval.bindingDigest ||
        viewApproval.evidenceDigest !== approval.evidenceDigest
      ) {
        throw new SessionServiceError(
          500,
          "CORRUPT_SESSION",
          "Stored approval is not consistent with the visible evidence binding.",
        );
      }
      if (
        approval.decision === "approved" &&
        !isApprovalValid(approval, {
          candidateId: winnerCandidateId,
          patchDigest,
          evidenceDigest: winnerCompletion.payload.evidenceDigest,
          policyVersion: record.session.policyVersion,
          commitSha: record.session.repository.commitSha,
        })
      ) {
        throw new SessionServiceError(
          500,
          "CORRUPT_SESSION",
          "Stored approval is stale or was modified after it was recorded.",
        );
      }
    } else if (record.view.approval !== undefined) {
      throw new SessionServiceError(
        500,
        "CORRUPT_SESSION",
        "Visible approval has no corresponding server-owned approval record.",
      );
    }
  }

  private async load(sessionId: string): Promise<PersistedSession> {
    const safeId = assertSafeSessionId(sessionId);
    try {
      const text = await readFile(this.filePath(safeId), "utf8");
      const record = parsePersisted(JSON.parse(text) as unknown, safeId);
      await this.validateEvidence(record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionServiceError(404, "SESSION_NOT_FOUND", "Session was not found.");
      }
      if (error instanceof SessionServiceError) throw error;
      throw new SessionServiceError(500, "SESSION_READ_FAILED", "Session could not be read.");
    }
  }

  async create(input: unknown): Promise<SessionView> {
    const request = CreateSessionRequestSchema.safeParse(input);
    if (!request.success) {
      throw new SessionServiceError(400, "INVALID_REQUEST", "Session request failed validation.");
    }
    const sessionId = `web-${randomUUID()}`;
    return this.withSessionLock(sessionId, async () => {
      let tournament: LocalTournamentResult;
      try {
        tournament = await this.tournamentRunner({
          sessionId,
          workspaceRoot: this.workspaceRoot,
          commandTimeoutMs: 90_000,
        });
      } catch {
        throw new SessionServiceError(
          503,
          "LOCAL_TOURNAMENT_FAILED",
          "Local validation could not complete; no candidate was approved.",
        );
      }

      if (
        tournament.provenance.mode !== "mock" ||
        tournament.provenance.kind !== "local-test" ||
        tournament.provenance.provider !== "local-process"
      ) {
        throw new SessionServiceError(
          500,
          "PROVENANCE_MISMATCH",
          "Tournament provenance did not match the local execution mode.",
        );
      }

      const winnerId = tournament.decision.winnerCandidateId;
      const winner = tournament.candidates.find(
        (candidate) => candidate.candidate.candidateId === winnerId,
      );
      if (!winnerId || !winner || !winner.eligible) {
        throw new SessionServiceError(
          503,
          "NO_ELIGIBLE_CANDIDATE",
          "No candidate passed every hard safety gate.",
        );
      }
      const commitSha = winner.commands[0]?.commitSha;
      if (!commitSha || !/^[0-9a-f]{40}$/u.test(commitSha)) {
        throw new SessionServiceError(
          409,
          "UNCOMMITTED_VALIDATION_SOURCE",
          "Local validation must run from a clean, committed source revision.",
        );
      }
      const patchDigest = sha256(winner.candidate.unifiedDiff);
      const createdAt = asIso(this.now);
      let domainSession = createValidationSession({
        id: sessionId,
        incidentId: "battery-sensor-disconnect",
        policyId: "battery-controller-safety-policy",
        policyVersion: POLICY_VERSION,
        repository: { repoUrl: "local-workspace", commitSha },
        mode: "mock",
        runKind: "tournament",
        sourceVersion: SOURCE_VERSION,
        at: createdAt,
      });
      const candidateIds = tournament.candidates.map(
        (candidate) => candidate.candidate.candidateId,
      );
      const sandboxIdsByCandidate = Object.fromEntries(
        tournament.candidates.map((candidate) => [
          candidate.candidate.candidateId,
          candidate.sandboxId,
        ]),
      );
      const at = () => asIso(this.now);
      domainSession = applyEvents(domainSession, [
        { type: "START", at: at() },
        { type: "REPOSITORY_INGESTED", at: at() },
        { type: "INCIDENT_ANALYZED", at: at() },
        { type: "CANDIDATES_GENERATED", at: at(), candidateIds },
        { type: "SANDBOXES_PROVISIONED", at: at(), sandboxIdsByCandidate },
        { type: "BUILDS_FINISHED", at: at() },
        { type: "TESTS_FINISHED", at: at() },
        { type: "SCORING_FINISHED", at: at() },
        {
          type: "CANDIDATE_SELECTED",
          at: at(),
          candidateId: winnerId,
          patchDigest,
          evidenceDigest: winner.evidenceDigest,
        },
      ]);

      const storedEvents = await new JsonlEventStore(tournament.eventLogPath).readAll();
      const view: SessionView = {
        id: sessionId,
        mode: "mock",
        state: domainSession.state,
        createdAt,
        updatedAt: domainSession.updatedAt,
        repository: { repoUrl: "local-workspace", commitSha },
        incident: {
          title: "Battery temperature sensor disconnected while charging",
          summary:
            "The baseline firmware continues charging after a sensor disconnect; local safety tests reproduce the fault.",
          severity: "critical",
          temperatureC: 0,
          sensorFault: true,
          chargingEnabled: true,
          evidence: [
            "baseline_build=passed",
            "sensor_disconnect_safety_test=failed",
            "fault_latch_safety_test=failed",
          ],
          provenance: { ...LOCAL_PROVENANCE },
        },
        policy: {
          name: "Battery Controller Fail-Closed Safety Policy",
          version: POLICY_VERSION,
          invariants: [
            {
              id: "sensor-disconnect-fail-closed",
              description: "A disconnected sensor disables charging in the same update cycle.",
              hardGate: true,
            },
            {
              id: "stale-sample-fail-closed",
              description: "A stale sensor stream disables charging at the configured cycle limit.",
              hardGate: true,
            },
            {
              id: "fault-remains-latched",
              description: "A safety fault remains latched until an explicit reset.",
              hardGate: true,
            },
          ],
          provenance: { ...LOCAL_PROVENANCE },
        },
        candidates: tournament.candidates.map((candidate) =>
          mapCandidate(candidate, winnerId),
        ),
        selectedCandidateId: winnerId,
        currentPatchDigest: patchDigest,
        currentEvidenceDigest: winner.evidenceDigest,
        events: storedEvents.map(timelineEvent),
      };
      const record: PersistedSession = {
        storeVersion: STORE_VERSION,
        session: domainSession,
        view,
        tournamentEventLogPath: tournament.eventLogPath,
        persistedAt: at(),
      };
      await this.persist(record);
      return view;
    });
  }

  async get(sessionId: string): Promise<SessionView> {
    return (await this.load(sessionId)).view;
  }

  async list(): Promise<readonly SessionView[]> {
    await mkdir(this.storageDirectory, { recursive: true });
    const entries = await readdir(this.storageDirectory, { withFileTypes: true });
    const sessions: SessionView[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sessionId = basename(entry.name, ".json");
      if (!SESSION_ID_PATTERN.test(sessionId)) continue;
      sessions.push((await this.load(sessionId)).view);
    }
    return sessions.sort((left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
    );
  }

  async decide(sessionId: string, input: unknown): Promise<SessionView> {
    const safeId = assertSafeSessionId(sessionId);
    const request = DecisionRequestSchema.safeParse(input);
    if (!request.success) {
      throw new SessionServiceError(400, "INVALID_DECISION", "Decision request failed validation.");
    }
    return this.withSessionLock(safeId, async () => {
      const record = await this.load(safeId);
      const current = record.session;
      if (current.state !== "AWAITING_HUMAN_APPROVAL") {
        throw new SessionServiceError(409, "DECISION_NOT_ALLOWED", "This session is not awaiting a decision.");
      }
      const expected = {
        candidateId: current.selectedCandidateId,
        patchDigest: current.currentPatchDigest,
        evidenceDigest: current.currentEvidenceDigest,
        commitSha: current.repository.commitSha,
        policyVersion: current.policyVersion,
      };
      if (
        request.data.candidateId !== expected.candidateId ||
        request.data.patchDigest !== expected.patchDigest ||
        request.data.evidenceDigest !== expected.evidenceDigest ||
        request.data.commitSha !== expected.commitSha ||
        request.data.policyVersion !== expected.policyVersion
      ) {
        throw new SessionServiceError(
          409,
          "STALE_OR_TAMPERED_DECISION",
          "Decision binding does not match the selected patch and evidence.",
        );
      }
      const actedAt = asIso(this.now);
      const approval = createHumanApproval({
        id: `approval-${randomUUID()}`,
        sessionId: safeId,
        candidateId: request.data.candidateId,
        patchDigest: request.data.patchDigest,
        evidenceDigest: request.data.evidenceDigest,
        commitSha: request.data.commitSha,
        policyVersion: request.data.policyVersion,
        approverId: "local-web-operator",
        approverDisplayName: request.data.approverDisplayName ?? "Local operator",
        decision: request.data.decision as ApprovalDecision,
        source: "web-api-local",
        sourceVersion: SOURCE_VERSION,
        actedAt,
        reason: request.data.reason,
      });
      let domainSession = transitionValidationSession(current, {
        type: "APPROVAL_RECORDED",
        at: actedAt,
        approval,
      });
      let title: string;
      let summary: string;
      if (request.data.decision === "rejected") {
        domainSession = transitionValidationSession(domainSession, {
          type: "CANCEL",
          at: actedAt,
        });
        title = "HUMAN REJECTED CANDIDATE";
        summary = "The local workflow was cancelled. No pull request was created.";
      } else if (request.data.decision === "changes_requested") {
        title = "HUMAN REQUESTED CHANGES";
        summary = "Changes were requested. The current candidate remains blocked and no pull request was created.";
      } else {
        title = "APPROVAL RECORDED - EXTERNAL PUBLISH BLOCKED";
        summary =
          "Approval is bound to this exact local patch and evidence. This local-test API does not claim GitHub or CodeRabbit execution; no pull request was created.";
      }
      let view: SessionView = {
        ...record.view,
        state: domainSession.state,
        updatedAt: actedAt,
        approval: {
          decision: approval.decision,
          approverDisplayName: approval.approverDisplayName,
          evidenceDigest: approval.evidenceDigest,
          bindingDigest: approval.bindingDigest,
          invalidatedAt: approval.invalidatedAt,
        },
        pullRequest: undefined,
      };
      view = appendViewEvent(view, {
        title,
        summary,
        at: actedAt,
        state: domainSession.state,
      });
      await this.persist({
        ...record,
        session: domainSession,
        view,
        persistedAt: actedAt,
      });
      return view;
    });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __safeFlashSessionService: SessionService | undefined;
}

export function getSessionService(): SessionService {
  globalThis.__safeFlashSessionService ??= new SessionService();
  return globalThis.__safeFlashSessionService;
}
