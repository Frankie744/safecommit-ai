import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const TOKEN_PREFIX = "sfpa1";
const DEFAULT_TTL_MS = 120_000;
const MAX_TTL_MS = 600_000;
const CLOCK_SKEW_MS = 5_000;

const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), "Identifier must be trimmed");

const bindingShape = {
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
  candidateId: IdentifierSchema,
  patchDigest: Sha256Schema,
  evidenceDigest: Sha256Schema,
  baseCommitSha: GitObjectIdSchema,
  targetBaseCommitSha: GitObjectIdSchema,
  commitSha: GitObjectIdSchema,
  treeSha: GitObjectIdSchema,
  policyVersion: IdentifierSchema,
  approvalId: IdentifierSchema,
  approverId: IdentifierSchema,
  approvalActedAt: z.string().min(1).max(64),
  approvalBindingDigest: Sha256Schema,
  validationAttestationDigest: Sha256Schema,
  candidatePublicationDigest: Sha256Schema,
  headBranch: z.string().regex(/^safeflash\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
  pullRequestContentDigest: Sha256Schema,
  target: z
    .object({
      provider: z.literal("github"),
      owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u),
      repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
      baseBranch: IdentifierSchema,
    })
    .strict(),
  providerReferences: z
    .object({
      daytonaSandboxId: IdentifierSchema,
      daytonaRunId: IdentifierSchema,
      daytonaEvidenceRef: z.string().startsWith("daytona://sandbox/"),
      braintrustProjectId: IdentifierSchema,
      braintrustExperimentId: IdentifierSchema,
      braintrustExperimentName: IdentifierSchema,
      braintrustExperimentRef: z.string().url().startsWith("https://"),
    })
    .strict(),
} as const;

const PublishAuthorizationBindingSchema = z
  .object(bindingShape)
  .strict();

const PublishAuthorizationClaimsSchema = z
  .object({
    ...bindingShape,
    schemaVersion: z.literal(1),
    purpose: z.literal("github-pr-mutation"),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/u),
    issuedAt: z.string().min(1).max(64),
    expiresAt: z.string().min(1).max(64),
  })
  .strict();

export type PublishAuthorizationBinding = z.infer<
  typeof PublishAuthorizationBindingSchema
>;
export type PublishAuthorizationClaims = z.infer<
  typeof PublishAuthorizationClaimsSchema
>;

export type PublishAuthorizationErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_BINDING"
  | "MALFORMED_TOKEN"
  | "INVALID_MAC"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "BINDING_MISMATCH"
  | "REPLAYED"
  | "REPLAY_STORE_FAILURE";

export class PublishAuthorizationError extends Error {
  constructor(
    public readonly code: PublishAuthorizationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublishAuthorizationError";
  }
}

export interface PublishAuthorizationConsumer {
  consume(
    token: string,
    expectedBinding: PublishAuthorizationBinding,
  ): PublishAuthorizationClaims;
}

const publishAuthorizationAuthorityBrand: unique symbol = Symbol(
  "SafeFlashPublishAuthorizationAuthority",
);
const productionAuthorities = new WeakSet<object>();
const testAuthorities = new WeakSet<object>();

export interface PublishAuthorizationAuthority
  extends PublishAuthorizationConsumer {
  readonly [publishAuthorizationAuthorityBrand]: true;
}

export interface PublishAuthorizationReplayStore {
  /** Atomically returns true once for a nonce and false for every replay. */
  consume(nonce: string, expiresAtMs: number, nowMs: number): boolean;
}

export class InMemoryPublishAuthorizationReplayStore
  implements PublishAuthorizationReplayStore
{
  private readonly consumed = new Map<string, number>();

  consume(nonce: string, expiresAtMs: number, nowMs: number): boolean {
    void nowMs;
    if (this.consumed.has(nonce)) return false;
    this.consumed.set(nonce, expiresAtMs);
    return true;
  }
}

/**
 * Cross-process replay store for the server deployment. Exclusive file create
 * is the atomic consume operation; only a SHA-256 nonce digest reaches a path.
 */
