import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { canonicalJson, computeEvidenceDigest } from "./evidence";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const ISO_TIMESTAMP = z
  .string()
  .max(64)
  .regex(ISO_TIMESTAMP_PATTERN)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid ISO timestamp");
const SAFE_IDENTIFIER = z.string().trim().min(1).max(512);
const SAFE_TEXT = z.string().max(4_096);
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const GIT_SHA = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const HTTPS_URL = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash.length <= 512
    );
  }, "Recorded-live URLs must be credential-free HTTPS URLs");
const EVIDENCE_STATUS = z.enum([
  "passed",
  "failed",
  "running",
  "pending",
  "not-run",
]);

export const RECORDED_LIVE_PROVIDER_NAMES = [
  "fireworks",
  "daytona",
  "braintrust",
  "github",
  "coderabbit",
] as const;

export type RecordedLiveProviderName =
  (typeof RECORDED_LIVE_PROVIDER_NAMES)[number];

const REQUIRED_RESOURCE_KINDS: Readonly<
  Record<RecordedLiveProviderName, readonly string[]>
> = Object.freeze({
  fireworks: Object.freeze(["response"]),
  daytona: Object.freeze(["sandbox", "run"]),
  braintrust: Object.freeze([
    "dataset",
    "experiment",
    "trace",
    "eval-result",
  ]),
  github: Object.freeze([
    "repository",
    "pull-request",
    "base-sha",
    "head-sha",
  ]),
  coderabbit: Object.freeze(["pull-request", "head-sha", "review"]),
});

const RecordedLiveResourceSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    id: SAFE_IDENTIFIER,
    url: HTTPS_URL.optional(),
  })
  .strict();

const LiveProviderCaptureSchema = z
  .object({
    provider: z.enum(RECORDED_LIVE_PROVIDER_NAMES),
    provenance: z
      .object({
        mode: z.literal("live"),
        kind: z.literal("live"),
        verified: z.literal(true),
      })
      .strict(),
    requestIds: z.array(SAFE_IDENTIFIER).max(256).default([]),
    resources: z.array(RecordedLiveResourceSchema).min(1).max(256),
    capturedAt: ISO_TIMESTAMP,
    durationMs: z.number().int().nonnegative().max(86_400_000),
    cleanup: z
      .object({
        status: z.literal("deleted"),
        resourceIds: z.array(SAFE_IDENTIFIER).min(1).max(128),
        completedAt: ISO_TIMESTAMP,
      })
      .strict()
      .optional(),
  })
  .strict();

const RecordedLiveEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    offsetMs: z.number().int().nonnegative().max(86_400_000),
    durationMs: z.number().int().nonnegative().max(86_400_000),
    state: SAFE_IDENTIFIER,
    title: SAFE_TEXT,
    summary: SAFE_TEXT,
    provider: z
      .enum([...RECORDED_LIVE_PROVIDER_NAMES, "safeflash-orchestrator"])
      .optional(),
    resourceRefs: z.array(RecordedLiveResourceSchema).max(64).default([]),
  })
  .strict();

const EvidenceSnapshotSchema = z
  .object({
    status: EVIDENCE_STATUS,
    summary: SAFE_TEXT,
    exitCode: z.number().int().nullable().optional(),
    artifactHash: SHA256.optional(),
  })
  .strict();

