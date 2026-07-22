import { z } from "zod";

export const CandidateStrategySchema = z.enum([
  "fail-closed",
  "retry-and-latch",
  "range-validation",
]);

const boundedText = (label: string, maxLength: number) =>
  z.string().trim().min(1, `${label} must not be empty`).max(maxLength);

const requestedTestSchema = boundedText("test identifier", 256).refine(
  (value) => !/[;&|`$<>\r\n]/u.test(value),
  "testsToRun contains shell syntax; it must contain identifiers, not commands",
);

/**
 * The only model-authored payload accepted by the orchestrator.
 * Server-owned provenance is added later in CandidatePatchRecord.
 */
export const CandidatePatchSchema = z
  .object({
    candidateId: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
        "candidateId must be a stable identifier",
      ),
    strategy: CandidateStrategySchema,
    hypothesis: boundedText("hypothesis", 2_000),
    unifiedDiff: z
      .string()
      .min(1, "unifiedDiff must not be empty")
      .max(100_000, "unifiedDiff is too large")
      .refine((value) => !value.includes("\0"), "unifiedDiff contains a NUL byte")
      .refine(
        (value) => value.startsWith("diff --git ") || value.includes("\ndiff --git "),
        "unifiedDiff must contain git-style unified diff headers",
      ),
    expectedSafetyEffect: z
      .array(boundedText("expected safety effect", 1_000))
      .min(1)
      .max(16),
    risks: z.array(boundedText("risk", 1_000)).min(1).max(16),
    testsToRun: z.array(requestedTestSchema).min(1).max(32),
  })
  .strict();

export type CandidateStrategy = z.infer<typeof CandidateStrategySchema>;
export type CandidatePatch = z.infer<typeof CandidatePatchSchema>;

export function parseCandidatePatch(input: unknown): CandidatePatch {
  return CandidatePatchSchema.parse(input);
}
