import type {
  CandidateEvidenceView,
  CandidateView,
  DecisionAction,
  EvidenceProvenance,
  EvidenceStatus,
  IncidentView,
  SafetyPolicyView,
  SessionMode,
  SessionView,
  TimelineEventView,
} from "./session-types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number | null = null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

const modes = ["live", "cached", "mock", "hybrid", "unknown"] as const;
const provenanceKinds = [
  "live",
  "recorded-live",
  "mock",
  "local-test",
  "server-owned",
  "manual-verified",
  "unknown",
] as const;
const evidenceStatuses = [
  "passed",
  "failed",
  "running",
  "pending",
  "not-run",
] as const;

function normalizeProvenance(
  value: unknown,
  providerFallback: string,
): EvidenceProvenance {
  const record = asRecord(value);
  const kind = oneOf(record.kind, provenanceKinds, "unknown");
  const verified =
    kind === "mock" || kind === "local-test"
      ? false
      : asBoolean(record.verified, false);

  return {
    kind,
    provider: asString(record.provider, providerFallback || "unreported"),
    verified,
    externalId: asString(record.externalId) || undefined,
    capturedAt: asString(record.capturedAt) || undefined,
    url: asString(record.url) || undefined,
  };
}

function normalizeEvidence(
  value: unknown,
  provider: string,
): CandidateEvidenceView {
  const record = asRecord(value);
  return {
    status: oneOf(record.status, evidenceStatuses, "pending"),
    summary: asString(record.summary, "No evidence summary reported."),
    exitCode:
      record.exitCode === null ? null : (asNumber(record.exitCode) ?? undefined),
    artifactHash: asString(record.artifactHash) || undefined,
    provenance: normalizeProvenance(record.provenance, provider),
  };
}

function normalizeCandidate(
  value: unknown,
  index: number,
  selectedCandidateId?: string,
): CandidateView {
  const record = asRecord(value);
  const id = asString(record.id, "candidate-" + String(index + 1));
  const sandbox = asRecord(record.sandbox);
  const tests = asRecord(record.tests);
  const safetyGate = asRecord(record.safetyGate);
  const score = asRecord(record.score);
  const generation = asRecord(record.generation);
  const normalizedTests = normalizeEvidence(tests, "daytona");
  const normalizedSafety = normalizeEvidence(safetyGate, "braintrust");

  return {
    id,
    label: asString(record.label, "Candidate " + String(index + 1)),
    strategy: asString(record.strategy, "Strategy not reported"),
    hypothesis: asString(record.hypothesis) || undefined,
    validationRound: asNumber(record.validationRound) ?? undefined,
    generation:
      Object.keys(generation).length === 0
        ? undefined
        : {
            model: asString(generation.model) || undefined,
            profile: asString(generation.profile) || undefined,
            patchDigest: asString(generation.patchDigest) || undefined,
            provenance: normalizeProvenance(
              generation.provenance,
              "fireworks",
            ),
          },
    selected:
      asBoolean(record.selected, false) ||
      (selectedCandidateId !== undefined && selectedCandidateId === id),
    eliminatedReason: asString(record.eliminatedReason) || undefined,
    sandbox: {
      id: asString(sandbox.id) || undefined,
      status: asString(sandbox.status, "pending"),
      isolated: asBoolean(sandbox.isolated, false),
      provenance: normalizeProvenance(sandbox.provenance, "daytona"),
    },
    build: normalizeEvidence(record.build, "daytona"),
    tests: {
      ...normalizedTests,
      passed: asNumber(tests.passed, 0) ?? 0,
      total: asNumber(tests.total, 0) ?? 0,
    },
    safetyGate: {
      ...normalizedSafety,
      hardGatePassed:
        typeof safetyGate.hardGatePassed === "boolean"
          ? safetyGate.hardGatePassed
          : null,
      failures: asArray(safetyGate.failures).map((item) =>
        asString(item, "Unspecified hard-gate failure"),
      ),
    },
    score: {
      weighted: asNumber(score.weighted),
      eligible:
        typeof score.eligible === "boolean" ? score.eligible : null,
      experimentId: asString(score.experimentId) || undefined,
      traceId: asString(score.traceId) || undefined,
      provenance: normalizeProvenance(score.provenance, "braintrust"),
    },
    diff: asString(record.diff) || undefined,
  };
}