const CandidateSnapshotSchema = z
  .object({
    id: SAFE_IDENTIFIER,
    label: SAFE_TEXT,
    strategy: SAFE_TEXT,
    hypothesis: SAFE_TEXT.optional(),
    validationRound: z.number().int().positive().optional(),
    selected: z.boolean(),
    eliminatedReason: SAFE_TEXT.optional(),
    generation: z
      .object({
        model: SAFE_IDENTIFIER.optional(),
        profile: SAFE_IDENTIFIER.optional(),
        patchDigest: SHA256.optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        id: SAFE_IDENTIFIER,
        status: SAFE_IDENTIFIER,
        isolated: z.literal(true),
      })
      .strict(),
    build: EvidenceSnapshotSchema,
    tests: EvidenceSnapshotSchema.extend({
      passed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }).strict(),
    safetyGate: EvidenceSnapshotSchema.extend({
      hardGatePassed: z.boolean(),
      failures: z.array(SAFE_TEXT).max(128),
    }).strict(),
    score: z
      .object({
        weighted: z.number().finite().min(0),
        eligible: z.boolean(),
        experimentId: SAFE_IDENTIFIER.optional(),
        traceId: SAFE_IDENTIFIER.optional(),
        resultId: SAFE_IDENTIFIER,
      })
      .strict(),
  })
  .strict();

const RecordedLiveSessionSnapshotSchema = z
  .object({
    id: SAFE_IDENTIFIER,
    mode: z.literal("live"),
    state: SAFE_IDENTIFIER,
    scenarioId: z.enum(["happy-path", "unsafe-high-score"]),
    createdAt: ISO_TIMESTAMP,
    updatedAt: ISO_TIMESTAMP,
    repository: z
      .object({
        repoUrl: HTTPS_URL,
        baseCommitSha: GIT_SHA,
        headCommitSha: GIT_SHA,
      })
      .strict(),
    incident: z
      .object({
        title: SAFE_TEXT,
        summary: SAFE_TEXT,
        severity: z.enum(["low", "medium", "high", "critical"]),
        temperatureC: z.number().finite().nullable(),
        sensorFault: z.boolean(),
        chargingEnabled: z.boolean(),
        lastUpdatedCycles: z.number().int().nonnegative().optional(),
        evidence: z.array(SAFE_TEXT).max(128),
      })
      .strict(),
    policy: z
      .object({
        name: SAFE_TEXT,
        version: SAFE_IDENTIFIER,
        invariants: z
          .array(
            z
              .object({
                id: SAFE_IDENTIFIER,
                description: SAFE_TEXT,
                hardGate: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(128),
      })
      .strict(),
    candidates: z.array(CandidateSnapshotSchema).min(1).max(16),
    selectedCandidateId: SAFE_IDENTIFIER,
    currentPatchDigest: SHA256,
    currentEvidenceDigest: SHA256,
    approval: z
      .object({
        decision: z.literal("approved"),
        evidenceDigest: SHA256,
        bindingDigest: SHA256,
      })
      .strict(),
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        url: HTTPS_URL,
        status: z.literal("open"),
      })
      .strict(),
    review: z
      .object({
        round: z.number().int().positive(),
        status: z.literal("passed"),
        headSha: GIT_SHA,
      })
      .strict(),
  })
  .strict();

export const RecordedLiveCaptureInputSchema = z
  .object({
    runId: SAFE_IDENTIFIER,
    capturedAt: ISO_TIMESTAMP,
    completedAt: ISO_TIMESTAMP,
    session: RecordedLiveSessionSnapshotSchema,
    providers: z.array(LiveProviderCaptureSchema).length(
      RECORDED_LIVE_PROVIDER_NAMES.length,
    ),
    events: z.array(RecordedLiveEventSchema).min(1).max(4_096),
  })
  .strict();

const RecordedLiveAttestationSchema = z
  .object({
    algorithm: z.literal("HMAC-SHA256"),
    keyId: z.string().regex(/^[0-9a-f]{24}$/u),
    signature: SHA256,
  })
  .strict();

const RecordedLiveArtifactSchema = RecordedLiveCaptureInputSchema.extend({
  schemaVersion: z.literal(2),
  kind: z.literal("safeflash-recorded-live-run"),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  digest: SHA256,
  attestation: RecordedLiveAttestationSchema,
}).strict();

export type RecordedLiveCaptureInput = z.infer<
  typeof RecordedLiveCaptureInputSchema
>;
export type RecordedLiveArtifact = z.infer<typeof RecordedLiveArtifactSchema>;
export type RecordedLiveSessionSnapshot = z.infer<
  typeof RecordedLiveSessionSnapshotSchema
>;

const FORBIDDEN_FIELD_PATTERN =
  /(?:authorization|cookie|password|secret|token|credential|api[_-]?key|headers?|raw(?:request|response)|(?:request|response)body|environment|stdout|stderr)/iu;
const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  /\bAuthorization\s*:/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/iu,
  /\bgithub_pat_[A-Za-z0-9_]+\b/u,
  /\bgh[pousr]_[A-Za-z0-9]+\b/u,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/iu,
]);

