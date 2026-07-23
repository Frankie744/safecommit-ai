import { describe, expect, it } from "vitest";

import {
  PublishAuthorizationError,
  type PublishAuthorizationBinding,
} from "@safeflash/integrations";
import {
  InMemoryPublishAuthorizationReplayStore,
  assertPublishAuthorizationAuthority,
  createTestPublishAuthorizationAuthority,
  mintPublishAuthorization,
  readTestPublishAuthorizationService,
} from "../../packages/integrations/src/publish-authorization";

const SECRET = Buffer.alloc(32, 0x37);

function binding(): PublishAuthorizationBinding {
  return {
    sessionId: "session-publish-1",
    candidateId: "candidate-safe",
    patchDigest: "a".repeat(64),
    evidenceDigest: "b".repeat(64),
    baseCommitSha: "9".repeat(40),
    targetBaseCommitSha: "8".repeat(40),
    commitSha: "c".repeat(40),
    treeSha: "d".repeat(40),
    policyVersion: "battery-safety-v1",
    approvalId: "approval-live-1",
    approverId: "operator-live-1",
    approvalActedAt: "2026-07-22T11:59:00.000Z",
    approvalBindingDigest: "e".repeat(64),
    validationAttestationDigest: "f".repeat(64),
    candidatePublicationDigest: "0".repeat(64),
    headBranch: "safeflash/session-publish-1",
    pullRequestContentDigest: "1".repeat(64),
    target: {
      provider: "github",
      owner: "safeflash-demo",
      repository: "public-firmware",
      baseBranch: "main",
    },
    providerReferences: {
      daytonaSandboxId: "sandbox-live-1",
      daytonaRunId: "run-live-1",
      daytonaEvidenceRef: "daytona://sandbox/sandbox-live-1/runs/run-live-1",
      braintrustProjectId: "project-live-1",
      braintrustExperimentId: "experiment-live-1",
      braintrustExperimentName: "live-1",
      braintrustExperimentRef:
        "https://www.braintrust.dev/app/safeflash/experiments/live-1",
    },
  };
}

function expectAuthorizationCode(
  action: () => unknown,
  code: PublishAuthorizationError["code"],
): void {
  try {
    action();
    throw new Error("Expected publish authorization failure");
  } catch (error) {
    expect(error).toBeInstanceOf(PublishAuthorizationError);
    expect((error as PublishAuthorizationError).code).toBe(code);
  }
}

