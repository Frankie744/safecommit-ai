import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IdentifierSchema = z.string().trim().min(1).max(256);
const JsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const StatementEvidenceSchema = z
  .object({
    statementId: IdentifierSchema,
    executionOrder: z.number().int().nonnegative(),
    affectedRows: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    resultDigest: Sha256Schema,
  })
  .strict();

export const RowDeltaSchema = z
  .object({
    table: IdentifierSchema,
    primaryKey: z.record(z.string(), JsonScalarSchema),
    changeKind: z.enum(["inserted", "updated", "deleted"]),
    before: z.record(z.string(), JsonScalarSchema).nullable(),
    after: z.record(z.string(), JsonScalarSchema).nullable(),
  })
  .strict();

export const InvariantResultSchema = z
  .object({
    name: IdentifierSchema,
    passed: z.boolean(),
    explanation: z.string().trim().min(1).max(4_096),
    evidenceDigest: Sha256Schema,
  })
  .strict();

export const ProviderEvidenceSchema = z
  .object({
    provenance: z.enum(["live", "recorded-live", "local-test", "mock"]),
    executionProvider: z.enum(["daytona", "local-mysql", "contract-test"]),
    evaluationProvider: z.enum(["braintrust", "local-deterministic", "contract-test"]),
    providerResourceIds: z.array(IdentifierSchema).max(64),
    evidenceRefs: z.array(z.string().trim().min(1).max(2_048)).max(64),
  })
  .strict();

export const DatabaseEvidenceSchema = z
  .object({
    sessionId: IdentifierSchema,
    candidateId: IdentifierSchema,
    sourceCommitSha: z.string().regex(/^[a-f0-9]{7,64}$/u),
    snapshotId: IdentifierSchema,
    snapshotDigest: Sha256Schema,
    sandboxId: IdentifierSchema,
    runId: IdentifierSchema,
    planDigest: Sha256Schema,
    intentContractDigest: Sha256Schema,
    schemaFingerprint: Sha256Schema,
    beforeStateDigest: Sha256Schema,
    afterStateDigest: Sha256Schema,
    rollbackStateDigest: Sha256Schema,
    statementResults: z.array(StatementEvidenceSchema).min(1).max(64),
    rowDelta: z.array(RowDeltaSchema).max(100_000),
    invariantResults: z.array(InvariantResultSchema).min(1).max(64),
    providerEvidence: ProviderEvidenceSchema,
  })
  .strict();

export type StatementEvidence = z.infer<typeof StatementEvidenceSchema>;
export type RowDelta = z.infer<typeof RowDeltaSchema>;
export type InvariantResult = z.infer<typeof InvariantResultSchema>;
export type ProviderEvidence = z.infer<typeof ProviderEvidenceSchema>;
export type DatabaseEvidence = z.infer<typeof DatabaseEvidenceSchema>;

export function parseDatabaseEvidence(input: unknown): DatabaseEvidence {
  return DatabaseEvidenceSchema.parse(input);
}
