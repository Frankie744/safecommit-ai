import {
  CandidateChangePlanSchema,
  IntentContractSchema,
  type CandidateChangePlan,
  type IntentContract,
} from "@safeflash/domain";

export function logisticsIntentContract(
  overrides: Partial<IntentContract> = {},
): IntentContract {
  return IntentContractSchema.parse({
    taskId: "merge-duplicate-sku-la",
    naturalLanguageRequest:
      "Merge the duplicate SKU in Los Angeles and release cancelled-order allocations without changing other warehouses, shipped orders, lots, or serial numbers.",
    databaseProfile: "openboxes-mysql-v1",
    allowedWarehouses: ["warehouse-la"],
    allowedTenants: ["tenant-demo"],
    allowedTables: [
      "product",
      "inventory_item",
      "inventory_transaction",
      "order_header",
      "order_line",
      "allocation",
      "lot",
      "serial_number",
    ],
    operationKinds: ["insert", "update", "delete"],
    forbiddenOperationKinds: [
      "ddl",
      "grant",
      "truncate",
      "external-file",
      "stored-procedure",
    ],
    maxAffectedRows: 24,
    protectedOrderStates: ["SHIPPED", "DELIVERED"],
    requiredInvariants: [
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
    ],
    expectedBusinessEffect: [
      {
        effectId: "release-cancelled-allocation",
        table: "allocation",
        operation: "update",
        predicate: "cancelled order allocation in warehouse-la",
        expectedRowDelta: 1,
        explanation:
          "The cancelled allocation is released while inventory quantity is conserved.",
      },
    ],
    rollbackRequired: true,
    idempotencyRequired: true,
    contractVersion: "safecommit-logistics-v1",
    ...overrides,
  });
}

export function logisticsCandidatePlan(
  overrides: Partial<CandidateChangePlan> = {},
): CandidateChangePlan {
  return CandidateChangePlanSchema.parse({
    candidateId: "candidate-relationship-preserving",
    strategy: "relationship-preserving",
    hypothesis:
      "Release only cancelled allocations in the allowed warehouse, preserving product, lot, serial, and shipped-order relationships.",
    preconditions: [
      {
        checkId: "check-cancelled-allocation",
        sql: [
          "SELECT COUNT(*) AS affected",
          "FROM allocation a",
          "JOIN order_line ol ON ol.id = a.order_line_id",
          "JOIN order_header oh ON oh.id = ol.order_id",
          "WHERE oh.status = 'CANCELLED' AND a.warehouse_id = 'warehouse-la'",
        ].join(" "),
        expectation: "non-empty",
        purpose: "Confirm the intended cancelled allocation exists.",
      },
    ],
    statements: [
      {
        statementId: "release-cancelled-allocation",
        operation: "update",
        sql: [
          "UPDATE allocation a",
          "JOIN order_line ol ON ol.id = a.order_line_id",
          "JOIN order_header oh ON oh.id = ol.order_id",
          "SET a.quantity = 0",
          "WHERE oh.status = 'CANCELLED'",
          "AND a.warehouse_id = 'warehouse-la'",
        ].join(" "),
        purpose: "Release only the cancelled-order allocation.",
        maxAffectedRows: 4,
      },
    ],
    expectedEffects: [
      {
        effectId: "release-cancelled-allocation",
        table: "allocation",
        operation: "update",
        predicate: "cancelled order allocation in warehouse-la",
        expectedRowDelta: 1,
        explanation:
          "The cancelled allocation becomes zero without changing on-hand inventory.",
      },
    ],
    rollbackPlan: [
      {
        statementId: "restore-cancelled-allocation",
        operation: "update",
        sql: [
          "UPDATE allocation",
          "SET quantity = 3",
          "WHERE id = 'allocation-cancelled-la'",
        ].join(" "),
        purpose: "Restore the deterministic fixture allocation.",
        maxAffectedRows: 1,
      },
    ],
    risks: [
      "A missing warehouse predicate would release allocations in another warehouse.",
    ],
    requestedValidations: [
      "WarehouseScope",
      "ProtectedOrderState",
      "RollbackVerified",
    ],
    ...overrides,
  });
}