describe("server-only publish authorization", () => {
  it("binds every publication field and consumes a valid HMAC authorization once", () => {
    const service = createTestPublishAuthorizationAuthority({
      secret: SECRET,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
      nonceSource: () => Buffer.alloc(24, 0x11),
    });
    expect(Object.isFrozen(service)).toBe(true);
    expect(Reflect.set(service, "clock", () => 0)).toBe(false);
    const expected = binding();
    const token = mintPublishAuthorization(service, expected);

    const claims = service.consume(token, expected);
    expect(claims).toMatchObject({
      ...expected,
      schemaVersion: 1,
      purpose: "github-pr-mutation",
      issuedAt: "2026-07-22T12:00:00.000Z",
      expiresAt: "2026-07-22T12:02:00.000Z",
    });
    expect(claims.nonce).toHaveLength(32);
    expectAuthorizationCode(() => service.consume(token, expected), "REPLAYED");
  });

  it("rejects tampering with a constant-time MAC comparison", () => {
    const service = createTestPublishAuthorizationAuthority({ secret: SECRET });
    const expected = binding();
    const token = mintPublishAuthorization(service, expected);
    const [prefix, payload, mac] = token.split(".") as [string, string, string];
    const tamperedMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    const tampered = `${prefix}.${payload}.${tamperedMac}`;

    expectAuthorizationCode(
      () => service.consume(tampered, expected),
      "INVALID_MAC",
    );
    // A failed tamper attempt does not consume the valid one-time capability.
    expect(service.consume(token, expected).sessionId).toBe(expected.sessionId);
  });

  it("rejects changes to every required publication binding before consume", () => {
    const service = createTestPublishAuthorizationAuthority({ secret: SECRET });
    const original = binding();
    const token = mintPublishAuthorization(service, original);
    const mutations: PublishAuthorizationBinding[] = [
      { ...original, sessionId: "session-other" },
      { ...original, candidateId: "candidate-other" },
      { ...original, patchDigest: "2".repeat(64) },
      { ...original, evidenceDigest: "3".repeat(64) },
      { ...original, baseCommitSha: "1".repeat(40) },
      { ...original, targetBaseCommitSha: "2".repeat(40) },
      { ...original, commitSha: "4".repeat(40) },
      { ...original, treeSha: "5".repeat(40) },
      { ...original, policyVersion: "policy-other" },
      { ...original, approvalId: "approval-other" },
      { ...original, approverId: "operator-other" },
      { ...original, approvalActedAt: "2026-07-22T11:58:00.000Z" },
      { ...original, approvalBindingDigest: "6".repeat(64) },
      { ...original, validationAttestationDigest: "7".repeat(64) },
      { ...original, candidatePublicationDigest: "9".repeat(64) },
      { ...original, headBranch: "safeflash/session-other" },
      { ...original, pullRequestContentDigest: "8".repeat(64) },
      {
        ...original,
        target: { ...original.target, owner: "different-owner" },
      },
      {
        ...original,
        target: { ...original.target, repository: "different-repository" },
      },
      {
        ...original,
        target: { ...original.target, baseBranch: "release" },
      },
      {
        ...original,
        providerReferences: {
          ...original.providerReferences,
          daytonaSandboxId: "sandbox-other",
        },
      },
      {
        ...original,
        providerReferences: {
          ...original.providerReferences,
          daytonaEvidenceRef:
            "daytona://sandbox/sandbox-other/runs/run-live-1",
        },
      },
      {
        ...original,
        providerReferences: {
          ...original.providerReferences,
          braintrustExperimentId: "experiment-other",
        },
      },
      {
        ...original,
        providerReferences: {
          ...original.providerReferences,
          braintrustExperimentRef:
            "https://www.braintrust.dev/app/safeflash/experiments/other",
        },
      },
    ];

    for (const mutation of mutations) {
      expectAuthorizationCode(
        () => service.consume(token, mutation),
        "BINDING_MISMATCH",
      );
    }
    expect(service.consume(token, original).candidateId).toBe(
      original.candidateId,
    );
  });

  it("rejects expired and future-issued authorizations", () => {
    let issuerNow = Date.parse("2026-07-22T12:00:00.000Z");
    const replayStore = new InMemoryPublishAuthorizationReplayStore();
    const issuer = createTestPublishAuthorizationAuthority({
      secret: SECRET,
      ttlMs: 1_000,
      clock: () => issuerNow,
      replayStore,
    });
    const expected = binding();
    const expired = mintPublishAuthorization(issuer, expected);
    issuerNow += 1_001;
    expectAuthorizationCode(() => issuer.consume(expired, expected), "EXPIRED");

    const futureIssuer = createTestPublishAuthorizationAuthority({
      secret: SECRET,
      clock: () => Date.parse("2026-07-22T12:01:00.000Z"),
      replayStore,
    });
    const future = mintPublishAuthorization(futureIssuer, expected);
    const earlierConsumer = createTestPublishAuthorizationAuthority({
      secret: SECRET,
      clock: () => Date.parse("2026-07-22T12:00:00.000Z"),
      replayStore,
    });
    expectAuthorizationCode(
      () => earlierConsumer.consume(future, expected),
      "NOT_YET_VALID",
    );
  });

  it("fails closed on weak or malformed server secret configuration", () => {
    expect(() =>
      createTestPublishAuthorizationAuthority({ secret: Buffer.alloc(16) }),
    ).toThrow(PublishAuthorizationError);
    expect(() =>
      readTestPublishAuthorizationService({
        SAFEFLASH_PUBLISH_AUTH_SECRET: Buffer.alloc(31).toString("base64url"),
      }),
    ).toThrow(PublishAuthorizationError);
    expect(() =>
      readTestPublishAuthorizationService({
        SAFEFLASH_PUBLISH_AUTH_SECRET: "not canonical base64url!",
      }),
    ).toThrow(PublishAuthorizationError);

    const testAuthority = createTestPublishAuthorizationAuthority({
      secret: SECRET,
    });
    expectAuthorizationCode(
      () =>
        assertPublishAuthorizationAuthority(testAuthority, {
          transport: "official-sdk",
        }),
      "INVALID_CONFIGURATION",
    );
  });
});