export class FilePublishAuthorizationReplayStore
  implements PublishAuthorizationReplayStore
{
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  consume(nonce: string, expiresAtMs: number): boolean {
    const nonceDigest = createHash("sha256").update(nonce, "utf8").digest("hex");
    const path = resolve(this.directory, `${nonceDigest}.used`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${expiresAtMs}\n`, { encoding: "utf8" });
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return false;
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

interface PublishAuthorizationServiceOptions {
  secret: Uint8Array;
  replayStore?: PublishAuthorizationReplayStore;
  ttlMs?: number;
  clock?: () => number;
  nonceSource?: () => Uint8Array;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Value is not canonical JSON");
}

function bindingFromClaims(
  claims: PublishAuthorizationClaims,
): PublishAuthorizationBinding {
  const {
    schemaVersion: _schemaVersion,
    purpose: _purpose,
    nonce: _nonce,
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    ...binding
  } = claims;
  return binding;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const comparable =
    leftBuffer.length === rightBuffer.length
      ? rightBuffer
      : Buffer.alloc(leftBuffer.length);
  return timingSafeEqual(leftBuffer, comparable) &&
    leftBuffer.length === rightBuffer.length;
}

function constantTimeBindingEqual(
  left: PublishAuthorizationBinding,
  right: PublishAuthorizationBinding,
): boolean {
  const leftDigest = createHash("sha256")
    .update(canonicalJson(left), "utf8")
    .digest();
  const rightDigest = createHash("sha256")
    .update(canonicalJson(right), "utf8")
    .digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function computePullRequestContentDigest(content: {
  title: string;
  body: string;
  headBranch: string;
  draft: boolean;
}): string {
  return createHash("sha256")
    .update(canonicalJson(content), "utf8")
    .digest("hex");
}

class HmacPublishAuthorizationAuthority
  implements PublishAuthorizationAuthority
{
  readonly [publishAuthorizationAuthorityBrand] = true as const;
  private readonly secret: Buffer;
  private readonly replayStore: PublishAuthorizationReplayStore;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly nonceSource: () => Uint8Array;

  constructor(options: PublishAuthorizationServiceOptions) {
    this.secret = Buffer.from(options.secret);
    this.replayStore =
      options.replayStore ?? new InMemoryPublishAuthorizationReplayStore();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock ?? Date.now;
    this.nonceSource = options.nonceSource ?? (() => randomBytes(24));
    if (
      this.secret.byteLength < 32 ||
      this.secret.byteLength > 128 ||
      !Number.isInteger(this.ttlMs) ||
      this.ttlMs < 1_000 ||
      this.ttlMs > MAX_TTL_MS
    ) {
      throw new PublishAuthorizationError(
        "INVALID_CONFIGURATION",
        "Publish authorization requires 32-128 secret bytes and a 1-600 second TTL",
      );
    }
  }

  issue(bindingInput: PublishAuthorizationBinding): string {
    const parsed = PublishAuthorizationBindingSchema.safeParse(bindingInput);
    if (!parsed.success) {
      throw new PublishAuthorizationError(
        "INVALID_BINDING",
        "Publish authorization binding failed strict validation",
      );
    }
    const now = this.clock();
    const nonceBytes = Buffer.from(this.nonceSource());
    if (nonceBytes.byteLength < 16) {
      throw new PublishAuthorizationError(
        "INVALID_CONFIGURATION",
        "Publish authorization nonce source must provide at least 128 bits",
      );
    }
    const claims: PublishAuthorizationClaims = {
      ...parsed.data,
      schemaVersion: 1,
      purpose: "github-pr-mutation",
      nonce: nonceBytes.toString("base64url"),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    const payload = Buffer.from(canonicalJson(claims), "utf8").toString(
      "base64url",
    );
    const authenticated = `${TOKEN_PREFIX}.${payload}`;
    const mac = createHmac("sha256", this.secret)
      .update(authenticated, "utf8")
      .digest("base64url");
    return `${authenticated}.${mac}`;
  }

  consume(
    token: string,
    expectedBindingInput: PublishAuthorizationBinding,
  ): PublishAuthorizationClaims {
    const expectedBinding = PublishAuthorizationBindingSchema.safeParse(
      expectedBindingInput,
    );
    if (!expectedBinding.success) {
      throw new PublishAuthorizationError(
        "INVALID_BINDING",
        "Expected publish authorization binding failed strict validation",
      );
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      throw new PublishAuthorizationError(
        "MALFORMED_TOKEN",
        "Publish authorization token is malformed",
      );
    }
    const [prefix, payloadText, macText] = parts as [string, string, string];
    let suppliedMac: Buffer;
    try {
      suppliedMac = Buffer.from(macText, "base64url");
      if (suppliedMac.toString("base64url") !== macText) throw new Error();
    } catch {
      throw new PublishAuthorizationError(
        "MALFORMED_TOKEN",
        "Publish authorization MAC is malformed",
      );
    }
    const expectedMac = createHmac("sha256", this.secret)
      .update(`${prefix}.${payloadText}`, "utf8")
      .digest();
    if (!constantTimeEqual(expectedMac, suppliedMac)) {
      throw new PublishAuthorizationError(
        "INVALID_MAC",
        "Publish authorization MAC verification failed",
      );
    }

    let claims: PublishAuthorizationClaims;
    try {
      const payload = Buffer.from(payloadText, "base64url");
      if (payload.toString("base64url") !== payloadText) throw new Error();
      const decoded: unknown = JSON.parse(payload.toString("utf8"));
      claims = PublishAuthorizationClaimsSchema.parse(decoded);
    } catch (error) {
      throw new PublishAuthorizationError(
        "MALFORMED_TOKEN",
        "Publish authorization claims failed strict validation",
        { cause: error },
      );
    }

    const now = this.clock();
    const issuedAt = Date.parse(claims.issuedAt);
    const expiresAt = Date.parse(claims.expiresAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > this.ttlMs
    ) {
      throw new PublishAuthorizationError(
        "MALFORMED_TOKEN",
        "Publish authorization lifetime is invalid",
      );
    }
    if (issuedAt > now + CLOCK_SKEW_MS) {
      throw new PublishAuthorizationError(
        "NOT_YET_VALID",
        "Publish authorization was issued in the future",
      );
    }
    if (expiresAt <= now) {
      throw new PublishAuthorizationError(
        "EXPIRED",
        "Publish authorization has expired",
      );
    }
    if (
      !constantTimeBindingEqual(
        bindingFromClaims(claims),
        expectedBinding.data,
      )
    ) {
      throw new PublishAuthorizationError(
        "BINDING_MISMATCH",
        "Publish authorization does not match the requested PR mutation",
      );
    }
    try {
      if (!this.replayStore.consume(claims.nonce, expiresAt, now)) {
        throw new PublishAuthorizationError(
          "REPLAYED",
          "Publish authorization was already consumed",
        );
      }
    } catch (error) {
      if (error instanceof PublishAuthorizationError) throw error;
      throw new PublishAuthorizationError(
        "REPLAY_STORE_FAILURE",
        "Publish authorization replay store failed closed",
        { cause: error },
      );
    }
    return claims;
  }
}

/** @internal Used by the GitHub server boundary after authoritative validation. */
export function mintPublishAuthorization(
  authority: PublishAuthorizationAuthority,
  binding: PublishAuthorizationBinding,
): string {
  if (
    !productionAuthorities.has(authority) &&
    !testAuthorities.has(authority)
  ) {
    throw new PublishAuthorizationError(
      "INVALID_CONFIGURATION",
      "Unregistered code cannot mint a SafeFlash publish authorization",
    );
  }
  return (authority as HmacPublishAuthorizationAuthority).issue(binding);
}

/** @internal Enforces that live transports use only the environment authority. */
export function assertPublishAuthorizationAuthority(
  authority: PublishAuthorizationAuthority,
  source: { readonly transport: "official-sdk" | "local-test" },
): void {
  const allowed =
    productionAuthorities.has(authority) ||
    (source.transport === "local-test" && testAuthorities.has(authority));
  if (!allowed) {
    throw new PublishAuthorizationError(
      "INVALID_CONFIGURATION",
      "GitHub mutation requires the registered server-only publish authority",
    );
  }
}

/** @internal Test seam. Intentionally omitted from the package barrel. */
export function createTestPublishAuthorizationAuthority(
  options: PublishAuthorizationServiceOptions,
): PublishAuthorizationAuthority {
  const authority = new HmacPublishAuthorizationAuthority(options);
  Object.freeze(authority);
  testAuthorities.add(authority);
  return authority;
}

export type PublishAuthorizationEnvironment = Readonly<
  Record<string, string | undefined>
>;

function readPublishAuthorizationServiceFromEnvironment(
  environment: PublishAuthorizationEnvironment,
): PublishAuthorizationAuthority {
  const encodedSecret = environment.SAFEFLASH_PUBLISH_AUTH_SECRET?.trim() ?? "";
  let secret: Buffer;
  try {
    secret = Buffer.from(encodedSecret, "base64url");
    if (
      secret.byteLength < 32 ||
      secret.byteLength > 128 ||
      secret.toString("base64url") !== encodedSecret
    ) {
      throw new Error();
    }
  } catch {
    throw new PublishAuthorizationError(
      "INVALID_CONFIGURATION",
      "SAFEFLASH_PUBLISH_AUTH_SECRET must be canonical base64url for 32-128 random bytes",
    );
  }
  const ttlMs = Number(
    environment.SAFEFLASH_PUBLISH_AUTH_TTL_MS ?? DEFAULT_TTL_MS,
  );
  const replayDirectory =
    environment.SAFEFLASH_PUBLISH_AUTH_REPLAY_DIR?.trim() ||
    ".safeflash/publish-authorization-replay";
  const authority = new HmacPublishAuthorizationAuthority({
    secret,
    ttlMs,
    replayStore: new FilePublishAuthorizationReplayStore(replayDirectory),
  });
  Object.freeze(authority);
  productionAuthorities.add(authority);
  return authority;
}

/** Public production factory: configuration is always server process state. */
export function readPublishAuthorizationService(): PublishAuthorizationAuthority {
  return readPublishAuthorizationServiceFromEnvironment(process.env);
}

/** @internal Configuration parser seam. Intentionally omitted from the barrel. */
export function readTestPublishAuthorizationService(
  environment: PublishAuthorizationEnvironment,
): PublishAuthorizationAuthority {
  return readPublishAuthorizationServiceFromEnvironment(environment);
}
