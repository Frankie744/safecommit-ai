import { describe, expect, it } from "vitest";

import {
  ProviderConfigurationError,
  ProviderModeError,
  cachedEnvelope,
  mockEnvelope,
  redactProviderError,
  redactSecrets,
  requireLiveConfiguration,
} from "@safeflash/integrations";

describe("provider provenance and fail-closed configuration", () => {
  it("requires explicit live enablement and every credential", () => {
    expect(() =>
      requireLiveConfiguration(
        "fireworks",
        "live",
        { FIREWORKS_API_KEY: "configured" },
        ["FIREWORKS_API_KEY"],
      ),
    ).toThrow(ProviderConfigurationError);

    expect(() =>
      requireLiveConfiguration(
        "fireworks",
        "live",
        { SAFEFLASH_ALLOW_LIVE: "true" },
        ["FIREWORKS_API_KEY"],
      ),
    ).toThrow(ProviderConfigurationError);

    expect(
      requireLiveConfiguration(
        "fireworks",
        "live",
        {
          SAFEFLASH_ALLOW_LIVE: "true",
          FIREWORKS_API_KEY: "configured",
        },
        ["FIREWORKS_API_KEY"],
      ),
    ).toEqual({ FIREWORKS_API_KEY: "configured" });
  });

  it("never lets a live adapter silently become cached or mock", () => {
    expect(() =>
      requireLiveConfiguration(
        "daytona",
        "cached",
        { SAFEFLASH_ALLOW_LIVE: "true", DAYTONA_API_KEY: "configured" },
        ["DAYTONA_API_KEY"],
      ),
    ).toThrow(ProviderModeError);
    expect(() =>
      requireLiveConfiguration(
        "daytona",
        "mock",
        { SAFEFLASH_ALLOW_LIVE: "true", DAYTONA_API_KEY: "configured" },
        ["DAYTONA_API_KEY"],
      ),
    ).toThrow(ProviderModeError);
  });

  it("requires traceable provenance for replay and mock evidence", () => {
    expect(
      cachedEnvelope("braintrust", { result: "recorded" }, {
        evidenceRef: "artifacts/evidence/live/run-1.json",
        originallyCapturedAt: "2026-07-22T12:00:00.000Z",
        replayedAt: "2026-07-22T13:00:00.000Z",
      }).provenance,
    ).toEqual({
      mode: "cached",
      kind: "recorded-live",
      evidenceRef: "artifacts/evidence/live/run-1.json",
      originallyCapturedAt: "2026-07-22T12:00:00.000Z",
      replayedAt: "2026-07-22T13:00:00.000Z",
    });
    expect(() =>
      cachedEnvelope("braintrust", {}, {
        evidenceRef: "",
        originallyCapturedAt: "2026-07-22T12:00:00.000Z",
      }),
    ).toThrow(ProviderConfigurationError);
    expect(mockEnvelope("github", {}, "fixture-pr-1").provenance).toMatchObject({
      mode: "mock",
      kind: "mock",
      fixtureId: "fixture-pr-1",
    });
    expect(() => mockEnvelope("github", {}, "")).toThrow(
      ProviderConfigurationError,
    );
  });

  it("redacts known secrets and credential-shaped values from errors", () => {
    const secret = "fw_live_super_secret_value";
    const message = [
      `provider rejected ${secret}`,
      "Authorization: Bearer abc.def.ghi",
      "token=github_pat_11AA_secret",
      "api_key:plain-text-value",
      "ghp_abcdefghijklmnopqrstuvwxyz",
    ].join("; ");
    const redacted = redactSecrets(message, { FIREWORKS_API_KEY: secret });
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("github_pat_11AA_secret");
    expect(redacted).not.toContain("plain-text-value");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(redactProviderError(new Error(message), { FIREWORKS_API_KEY: secret }))
      .toBe(redacted);
  });
});