function assertNoSensitiveMaterial(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): void {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`Recorded-live capture contains sensitive material at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new Error("Recorded-live capture contains a circular reference");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveMaterial(item, `${path}[${index}]`, seen),
    );
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_FIELD_PATTERN.test(key)) {
        throw new Error(`Recorded-live capture contains forbidden field ${path}.${key}`);
      }
      assertNoSensitiveMaterial(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function resourceIds(
  provider: z.infer<typeof LiveProviderCaptureSchema>,
  kind: string,
): readonly string[] {
  return provider.resources
    .filter((resource) => resource.kind === kind)
    .map((resource) => resource.id);
}

function assertCompleteProviders(
  providers: readonly z.infer<typeof LiveProviderCaptureSchema>[],
): void {
  const byName = new Map(
    providers.map((provider) => [provider.provider, provider] as const),
  );
  if (byName.size !== RECORDED_LIVE_PROVIDER_NAMES.length) {
    throw new Error("Recorded-live capture requires each provider exactly once");
  }
  for (const name of RECORDED_LIVE_PROVIDER_NAMES) {
    const provider = byName.get(name);
    if (provider === undefined) {
      throw new Error(`Recorded-live capture is missing ${name}`);
    }
    const kinds = new Set(provider.resources.map((resource) => resource.kind));
    const resources = new Set(
      provider.resources.map((resource) => `${resource.kind}:${resource.id}`),
    );
    if (
      resources.size !== provider.resources.length ||
      new Set(provider.requestIds).size !== provider.requestIds.length
    ) {
      throw new Error(
        `Recorded-live ${name} evidence contains duplicate request or resource IDs`,
      );
    }
    for (const required of REQUIRED_RESOURCE_KINDS[name]) {
      if (!kinds.has(required)) {
        throw new Error(
          `Recorded-live ${name} evidence is missing ${required} resource IDs`,
        );
      }
    }
    if (name === "fireworks" && provider.requestIds.length === 0) {
      throw new Error(
        "Recorded-live Fireworks evidence requires real provider request IDs",
      );
    }
  }

  const daytona = byName.get("daytona")!;
  const sandboxIds = resourceIds(daytona, "sandbox");
  const runIds = resourceIds(daytona, "run");
  if (
    runIds.length < sandboxIds.length ||
    daytona.cleanup === undefined ||
    daytona.cleanup.resourceIds.length !== sandboxIds.length ||
    new Set(daytona.cleanup.resourceIds).size !== sandboxIds.length ||
    sandboxIds.some((id) => !daytona.cleanup!.resourceIds.includes(id))
  ) {
    throw new Error(
      "Recorded-live Daytona evidence must prove deletion of every sandbox",
    );
  }
}

function assertSessionBindings(input: RecordedLiveCaptureInput): void {
  const { session } = input;
  const selected = session.candidates.filter((candidate) => candidate.selected);
  const candidateIds = new Set(
    session.candidates.map((candidate) => candidate.id),
  );
  const candidateSandboxIds = new Set(
    session.candidates.map((candidate) => candidate.sandbox.id),
  );
  if (
    session.state !== "READY_TO_MERGE" ||
    candidateIds.size !== session.candidates.length ||
    candidateSandboxIds.size !== session.candidates.length ||
    selected.length !== 1 ||
    selected[0]?.id !== session.selectedCandidateId ||
    selected[0].score.eligible !== true ||
    selected[0].safetyGate.hardGatePassed !== true
  ) {
    throw new Error(
      "Recorded-live session must bind exactly one eligible hard-gate winner",
    );
  }
  const selectedScore = selected[0].score.weighted;
  const unsafeHigherScore = session.candidates.some(
    (candidate) =>
      !candidate.score.eligible && candidate.score.weighted > selectedScore,
  );
  if (
    (session.scenarioId === "unsafe-high-score" && !unsafeHigherScore) ||
    (session.scenarioId === "happy-path" && unsafeHigherScore)
  ) {
    throw new Error(
      "Recorded-live scenario must match the captured candidate evidence",
    );
  }
  if (
    session.approval.evidenceDigest !== session.currentEvidenceDigest ||
    session.review.headSha !== session.repository.headCommitSha
  ) {
    throw new Error(
      "Recorded-live approval and review must bind the exact evidence and head",
    );
  }

  const providers = new Map(
    input.providers.map((provider) => [provider.provider, provider] as const),
  );
  const github = providers.get("github")!;
  const coderabbit = providers.get("coderabbit")!;
  const daytona = providers.get("daytona")!;
  const braintrust = providers.get("braintrust")!;
  const pullNumber = String(session.pullRequest.number);
  const headSha = session.repository.headCommitSha;
  const baseSha = session.repository.baseCommitSha;
  const repositoryId = new URL(session.repository.repoUrl).pathname
    .replace(/^\/+/u, "")
    .replace(/\.git$/u, "");
  if (
    !resourceIds(github, "repository").includes(repositoryId) ||
    !resourceIds(github, "pull-request").includes(pullNumber) ||
    !resourceIds(coderabbit, "pull-request").includes(pullNumber) ||
    !resourceIds(github, "head-sha").includes(headSha) ||
    !resourceIds(coderabbit, "head-sha").includes(headSha) ||
    !resourceIds(github, "base-sha").includes(baseSha)
  ) {
    throw new Error(
      "Recorded-live GitHub and CodeRabbit evidence must bind the exact PR/base/head",
    );
  }
  const experimentIds = new Set(resourceIds(braintrust, "experiment"));
  const traceIds = new Set(resourceIds(braintrust, "trace"));
  const evalResultIds = new Set(resourceIds(braintrust, "eval-result"));
  if (
    session.candidates.some(
      (candidate) =>
        (candidate.score.experimentId !== undefined &&
          !experimentIds.has(candidate.score.experimentId)) ||
        (candidate.score.traceId !== undefined &&
          !traceIds.has(candidate.score.traceId)) ||
        !evalResultIds.has(candidate.score.resultId),
    )
  ) {
    throw new Error(
      "Recorded-live candidate scores must bind captured Braintrust Eval result IDs",
    );
  }
  const sandboxIds = new Set(resourceIds(daytona, "sandbox"));
  if (session.candidates.some((candidate) => !sandboxIds.has(candidate.sandbox.id))) {
    throw new Error(
      "Recorded-live candidates must bind to captured Daytona sandbox IDs",
    );
  }
}

function assertEventSequence(
  input: RecordedLiveCaptureInput,
  durationMs: number,
): void {
  const resources = new Set(
    input.providers.flatMap((provider) =>
      provider.resources.map(
        (resource) => `${provider.provider}:${resource.kind}:${resource.id}`,
      ),
    ),
  );
  let previousOffset = -1;
  for (const [index, event] of input.events.entries()) {
    if (
      event.sequence !== index + 1 ||
      event.offsetMs < previousOffset ||
      event.offsetMs + event.durationMs > durationMs
    ) {
      throw new Error(
        "Recorded-live events must be contiguous, monotonic, and within the run",
      );
    }
    previousOffset = event.offsetMs;
    if (event.provider && event.provider !== "safeflash-orchestrator") {
      for (const resource of event.resourceRefs) {
        if (
          !resources.has(`${event.provider}:${resource.kind}:${resource.id}`)
        ) {
          throw new Error(
            "Recorded-live event references an unknown provider resource ID",
          );
        }
      }
    } else if (event.resourceRefs.length > 0) {
      throw new Error(
        "Recorded-live orchestrator events cannot claim provider resources",
      );
    }
  }
}

function validateCapture(input: RecordedLiveCaptureInput): number {
  assertNoSensitiveMaterial(input);
  assertCompleteProviders(input.providers);
  assertSessionBindings(input);
  const started = Date.parse(input.capturedAt);
  const completed = Date.parse(input.completedAt);
  if (completed < started) {
    throw new Error("Recorded-live completion precedes capture");
  }
  const durationMs = completed - started;
  for (const provider of input.providers) {
    const providerAt = Date.parse(provider.capturedAt);
    if (
      providerAt < started ||
      providerAt > completed ||
      provider.durationMs > durationMs
    ) {
      throw new Error(
        "Recorded-live provider timing must remain within the captured run",
      );
    }
    if (provider.cleanup !== undefined) {
      const cleanupAt = Date.parse(provider.cleanup.completedAt);
      if (cleanupAt < started || cleanupAt > completed) {
        throw new Error(
          "Recorded-live cleanup timing must remain within the captured run",
        );
      }
    }
  }
  assertEventSequence(input, durationMs);
  return durationMs;
}

function artifactEvidence(
  artifact: Omit<RecordedLiveArtifact, "digest" | "attestation">,
): Omit<RecordedLiveArtifact, "digest" | "attestation"> {
  return artifact;
}

function signingKeyBytes(signingKey: string): Buffer {
  if (
    signingKey !== signingKey.trim() ||
    signingKey.length < 32 ||
    signingKey.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(signingKey)
  ) {
    throw new Error(
      "Recorded-live signing key must be a trimmed server secret of at least 32 characters",
    );
  }
  return Buffer.from(signingKey, "utf8");
}

function attestationFor(
  digest: string,
  signingKey: string,
): RecordedLiveArtifact["attestation"] {
  const key = signingKeyBytes(signingKey);
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const signature = createHmac("sha256", key)
    .update(
      canonicalJson({
        domain: "safeflash-recorded-live-v2",
        digest,
        keyId,
      }),
    )
    .digest("hex");
  return {
    algorithm: "HMAC-SHA256",
    keyId,
    signature,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

export function createRecordedLiveArtifact(
  value: RecordedLiveCaptureInput,
  signingKey: string,
): RecordedLiveArtifact {
  const input = RecordedLiveCaptureInputSchema.parse(value);
  const durationMs = validateCapture(input);
  const evidence = artifactEvidence({
    schemaVersion: 2,
    kind: "safeflash-recorded-live-run",
    durationMs,
    ...input,
  });
  const digest = computeEvidenceDigest(evidence);
  return deepFreeze({
    ...evidence,
    digest,
    attestation: attestationFor(digest, signingKey),
  });
}

export function parseRecordedLiveArtifact(
  value: unknown,
  signingKey: string,
): RecordedLiveArtifact {
  const artifact = RecordedLiveArtifactSchema.parse(value);
  const { digest, attestation, ...evidence } = artifact;
  if (computeEvidenceDigest(artifactEvidence(evidence)) !== digest) {
    throw new Error("Recorded-live artifact digest mismatch");
  }
  const expected = attestationFor(digest, signingKey);
  const observedSignature = Buffer.from(attestation.signature, "hex");
  const expectedSignature = Buffer.from(expected.signature, "hex");
  if (
    attestation.keyId !== expected.keyId ||
    observedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(observedSignature, expectedSignature)
  ) {
    throw new Error("Recorded-live capture attestation mismatch");
  }
  validateCapture(artifact);
  return deepFreeze(structuredClone(artifact));
}

export function serializeRecordedLiveArtifact(
  artifact: RecordedLiveArtifact,
  signingKey: string,
): string {
  return canonicalJson(parseRecordedLiveArtifact(artifact, signingKey)) + "\n";
}
