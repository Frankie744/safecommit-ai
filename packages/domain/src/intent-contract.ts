import { z } from "zod";

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "must be a SQL identifier");

const BoundedTextSchema = z.string().trim().min(1).max(4_096);

export const DatabaseOperationKindSchema = z.enum([
  "insert",
  "update",
  "delete",
]);

export const ExpectedEffectSchema = z
  .object({
    effectId: z.string().trim().min(1).max(128),
    table: IdentifierSchema,
    operation: DatabaseOperationKindSchema,
    predicate: BoundedTextSchema,
    expectedRowDelta: z.number().int().min(-10_000).max(10_000),
    explanation: BoundedTextSchema.max(1_024),
  })
  .strict();

export const IntentContractSchema = z
  .object({
    taskId: z.string().trim().min(1).max(128),
    naturalLanguageRequest: BoundedTextSchema,
    databaseProfile: z.literal("openboxes-mysql-v1"),
    allowedWarehouses: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
    allowedTenants: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
    allowedTables: z.array(IdentifierSchema).min(1).max(64),
    operationKinds: z.array(DatabaseOperationKindSchema).min(1).max(3),
    forbiddenOperationKinds: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
    maxAffectedRows: z.number().int().positive().max(100_000),
    protectedOrderStates: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
    requiredInvariants: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
    expectedBusinessEffect: z.array(ExpectedEffectSchema).min(1).max(64),
    rollbackRequired: z.literal(true),
    idempotencyRequired: z.literal(true),
    contractVersion: z.string().trim().min(1).max(64),
  })
  .strict()
  .superRefine((contract, context) => {
    for (const [field, values] of [
      ["allowedWarehouses", contract.allowedWarehouses],
      ["allowedTenants", contract.allowedTenants],
      ["allowedTables", contract.allowedTables],
      ["operationKinds", contract.operationKinds],
      ["requiredInvariants", contract.requiredInvariants],
    ] as const) {
      if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must not contain duplicates`,
        });
      }
    }

    const allowedOperations = new Set(contract.operationKinds);
    for (const effect of contract.expectedBusinessEffect) {
      if (!allowedOperations.has(effect.operation)) {
        context.addIssue({
          code: "custom",
          path: ["expectedBusinessEffect"],
          message: `effect ${effect.effectId} uses a disallowed operation`,
        });
      }
    }
  });

export type DatabaseOperationKind = z.infer<
  typeof DatabaseOperationKindSchema
>;
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;
export type IntentContract = z.infer<typeof IntentContractSchema>;

export function parseIntentContract(input: unknown): IntentContract {
  return IntentContractSchema.parse(input);
}