function normalizeIncident(value: unknown): IncidentView {
  const record = asRecord(value);
  return {
    title: asString(record.title, "Incident details not reported"),
    summary: asString(
      record.summary,
      "Waiting for the orchestrator to provide incident evidence.",
    ),
    severity: oneOf(
      record.severity,
      ["low", "medium", "high", "critical"] as const,
      "high",
    ),
    temperatureC: asNumber(record.temperatureC),
    sensorFault: asBoolean(record.sensorFault, false),
    chargingEnabled: asBoolean(record.chargingEnabled, false),
    lastUpdatedCycles: asNumber(record.lastUpdatedCycles) ?? undefined,
    evidence: asArray(record.evidence).map((item) => asString(item)),
    provenance: normalizeProvenance(record.provenance, "orchestrator"),
  };
}

function normalizePolicy(value: unknown): SafetyPolicyView {
  const record = asRecord(value);
  return {
    name: asString(record.name, "Safety policy not reported"),
    version: asString(record.version, "unversioned"),
    invariants: asArray(record.invariants).map((item, index) => {
      const invariant = asRecord(item);
      return {
        id: asString(invariant.id, "invariant-" + String(index + 1)),
        description: asString(
          invariant.description,
          "Invariant description not reported",
        ),
        hardGate: asBoolean(invariant.hardGate, true),
      };
    }),
    provenance: normalizeProvenance(record.provenance, "safety-policy"),
  };
}

function normalizeEvent(value: unknown, index: number): TimelineEventView {
  const record = asRecord(value);
  return {
    id: asString(record.id, "event-" + String(index + 1)),
    sequence: asNumber(record.sequence, index + 1) ?? index + 1,
    state: asString(record.state, asString(record.toState, "UNKNOWN")),
    title: asString(record.title, asString(record.eventType, "Event")),
    summary: asString(record.summary, "No event summary reported."),
    occurredAt: asString(
      record.occurredAt,
      asString(record.createdAt, new Date(0).toISOString()),
    ),
    provenance: normalizeProvenance(record.provenance, "orchestrator"),
  };
}

