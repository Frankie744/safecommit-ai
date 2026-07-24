import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SAFETY_POLICY_COMPOSER_FEATURE_FLAG,
  SafetyPolicyComposerFixtureSchema,
  readSafetyPolicyComposerReservation,
} from "@safeflash/domain";

import fixture from "../fixtures/safety-policy-composer.fixture.json";

describe("Safety Policy Composer Phase 8 reservation", () => {
  it("is disabled by default and never advertises conversion", () => {
    expect(readSafetyPolicyComposerReservation({})).toEqual({
      featureFlag: "SAFEFLASH_ENABLE_POLICY_COMPOSER",
      enabled: false,
      implementationStatus: "reserved-not-implemented",
      conversionAvailable: false,
    });
  });

  it("accepts only an explicit true flag while keeping conversion unavailable", () => {
    for (const value of ["1", "yes", "enabled", "false"]) {
      expect(
        readSafetyPolicyComposerReservation({
          [SAFETY_POLICY_COMPOSER_FEATURE_FLAG]: value,
        }).enabled,
      ).toBe(false);
    }

    expect(
      readSafetyPolicyComposerReservation({
        [SAFETY_POLICY_COMPOSER_FEATURE_FLAG]: " TRUE ",
      }),
    ).toMatchObject({
      enabled: true,
      implementationStatus: "reserved-not-implemented",
      conversionAvailable: false,
    });
  });

  it("validates the structured test fixture and rejects unreserved input fields", () => {
    expect(SafetyPolicyComposerFixtureSchema.parse(fixture)).toEqual(fixture);
    expect(() =>
      SafetyPolicyComposerFixtureSchema.parse({
        ...fixture,
        naturalLanguagePrompt: "change the safety policy",
      }),
    ).toThrow();
  });

  it("renders only an honest empty state with no policy conversion form", () => {
    const source = readFileSync(
      new URL(
        "../../apps/web/app/policy-composer/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const compactSource = source.replace(/\s+/gu, " ");
    expect(compactSource).toContain("Safety Policy Composer");
    expect(compactSource).toContain("NOT IMPLEMENTED");
    expect(compactSource).toContain(
      "cannot change the certified safety policy",
    );
    expect(source).not.toContain("<form");
    expect(source).not.toContain("<textarea");
  });
});
