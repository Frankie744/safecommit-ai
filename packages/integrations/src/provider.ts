import type { OperatingMode } from "@safeflash/domain";

export type ProviderName =
  | "fireworks"
  | "daytona"
  | "braintrust"
  | "github"
  | "coderabbit";

export interface LiveProvenance {
  mode: "live";
  kind: "live";
  capturedAt: string;
}

export interface CachedProvenance {
  mode: "cached";
  kind: "recorded-live";
  evidenceRef: string;
  originallyCapturedAt: string;
  replayedAt: string;
}

export interface MockProvenance {
  mode: "mock";
  kind: "mock";
  fixtureId: string;
  generatedAt: string;
}

export interface LocalTestProvenance {
  mode: "local-test";
  kind: "local-test";
  capturedAt: string;
}

export interface ManualVerifiedProvenance {
  mode: "manual-verified";
  kind: "manual-verified";
  attestedAt: string;
  attestedBy: string;
  evidenceRef: string;
}

export type ProviderProvenance =
  | LiveProvenance
  | CachedProvenance
  | MockProvenance
  | LocalTestProvenance
  | ManualVerifiedProvenance;

export type ProviderTransport = "official-sdk" | "local-test";

export interface ProviderEnvelope<T> {
  provider: ProviderName;
  provenance: ProviderProvenance;
  data: T;
}

type ProviderTransportSource = object & {
  readonly transport: ProviderTransport;
};

// These identities deliberately never cross the package boundary. A caller can
// describe JSON as `provenance.kind = "live"`, but only an adapter backed by a
// transport created in this module graph can mint an envelope accepted by a
// live P0 gate. WeakSets also ensure cloning/serialization strips authority.
const officialTransports = new WeakSet<object>();
const officialLiveEnvelopes = new WeakSet<object>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

export class ProviderConfigurationError extends Error {
  readonly retryable = false;

