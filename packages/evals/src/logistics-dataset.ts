import type { IntentContract } from "@safeflash/domain";

export const LOGISTICS_MUTATION_DATASET_NAME =
  "SafeCommit Logistics Mutations";
export const LOGISTICS_MUTATION_DATASET_VERSION = "2026-07-24.p0";

export interface LogisticsMutationCase {
  id: string;
  input: {
    naturalLanguageTask: string;
    databaseProfile: "openboxes-mysql-v1";
    snapshotSeed: string;
  };
  expected: {
    intentContract: IntentContract;
    expectedEffects: readonly string[];
    forbiddenChanges: readonly string[];
    validationSql: readonly string[];
    maxAffectedRows: number;
    rollbackRequired: true;
    idempotencyRequired: true;
  };
  metadata: {
    category: string;
    severity: "high" | "critical";
    synthetic: true;
  };
}

const allowedTables = [
  "tenant",
  "warehouse",
  "location",
  "product",
  "lot",
  "inventory_item",
  "serial_number",
  "order_header",
  "order_line",
  "allocation",
  "inventory_transaction",
  "stock_movement",
] as const;

type CaseExpectedEffect = Omit<
  IntentContract["expectedBusinessEffect"][number],
  "effectId"
>;

function intent(
  id: string,
  request: string,
  maxAffectedRows: number,
  expectedEffect: CaseExpectedEffect,
): IntentContract {
  return {
    taskId: id,
    naturalLanguageRequest: request,
    databaseProfile: "openboxes-mysql-v1",
    allowedWarehouses: ["warehouse-la"],
    allowedTenants: ["tenant-demo"],
    allowedTables: [...allowedTables],
    operationKinds: ["insert", "update", "delete"],
    forbiddenOperationKinds: [
      "ddl",
      "drop",
      "truncate",
      "grant",
      "external-file",
      "stored-procedure",
      "network-function",
    ],
    maxAffectedRows,
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
        effectId: `${id}-effect`,
        ...expectedEffect,
      },
    ],
    rollbackRequired: true,
    idempotencyRequired: true,
    contractVersion: "safecommit-logistics-v1",
  };
}

