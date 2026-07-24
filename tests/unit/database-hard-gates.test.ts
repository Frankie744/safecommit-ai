import { describe, expect, it } from "vitest";

import {
  DATABASE_HARD_GATE_NAMES,
  evaluateDatabaseHardGates,
  type DatabaseInvariantContext,
} from "@safeflash/safety-policy";

function passingContext(): DatabaseInvariantContext {
  return {
    executionSucceeded: true,
    planIntegrityPassed: true,
    allowedWarehouses: ["warehouse-la"],
    touchedWarehouses: ["warehouse-la"],
    allowedTenants: ["tenant-demo"],
    touchedTenants: ["tenant-demo"],
    inventoryUnitsBefore: 100,
    inventoryUnitsAfter: 100,
    negativeInventoryRows: 0,
    overAllocatedRows: 0,
    lostLotOrSerialRows: 0,
    referentialIntegrityViolations: 0,
    protectedOrderRowsChanged: 0,
    affectedRows: 3,
    maxAffectedRows: 24,
    beforeStateDigest: "before",
    afterStateDigest: "after",
    secondRunStateDigest: "after",
    rollbackStateDigest: "before",
  };
}

describe("13 non-compensable database hard gates", () => {
  it("passes only when every gate passes", () => {
    const result = evaluateDatabaseHardGates(passingContext());
    expect(result.results.map((gate) => gate.name)).toEqual(
      DATABASE_HARD_GATE_NAMES,
    );
    expect(result.results).toHaveLength(13);
    expect(result.eligible).toBe(true);
  });

  it.each([
    ["PlanExecutionSuccess", { executionSucceeded: false }],
    ["PlanIntegrity", { planIntegrityPassed: false }],
    ["WarehouseScope", { touchedWarehouses: ["warehouse-ny"] }],
    ["TenantIsolation", { touchedTenants: ["tenant-other"] }],
    ["InventoryConservation", { inventoryUnitsAfter: 99 }],
    ["NoNegativeInventory", { negativeInventoryRows: 1 }],
    ["AllocationBound", { overAllocatedRows: 1 }],
    ["LotSerialPreservation", { lostLotOrSerialRows: 1 }],
    ["ReferentialIntegrity", { referentialIntegrityViolations: 1 }],
    ["ProtectedOrderState", { protectedOrderRowsChanged: 1 }],
    ["BlastRadiusWithinContract", { affectedRows: 25 }],
    ["Idempotency", { secondRunStateDigest: "different" }],
    ["RollbackVerified", { rollbackStateDigest: "different" }],
  ] satisfies readonly [
    (typeof DATABASE_HARD_GATE_NAMES)[number],
    Partial<DatabaseInvariantContext>,
  ][])("fails closed when %s fails", (gate, change) => {
    const result = evaluateDatabaseHardGates({
      ...passingContext(),
      ...change,
    });
    expect(result.eligible).toBe(false);
    expect(result.failedGateNames).toContain(gate);
  });
});