  constructor(
    readonly provider: ProviderName,
    readonly missingKeys: readonly string[],
    message?: string,
  ) {
    super(
      message ??
        `${provider} live mode is not configured; missing: ${missingKeys.join(", ")}`,
    );
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderModeError extends Error {
  readonly retryable = false;

  constructor(
    readonly provider: ProviderName,
    readonly mode: OperatingMode,
    message?: string,
  ) {
    super(
      message ??
        `${provider} live adapter cannot run in ${mode} mode; use an explicit replay or mock adapter`,
    );
    this.name = "ProviderModeError";
  }
}

export class ProviderResponseError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderResponseError";
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function requireLiveConfiguration<K extends string>(
  provider: ProviderName,
  mode: OperatingMode,
  environment: Environment,
  keys: readonly K[],
): Record<K, string> {
  if (mode !== "live") {
    throw new ProviderModeError(provider, mode);
  }

  if (environment.SAFEFLASH_ALLOW_LIVE !== "true") {
    throw new ProviderConfigurationError(
      provider,
      ["SAFEFLASH_ALLOW_LIVE=true"],
      `${provider} live calls are disabled; set SAFEFLASH_ALLOW_LIVE=true explicitly`,
    );
  }

  const missing = keys.filter((key) => !nonEmpty(environment[key]));
  if (missing.length > 0) {
    throw new ProviderConfigurationError(provider, missing);
  }

  return Object.fromEntries(
    keys.map((key) => [key, environment[key]!.trim()]),
  ) as Record<K, string>;
}

export function localTestEnvelope<T>(
  provider: ProviderName,
  data: T,
  capturedAt = new Date().toISOString(),
): ProviderEnvelope<T> {
  return {
    provider,
    provenance: { mode: "local-test", kind: "local-test", capturedAt },
    data,
  };
}

export function manualVerifiedEnvelope<T>(
  data: T,
  metadata: {
    attestedAt: string;
    attestedBy: string;
    evidenceRef: string;
  },
): ProviderEnvelope<T> {
  if (
    !nonEmpty(metadata.attestedAt) ||
    !nonEmpty(metadata.attestedBy) ||
    !nonEmpty(metadata.evidenceRef)
  ) {
    throw new ProviderConfigurationError(
      "coderabbit",
      ["attestedAt", "attestedBy", "evidenceRef"],
      "Manual verification requires an identified actor, timestamp, and evidence reference",
    );
  }
  return {
    provider: "coderabbit",
    provenance: {
      mode: "manual-verified",
      kind: "manual-verified",
      ...metadata,
    },
    data,
  };
}

/** @internal Register only concrete official SDK transports at construction. */
export function registerOfficialTransport<
  T extends object & { readonly transport: "official-sdk" },
>(transport: T): T {
  officialTransports.add(transport);
  return Object.freeze(transport);
}

/** @internal Mint an identity-bound envelope from an adapter transport. */
export function transportEnvelope<T>(
  provider: ProviderName,
  source: ProviderTransportSource,
  data: T,
  capturedAt = new Date().toISOString(),
): ProviderEnvelope<T> {
  if (source.transport === "local-test") {
    return localTestEnvelope(provider, data, capturedAt);
  }
  if (!officialTransports.has(source)) {
    throw new ProviderResponseError(
      provider,
      "An unregistered transport cannot mint live provider evidence",
      false,
    );
  }
  const authoritativeData = deepFreeze(structuredClone(data));
  const envelope: ProviderEnvelope<T> = Object.freeze({
    provider,
    provenance: Object.freeze({ mode: "live", kind: "live", capturedAt }),
    data: authoritativeData,
  });
  officialLiveEnvelopes.add(envelope);
  return envelope;
}

/** @internal Authority check used by server-only receipt factories. */
export function isOfficialLiveEnvelope<T>(
  envelope: ProviderEnvelope<T>,
): envelope is ProviderEnvelope<T> & { provenance: LiveProvenance } {
  return (
    envelope.provenance.mode === "live" &&
    envelope.provenance.kind === "live" &&
    officialLiveEnvelopes.has(envelope)
  );
}

export function cachedEnvelope<T>(
  provider: ProviderName,
  data: T,
  metadata: {
    evidenceRef: string;
    originallyCapturedAt: string;
    replayedAt?: string;
  },
): ProviderEnvelope<T> {
  if (!nonEmpty(metadata.evidenceRef) || !nonEmpty(metadata.originallyCapturedAt)) {
    throw new ProviderConfigurationError(
      provider,
      ["evidenceRef", "originallyCapturedAt"],
      "Cached provider evidence must point to a recorded live artifact",
    );
  }
  return {
    provider,
    provenance: {
      mode: "cached",
      kind: "recorded-live",
      evidenceRef: metadata.evidenceRef,
      originallyCapturedAt: metadata.originallyCapturedAt,
      replayedAt: metadata.replayedAt ?? new Date().toISOString(),
    },
    data,
  };
}

export function mockEnvelope<T>(
  provider: ProviderName,
  data: T,
  fixtureId: string,
  generatedAt = new Date().toISOString(),
): ProviderEnvelope<T> {
  if (!nonEmpty(fixtureId)) {
    throw new ProviderConfigurationError(
      provider,
      ["fixtureId"],
      "Mock provider evidence must identify its fixture",
    );
  }
  return {
    provider,
    provenance: { mode: "mock", kind: "mock", fixtureId, generatedAt },
    data,
  };
}

const SECRET_NAME_PATTERN =
  /(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL)/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactSecrets(
  value: string,
  environment: Environment = process.env,
): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (
      SECRET_NAME_PATTERN.test(name) &&
      secret !== undefined &&
      secret.length >= 4
    ) {
      redacted = redacted.replace(
        new RegExp(escapeRegExp(secret), "gu"),
        "[REDACTED]",
      );
    }
  }

  return redacted
    .replace(
      /\bsfpa1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED_PUBLISH_AUTHORIZATION]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu, (match) => {
      const separator = match.includes(":") ? ":" : "=";
      return `${match.split(/[:=]/u, 1)[0]}${separator}[REDACTED]`;
    });
}

export function redactProviderError(
  error: unknown,
  environment: Environment = process.env,
): string {
  if (error instanceof Error) return redactSecrets(error.message, environment);
  return "Unknown provider error";
}