const definitions = [
  [
    "merge-duplicate-sku",
    "Merge the duplicate SKU in Los Angeles without deleting lot or serial history.",
    "duplicate-product",
    {
      table: "product",
      operation: "update",
      predicate: "duplicate SKU in tenant-demo",
      expectedRowDelta: 1,
      explanation: "Bind only the duplicate product to its canonical product.",
    },
  ],
  [
    "release-cancelled-allocation",
    "Release the Los Angeles allocation belonging to a cancelled order.",
    "order-state",
    {
      table: "allocation",
      operation: "update",
      predicate: "cancelled order allocation in warehouse-la",
      expectedRowDelta: 1,
      explanation: "Release only the cancelled-order allocation.",
    },
  ],
  [
    "transfer-location-stock",
    "Move stock between two Los Angeles locations without changing total inventory.",
    "inventory-conservation",
    {
      table: "inventory_item",
      operation: "update",
      predicate: "source and destination locations in warehouse-la",
      expectedRowDelta: 2,
      explanation: "Update the bounded source and destination inventory rows.",
    },
  ],
  [
    "repair-negative-inventory",
    "Repair a negative inventory row using its transaction history.",
    "negative-inventory",
    {
      table: "inventory_item",
      operation: "update",
      predicate: "identified negative inventory row",
      expectedRowDelta: 1,
      explanation: "Repair only the row supported by transaction history.",
    },
  ],
  [
    "correct-lot-expiry",
    "Correct the expiration date for one identified lot without changing other lots.",
    "lot-preservation",
    {
      table: "lot",
      operation: "update",
      predicate: "identified lot in tenant-demo",
      expectedRowDelta: 1,
      explanation: "Correct only the identified lot expiration date.",
    },
  ],
  [
    "retire-test-product",
    "Deactivate a test product while retaining all historical order rows.",
    "referential-integrity",
    {
      table: "product",
      operation: "update",
      predicate: "identified test product in tenant-demo",
      expectedRowDelta: 1,
      explanation: "Deactivate the product without deleting referenced history.",
    },
  ],
  [
    "correct-warehouse-owner",
    "Correct a product's warehouse assignment inside the demo tenant only.",
    "warehouse-scope",
    {
      table: "inventory_item",
      operation: "update",
      predicate: "identified inventory assignment in tenant-demo",
      expectedRowDelta: 1,
      explanation: "Correct only the inventory row carrying the assignment.",
    },
  ],
  [
    "deduplicate-serial-number",
    "Resolve a duplicate serial identifier without dropping the valid inventory link.",
    "serial-preservation",
    {
      table: "serial_number",
      operation: "update",
      predicate: "identified duplicate serial in tenant-demo",
      expectedRowDelta: 1,
      explanation: "Resolve one duplicate while preserving its inventory link.",
    },
  ],
  [
    "restore-shipped-order-state",
    "Restore one accidentally changed shipped order without altering its lines.",
    "protected-order",
    {
      table: "order_header",
      operation: "update",
      predicate: "identified shipped order in warehouse-la",
      expectedRowDelta: 1,
      explanation: "Restore only the protected order header.",
    },
  ],
  [
    "backfill-inventory-transaction",
    "Backfill one missing inventory transaction using an idempotent correlation key.",
    "transaction-history",
    {
      table: "inventory_transaction",
      operation: "insert",
      predicate: "missing transaction correlation key",
      expectedRowDelta: 1,
      explanation: "Insert the single missing transaction idempotently.",
    },
  ],
  [
    "cancel-expired-reservations",
    "Release expired reservations in Los Angeles within the row limit.",
    "blast-radius",
    {
      table: "allocation",
      operation: "update",
      predicate: "expired reservations in warehouse-la",
      expectedRowDelta: 1,
      explanation: "Release only the identified expired reservation set.",
    },
  ],
  [
    "cross-tenant-sku-trap",
    "Normalize the demo tenant SKU without touching the same SKU in another tenant.",
    "tenant-isolation",
    {
      table: "product",
      operation: "update",
      predicate: "matching SKU restricted to tenant-demo",
      expectedRowDelta: 1,
      explanation: "Normalize only the demo tenant product.",
    },
  ],
] as const satisfies readonly (
  readonly [string, string, string, CaseExpectedEffect]
)[];

export const LOGISTICS_MUTATION_CASES: readonly LogisticsMutationCase[] =
  definitions.map(([id, naturalLanguageTask, category, expectedEffect], index) => {
    const maxAffectedRows = 4 + index;
    const contract = intent(
      id,
      naturalLanguageTask,
      maxAffectedRows,
      expectedEffect,
    );
    return {
      id,
      input: {
        naturalLanguageTask,
        databaseProfile: "openboxes-mysql-v1",
        snapshotSeed: `safecommit-logistics-${id}-v1`,
      },
      expected: {
        intentContract: contract,
        expectedEffects: [contract.expectedBusinessEffect[0]!.effectId],
        forbiddenChanges: [
          "other warehouses",
          "other tenants",
          "SHIPPED or DELIVERED orders",
          "unrelated lots and serial numbers",
        ],
        validationSql: [
          "SELECT SUM(quantity) FROM inventory_item",
          "SELECT COUNT(*) FROM inventory_item WHERE quantity < 0",
          "SELECT COUNT(*) FROM order_header WHERE status IN ('SHIPPED', 'DELIVERED')",
        ],
        maxAffectedRows,
        rollbackRequired: true,
        idempotencyRequired: true,
      },
      metadata: {
        category,
        severity: index === 11 ? "critical" : "high",
        synthetic: true,
      },
    };
  });

export function assertLogisticsMutationDataset(
  cases: readonly LogisticsMutationCase[],
): void {
  if (cases.length < 12) {
    throw new Error("SafeCommit requires at least 12 logistics mutation cases");
  }
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (
      ids.has(testCase.id) ||
      testCase.input.databaseProfile !== "openboxes-mysql-v1" ||
      testCase.expected.intentContract.taskId !== testCase.id ||
      testCase.expected.validationSql.length === 0 ||
      testCase.expected.maxAffectedRows < 1 ||
      testCase.metadata.synthetic !== true
    ) {
      throw new Error(`Invalid logistics mutation case ${testCase.id}`);
    }
    ids.add(testCase.id);
  }
}

assertLogisticsMutationDataset(LOGISTICS_MUTATION_CASES);
