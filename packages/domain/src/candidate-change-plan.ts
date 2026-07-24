import { z } from "zod";

import {
  DatabaseOperationKindSchema,
  ExpectedEffectSchema,
} from "./intent-contract";

const SqlTextSchema = z.string().trim().min(1).max(50_000);
const BoundedTextSchema = z.string().trim().min(1).max(4_096);

export const SqlReadCheckSchema = z
  .object({
    checkId: z.string().trim().min(1).max(128),
    sql: SqlTextSchema,
    expectation: z.enum([
      "zero-rows",
      "one-row",
      "non-empty",
      "scalar-true",
    ]),
    purpose: BoundedTextSchema.max(1_024),
  })
  .strict();

export const SqlStatementSchema = z
  .object({
    statementId: z.string().trim().min(1).max(128),
    operation: DatabaseOperationKindSchema,
    sql: SqlTextSchema,
    purpose: BoundedTextSchema.max(1_024),
    maxAffectedRows: z.number().int().positive().max(100_000),
  })
  .strict();

export const CandidateChangePlanSchema = z
  .object({
    candidateId: z.string().trim().min(1).max(128),
    strategy: z.enum([
      "conservative",
      "relationship-preserving",
      "aggressive-cleanup",
    ]),
    hypothesis: BoundedTextSchema,
    preconditions: z.array(SqlReadCheckSchema).min(1).max(32),
    statements: z.array(SqlStatementSchema).min(1).max(32),
    expectedEffects: z.array(ExpectedEffectSchema).min(1).max(64),
    rollbackPlan: z.array(SqlStatementSchema).min(1).max(32),
    risks: z.array(BoundedTextSchema.max(1_024)).min(1).max(32),
    requestedValidations: z
      .array(z.string().trim().min(1).max(128))
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((plan, context) => {
    const identifiers = [
      ...plan.preconditions.map((check) => check.checkId),
      ...plan.statements.map((statement) => statement.statementId),
      ...plan.rollbackPlan.map((statement) => statement.statementId),
    ];
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        message: "check and statement identifiers must be unique",
      });
    }
  });

export type SqlReadCheck = z.infer<typeof SqlReadCheckSchema>;
export type SqlStatement = z.infer<typeof SqlStatementSchema>;
export type CandidateChangePlan = z.infer<typeof CandidateChangePlanSchema>;

export function parseCandidateChangePlan(input: unknown): CandidateChangePlan {
  return CandidateChangePlanSchema.parse(input);
}
