import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  computeEvidenceDigest,
  parseRecordedLiveArtifact,
  type RecordedLiveArtifact,
  type RecordedLiveProviderName,
} from "@safeflash/domain";
import { demoScenario } from "@safeflash/orchestrator";

import type {
  CandidateView,
  EvidenceProvenance,
  SessionView,
  TimelineEventView,
} from "../lib/session-types";
import {
  CreateSessionRequestSchema,
  SessionServiceError,
} from "./session-service";

const DEFAULT_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u;

export interface RecordedLiveSessionServiceOptions {
  artifactPath?: string;
  signingKey?: string;
  maxArtifactBytes?: number;
}

function configurationError(message: string): SessionServiceError {
  return new SessionServiceError(
    503,
    "RECORDED_LIVE_CONFIGURATION_UNAVAILABLE",
    message,
  );
}

function invalidArtifact(): SessionServiceError {
  return new SessionServiceError(
    503,
    "RECORDED_LIVE_INVALID",
    "Recorded-live evidence is missing, unreadable, or failed integrity validation.",
  );
}

function providerMap(
  artifact: RecordedLiveArtifact,
): ReadonlyMap<RecordedLiveProviderName, RecordedLiveArtifact["providers"][number]> {
  return new Map(
    artifact.providers.map((provider) => [provider.provider, provider] as const),
  );
}

function recordedProvenance(
  artifact: RecordedLiveArtifact,
  provider: RecordedLiveArtifact["providers"][number],
  resourceKinds?: readonly string[],
): EvidenceProvenance {
  const resources =
    resourceKinds === undefined
      ? provider.resources
      : provider.resources.filter((resource) =>
          resourceKinds.includes(resource.kind),
        );
  return {
    kind: "recorded-live",
    provider: provider.provider,
    verified: true,
    externalId: [
      ...provider.requestIds.map((requestId) => `request:${requestId}`),
      ...resources.map((resource) => `${resource.kind}:${resource.id}`),
    ].join(","),
    capturedAt: provider.capturedAt,
    url: resources.find((resource) => resource.url !== undefined)?.url,
  };
}

function orchestratorProvenance(
  artifact: RecordedLiveArtifact,
  externalId: string,
): EvidenceProvenance {
  return {
    kind: "recorded-live",
    provider: "safeflash-orchestrator",
    verified: true,
    externalId,
    capturedAt: artifact.capturedAt,
  };
}

function eventProvenance(
  artifact: RecordedLiveArtifact,
  event: RecordedLiveArtifact["events"][number],
  providers: ReturnType<typeof providerMap>,
): EvidenceProvenance {
  if (
    event.provider === undefined ||
    event.provider === "safeflash-orchestrator"
  ) {
    return orchestratorProvenance(
      artifact,
      `${artifact.runId}:event:${event.sequence}`,
    );
  }
  const provider = providers.get(event.provider);
  if (provider === undefined) throw invalidArtifact();
  const refs = event.resourceRefs.map((resource) => resource.kind);
  return recordedProvenance(artifact, provider, refs);
}

function candidateView(
  artifact: RecordedLiveArtifact,
  candidate: RecordedLiveArtifact["session"]["candidates"][number],
  providers: ReturnType<typeof providerMap>,
): CandidateView {
  const fireworks = providers.get("fireworks");
  const daytona = providers.get("daytona");
  const braintrust = providers.get("braintrust");
  if (!fireworks || !daytona || !braintrust) throw invalidArtifact();
  return {
    id: candidate.id,
    label: candidate.label,
    strategy: candidate.strategy,
    hypothesis: candidate.hypothesis,
    validationRound: candidate.validationRound,
    generation:
      candidate.generation === undefined
        ? undefined
        : {
            ...candidate.generation,
            provenance: recordedProvenance(artifact, fireworks, ["response"]),
          },
    selected: candidate.selected,
    eliminatedReason: candidate.eliminatedReason,
    sandbox: {
      ...candidate.sandbox,
      provenance: recordedProvenance(artifact, daytona, ["sandbox", "run"]),
    },
    build: {
      ...candidate.build,
      provenance: recordedProvenance(artifact, daytona, ["sandbox", "run"]),
    },
    tests: {
      ...candidate.tests,
      provenance: recordedProvenance(artifact, daytona, ["sandbox", "run"]),
    },
    safetyGate: {
      ...candidate.safetyGate,
      provenance: recordedProvenance(artifact, braintrust, [
        "experiment",
        "trace",
        "eval-result",
      ]),
    },
    score: {
      ...candidate.score,
      provenance: recordedProvenance(artifact, braintrust, [
        "dataset",
        "experiment",
        "trace",
        "eval-result",
      ]),
    },
  };
}

function timelineEvent(
  artifact: RecordedLiveArtifact,
  event: RecordedLiveArtifact["events"][number],
  providers: ReturnType<typeof providerMap>,
): TimelineEventView {
  return {
    id: computeEvidenceDigest({
      schemaVersion: 1,
      runId: artifact.runId,
      sequence: event.sequence,
    }),
    sequence: event.sequence,
    state: event.state,
    title: event.title,
    summary: event.summary,
    occurredAt: new Date(
      Date.parse(artifact.capturedAt) + event.offsetMs,
    ).toISOString(),
    provenance: eventProvenance(artifact, event, providers),
  };
}

