import { computeEvidenceDigest } from "@safeflash/domain";

export const DATABASE_HARD_GATE_NAMES = [
  "PlanExecutionSuccess",
  "PlanIntegrity",
  "WarehouseScope",
  "TenantIsolation",
  "InventoryConservation",
  "NoNegativeInventory",
  "AllocationBound",
  "LotSerialPreservation",
  "ReferentialIntegrity",
  "ProtectedOrderState",
  "BlastRadiusWithinContract",
  "Idempotency",
  "RollbackVerified",
] as const;

export type DatabaseHardGateName = (typeof DATABASE_HARD_GATE_NAMES)[number];

export interface DatabaseInvariantContext {
  executionSucceeded: boolean;
  planIntegrityPassed: boolean;
  allowedWarehouses: readonly string[];
  touchedWarehouses: readonly string[];
  allowedTenants: readonly string[];
  touchedTenants: readonly string[];
  inventoryUnitsBefore: number;
  inventoryUnitsAfter: number;
  negativeInventoryRows: number;
  overAllocatedRows: number;
  lostLotOrSerialRows: number;
  referentialIntegrityViolations: number;
  protectedOrderRowsChanged: number;
  affectedRows: number;
  maxAffectedRows: number;
  afterStateDigest: string;
  secondRunStateDigest: string;
  beforeStateDigest: string;
  rollbackStateDigest: string;
}

export interface DatabaseHardGateResult {
  name: DatabaseHardGateName;
  passed: boolean;
  explanation: string;
  evidenceDigest: string;
}

export interface DatabaseGateEvaluation {
  eligible: boolean;
  results: readonly DatabaseHardGateResult[];
  failedGateNames: readonly DatabaseHardGateName[];
}

function subsetOf(
  actual: readonly string[],
  allowed: readonly string[],
): boolean {
  const allowedNormalized = new Set(allowed.map((value) => value.toLowerCase()));
  return actual.every((value) => allowedNormalized.has(value.toLowerCase()));
}

export function evaluateDatabaseHardGates(
  context: DatabaseInvariantContext,
): DatabaseGateEvaluation {
  const facts: readonly [
    DatabaseHardGateName,
    boolean,
    string,
  ][] = [
    [
      "PlanExecutionSuccess",
      context.executionSucceeded,
      context.executionSucceeded
        ? "Every server-owned statement completed inside the bounded transaction."
        : "At least one server-owned statement failed or timed out.",
    ],
    [
      "PlanIntegrity",
      context.planIntegrityPassed,
      context.planIntegrityPassed
        ? "The MySQL AST and server policy accepted the complete plan."
        : "The plan violated the MySQL AST or server policy.",
    ],
    [
      "WarehouseScope",
      subsetOf(context.touchedWarehouses, context.allowedWarehouses),
      `Touched warehouses: ${context.touchedWarehouses.join(", ") || "none"}.`,
    ],
    [
      "TenantIsolation",
      subsetOf(context.touchedTenants, context.allowedTenants),
      `Touched tenants: ${context.touchedTenants.join(", ") || "none"}.`,
    ],
    [
      "InventoryConservation",
      context.inventoryUnitsBefore === context.inventoryUnitsAfter,
      `Inventory units ${context.inventoryUnitsBefore} -> ${context.inventoryUnitsAfter}.`,
    ],
    [
      "NoNegativeInventory",
      context.negativeInventoryRows === 0,
      `${context.negativeInventoryRows} inventory rows are negative.`,
    ],
    [
      "AllocationBound",
      context.overAllocatedRows === 0,
      `${context.overAllocatedRows} allocations exceed available inventory.`,
    ],
    [
      "LotSerialPreservation",
      context.lostLotOrSerialRows === 0,
      `${context.lostLotOrSerialRows} lot or serial relationships were lost.`,
    ],
    [
      "ReferentialIntegrity",
      context.referentialIntegrityViolations === 0,
      `${context.referentialIntegrityViolations} referential-integrity violations remain.`,
    ],
    [
      "ProtectedOrderState",
      context.protectedOrderRowsChanged === 0,
      `${context.protectedOrderRowsChanged} protected order rows changed.`,
    ],
    [
      "BlastRadiusWithinContract",
      context.affectedRows <= context.maxAffectedRows,
      `${context.affectedRows}/${context.maxAffectedRows} allowed rows were affected.`,
    ],
    [
      "Idempotency",
      context.afterStateDigest === context.secondRunStateDigest,
      "The first-run and second-run state digests must match.",
    ],
    [
      "RollbackVerified",
      context.beforeStateDigest === context.rollbackStateDigest,
      "The rollback digest must equal the before-state digest.",
    ],
  ];

  const results = facts.map(([name, passed, explanation]) => ({
    name,
    passed,
    explanation,
    evidenceDigest: computeEvidenceDigest({ name, passed, explanation }),
  }));
  const failedGateNames = results
    .filter((result) => !result.passed)
    .map((result) => result.name);

  return {
    eligible: failedGateNames.length === 0,
    results,
    failedGateNames,
  };
}