export function normalizeSession(payload: unknown): SessionView {
  const outer = asRecord(payload);
  const nested = asRecord(outer.session);
  const source = Object.keys(nested).length > 0 ? nested : outer;
  const repository = asRecord(source.repository);
  const selectedCandidateId =
    asString(source.selectedCandidateId) || undefined;
  const candidatesValue =
    outer.candidates !== undefined ? outer.candidates : source.candidates;
  const eventsValue = outer.events !== undefined ? outer.events : source.events;
  const approval = asRecord(source.approval);
  const pullRequest = asRecord(source.pullRequest);
  const review = asRecord(source.review);
  const failure = asRecord(source.failure);

  return {
    id: asString(source.id, asString(source.sessionId, "unknown-session")),
    mode: oneOf<SessionMode>(source.mode, modes, "unknown"),
    state: asString(source.state, "IDLE"),
    createdAt: asString(source.createdAt) || undefined,
    updatedAt: asString(source.updatedAt) || undefined,
    repository: {
      repoUrl: asString(repository.repoUrl) || undefined,
      commitSha: asString(repository.commitSha, "unreported"),
    },
    currentCommitSha: asString(
      source.currentCommitSha,
      asString(repository.commitSha, "unreported"),
    ),
    incident: normalizeIncident(
      outer.incident !== undefined ? outer.incident : source.incident,
    ),
    policy: normalizePolicy(
      outer.policy !== undefined ? outer.policy : source.policy,
    ),
    candidates: asArray(candidatesValue).map((candidate, index) =>
      normalizeCandidate(candidate, index, selectedCandidateId),
    ),
    selectedCandidateId,
    currentPatchDigest: asString(source.currentPatchDigest) || undefined,
    currentEvidenceDigest:
      asString(source.currentEvidenceDigest) || undefined,
    approval:
      Object.keys(approval).length === 0
        ? undefined
        : {
            decision: oneOf(
              approval.decision,
              ["approved", "rejected", "changes_requested"] as const,
              "rejected",
            ),
            approverDisplayName:
              asString(approval.approverDisplayName) || undefined,
            evidenceDigest: asString(approval.evidenceDigest, "unreported"),
            bindingDigest: asString(approval.bindingDigest) || undefined,
            invalidatedAt: asString(approval.invalidatedAt) || undefined,
          },
    pullRequest:
      Object.keys(pullRequest).length === 0
        ? undefined
        : {
            number: asNumber(pullRequest.number, 0) ?? 0,
            url: asString(pullRequest.url),
            status: oneOf(
              pullRequest.status,
              ["open", "closed", "merged"] as const,
              "open",
            ),
            provenance: normalizeProvenance(
              pullRequest.provenance,
              "github",
            ),
          },
    review:
      Object.keys(review).length === 0
        ? undefined
        : {
            round: asNumber(review.round, 0) ?? 0,
            status: oneOf(
              review.status,
              ["pending", "blocked", "passed"] as const,
              "pending",
            ),
            headSha: asString(review.headSha) || undefined,
            findings: asArray(review.findings).map((item, index) => {
              const finding = asRecord(item);
              return {
                id: asString(finding.id, `review-finding-${index + 1}`),
                severity: oneOf(
                  finding.severity,
                  ["info", "low", "medium", "high", "critical"] as const,
                  "medium",
                ),
                title: asString(finding.title, "Review finding"),
                body: asString(finding.body, "No finding detail reported."),
                filePath: asString(finding.filePath) || undefined,
                line: asNumber(finding.line) ?? undefined,
                resolved: Boolean(finding.resolved),
                url: asString(finding.url) || undefined,
              };
            }),
            provenance: normalizeProvenance(review.provenance, "coderabbit"),
          },
    failure:
      Object.keys(failure).length === 0
        ? undefined
        : {
            reason: asString(
              failure.reason,
              "The workflow failed without a reported reason.",
            ),
            recoverable: Boolean(failure.recoverable),
            retryAction: asString(failure.retryAction) || undefined,
          },
    events: asArray(eventsValue)
      .map(normalizeEvent)
      .sort((left, right) => left.sequence - right.sequence),
  };
}

function unwrapSessions(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (Array.isArray(record.sessions)) return record.sessions;
  if (Array.isArray(record.data)) return record.data;
  if (record.session !== undefined) return [record.session];
  return Object.keys(record).length > 0 ? [record] : [];
}

async function requestJson(
  input: string,
  init?: RequestInit,
): Promise<unknown | undefined> {
  const response = await fetch(input, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(
      "SafeFlash API " + response.status + " " + response.statusText,
    );
  }

  if (response.status === 204) return undefined;
  return response.json() as Promise<unknown>;
}

export async function listSessions(): Promise<readonly SessionView[]> {
  const payload = await requestJson("/api/sessions");
  return unwrapSessions(payload).map(normalizeSession);
}

export async function getSession(sessionId: string): Promise<SessionView> {
  const payload = await requestJson(
    "/api/sessions/" + encodeURIComponent(sessionId),
  );
  return normalizeSession(payload);
}

export async function createSession(): Promise<SessionView> {
  const payload = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      incidentKind: "battery-sensor-disconnect",
      runKind: "tournament",
    }),
  });
  return normalizeSession(payload);
}

export async function submitSessionDecision(
  session: SessionView,
  decision: DecisionAction,
  reason?: string,
): Promise<SessionView> {
  const payload = await requestJson(
    "/api/sessions/" + encodeURIComponent(session.id) + "/decision",
    {
      method: "POST",
      body: JSON.stringify({
        decision,
        reason,
        candidateId: session.selectedCandidateId,
        evidenceDigest: session.currentEvidenceDigest,
        patchDigest: session.currentPatchDigest,
        commitSha: session.currentCommitSha,
        policyVersion: session.policy.version,
      }),
    },
  );

  return payload === undefined ? getSession(session.id) : normalizeSession(payload);
}

export async function retrySession(sessionId: string): Promise<SessionView> {
  const payload = await requestJson(
    "/api/sessions/" + encodeURIComponent(sessionId) + "/retry",
    { method: "POST" },
  );
  return normalizeSession(payload);
}
