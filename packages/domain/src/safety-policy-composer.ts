import { z } from "zod";

/**
 * Phase 8 reserves the product surface without implementing policy generation.
 * Enabling the flag only reveals the empty state; it does not enable conversion.
 */
export const SAFETY_POLICY_COMPOSER_FEATURE_FLAG =
  "SAFEFLASH_ENABLE_POLICY_COMPOSER" as const;

export const SafetyPolicyComposerInvariantFixtureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    enforcement: z.literal("hard-gate"),
  })
  .strict();

export const SafetyPolicyComposerFixtureSchema = z
  .object({
    fixtureVersion: z.literal(1),
    id: z.string().min(1),
    displayName: z.string().min(1),
    provenance: z.literal("test-fixture"),
    invariants: z
      .array(SafetyPolicyComposerInvariantFixtureSchema)
      .min(1)
      .readonly(),
  })
  .strict();

export type SafetyPolicyComposerFixture = z.infer<
  typeof SafetyPolicyComposerFixtureSchema
>;

export interface SafetyPolicyComposerReservation {
  readonly featureFlag: typeof SAFETY_POLICY_COMPOSER_FEATURE_FLAG;
  readonly enabled: boolean;
  readonly implementationStatus: "reserved-not-implemented";
  readonly conversionAvailable: false;
}

export function readSafetyPolicyComposerReservation(
  environment: Readonly<Record<string, string | undefined>>,
): SafetyPolicyComposerReservation {
  return {
    featureFlag: SAFETY_POLICY_COMPOSER_FEATURE_FLAG,
    enabled:
      environment[SAFETY_POLICY_COMPOSER_FEATURE_FLAG]?.trim().toLowerCase() ===
      "true",
    implementationStatus: "reserved-not-implemented",
    conversionAvailable: false,
  };
}