export function recordedLiveArtifactToSessionView(
  artifact: RecordedLiveArtifact,
): SessionView {
  const providers = providerMap(artifact);
  const github = providers.get("github");
  const coderabbit = providers.get("coderabbit");
  const daytona = providers.get("daytona");
  if (!github || !coderabbit || !daytona || !daytona.cleanup) {
    throw invalidArtifact();
  }
  const snapshot = artifact.session;
  const orchestrator = orchestratorProvenance(artifact, artifact.runId);
  return {
    id: snapshot.id,
    mode: "cached",
    state: snapshot.state,
    scenario: { ...demoScenario(snapshot.scenarioId) },
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    repository: {
      repoUrl: snapshot.repository.repoUrl,
      commitSha: snapshot.repository.baseCommitSha,
    },
    currentCommitSha: snapshot.repository.headCommitSha,
    incident: {
      ...snapshot.incident,
      provenance: { ...orchestrator },
    },
    policy: {
      ...snapshot.policy,
      provenance: { ...orchestrator },
    },
    candidates: snapshot.candidates.map((candidate) =>
      candidateView(artifact, candidate, providers),
    ),
    selectedCandidateId: snapshot.selectedCandidateId,
    currentPatchDigest: snapshot.currentPatchDigest,
    currentEvidenceDigest: snapshot.currentEvidenceDigest,
    approval: { ...snapshot.approval },
    pullRequest: {
      ...snapshot.pullRequest,
      provenance: recordedProvenance(artifact, github, [
        "repository",
        "pull-request",
        "base-sha",
        "head-sha",
      ]),
    },
    review: {
      ...snapshot.review,
      findings: [],
      provenance: recordedProvenance(artifact, coderabbit, [
        "pull-request",
        "head-sha",
        "review",
      ]),
    },
    providerEvidence: artifact.providers.map((provider) => ({
      provider: provider.provider,
      operation: "immutable recorded-live replay",
      status: "passed",
      requestId: provider.requestIds[0],
      requestIds: [...provider.requestIds],
      resourceIds: provider.resources.map((resource) => resource.id),
      urls: provider.resources.flatMap((resource) =>
        resource.url === undefined ? [] : [resource.url],
      ),
      capturedAt: provider.capturedAt,
      durationMs: provider.durationMs,
      provenance: recordedProvenance(artifact, provider),
    })),
    cleanup: {
      status: "deleted",
      sandboxIds: [...daytona.cleanup.resourceIds],
      summary:
        "Every Daytona sandbox captured by this recorded live run was deleted.",
      provenance: recordedProvenance(artifact, daytona, ["sandbox", "run"]),
    },
    events: artifact.events.map((event) =>
      timelineEvent(artifact, event, providers),
    ),
  };
}

export class RecordedLiveSessionService {
  private readonly artifactPath: string;
  private readonly signingKey: string;
  private readonly maxArtifactBytes: number;

  constructor(options: RecordedLiveSessionServiceOptions = {}) {
    const configuredPath =
      options.artifactPath ??
      process.env.SAFEFLASH_RECORDED_LIVE_PATH?.trim();
    if (!configuredPath) {
      throw configurationError(
        "Cached mode requires SAFEFLASH_RECORDED_LIVE_PATH.",
      );
    }
    this.artifactPath = resolve(configuredPath);
    const configuredSigningKey =
      options.signingKey ??
      process.env.SAFEFLASH_RECORDED_LIVE_SIGNING_KEY;
    if (
      configuredSigningKey === undefined ||
      configuredSigningKey.length < 32
    ) {
      throw configurationError(
        "Cached mode requires SAFEFLASH_RECORDED_LIVE_SIGNING_KEY.",
      );
    }
    this.signingKey = configuredSigningKey;
    this.maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (
      !Number.isSafeInteger(this.maxArtifactBytes) ||
      this.maxArtifactBytes <= 0
    ) {
      throw configurationError("Recorded-live artifact size limit is invalid.");
    }
  }

  private async load(): Promise<SessionView> {
    try {
      const metadata = await lstat(this.artifactPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size <= 0 ||
        metadata.size > this.maxArtifactBytes
      ) {
        throw invalidArtifact();
      }
      const bytes = await readFile(this.artifactPath);
      if (bytes.byteLength > this.maxArtifactBytes) throw invalidArtifact();
      const artifact = parseRecordedLiveArtifact(
        JSON.parse(bytes.toString("utf8")) as unknown,
        this.signingKey,
      );
      return structuredClone(recordedLiveArtifactToSessionView(artifact));
    } catch {
      throw invalidArtifact();
    }
  }

  async create(input: unknown): Promise<SessionView> {
    if (!CreateSessionRequestSchema.safeParse(input).success) {
      throw new SessionServiceError(
        400,
        "INVALID_REQUEST",
        "Session request failed validation.",
      );
    }
    return this.load();
  }

  async get(sessionId: string): Promise<SessionView> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new SessionServiceError(
        400,
        "INVALID_SESSION_ID",
        "Invalid session identifier.",
      );
    }
    const view = await this.load();
    if (view.id !== sessionId) {
      throw new SessionServiceError(
        404,
        "SESSION_NOT_FOUND",
        "Session was not found.",
      );
    }
    return view;
  }

  async list(): Promise<readonly SessionView[]> {
    return [await this.load()];
  }

  async decide(_sessionId: string, _input: unknown): Promise<SessionView> {
    throw new SessionServiceError(
      409,
      "RECORDED_LIVE_READ_ONLY",
      "Recorded-live replay is immutable and cannot accept decisions.",
    );
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __safeFlashRecordedLiveSessionService:
    | RecordedLiveSessionService
    | undefined;
}

export function getRecordedLiveSessionService(): RecordedLiveSessionService {
  if (process.env.SAFEFLASH_DEFAULT_MODE !== "cached") {
    throw configurationError("Recorded-live session service is disabled.");
  }
  globalThis.__safeFlashRecordedLiveSessionService ??=
    new RecordedLiveSessionService();
  return globalThis.__safeFlashRecordedLiveSessionService;
}
