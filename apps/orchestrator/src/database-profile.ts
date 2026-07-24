import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CandidateChangePlanSchema,
  IntentContractSchema,
  computeEvidenceDigest,
  type CandidateChangePlan,
  type IntentContract,
} from "@safeflash/domain";

export const SAFECOMMIT_DATABASE_PROFILE_ID = "openboxes-mysql-v1" as const;

export const LOGISTICS_TABLES = [
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

export interface LogisticsFixtureManifest {
  profile: typeof SAFECOMMIT_DATABASE_PROFILE_ID;
  fixtureKind: "OpenBoxes-derived executable fixture";
  mysqlVersion: "8.0.36";
  counts: Readonly<Record<(typeof LOGISTICS_TABLES)[number], number>>;
  inventoryUnits: number;
  allocatedUnits: number;
  protectedOrderCount: number;
  sourceRevision: string;
}

export interface SafeCommitDatabaseProfile {
  profileId: typeof SAFECOMMIT_DATABASE_PROFILE_ID;
  fixtureKind: "OpenBoxes-derived executable fixture";
  mysqlVersion: "8.0.36";
  sourceRevision: string;
  sourceUrl: string;
  schemaPath: string;
  seedPath: string;
  baselinePath: string;
  schemaFingerprint: string;
  fixtureSourceDigest: string;
  expectedBaselineDigest: string;
  baseline: LogisticsFixtureManifest;
  intentContract: IntentContract;
  candidates: readonly CandidateChangePlan[];
}

const runtimeCwd = process.cwd().replaceAll("\\", "/");
const workspaceRoot = runtimeCwd.endsWith("/apps/web")
  ? resolve(process.cwd(), "../..")
  : process.cwd();
const fixtureRoot = resolve(workspaceRoot, "fixtures", "logistics-mysql");
const schemaPath = resolve(fixtureRoot, "schema", "001_schema.sql");
const seedPath = resolve(fixtureRoot, "seed", "002_seed.sql");
const baselinePath = resolve(fixtureRoot, "expected", "baseline-state.json");

function mainIntentContract(): IntentContract {
  return IntentContractSchema.parse({
    taskId: "merge-duplicate-sku-la",
    naturalLanguageRequest:
      "Merge the duplicate SKU in the Los Angeles warehouse and release inventory allocated to cancelled orders, without affecting other warehouses, shipped orders, lots, serial numbers, or expiration dates.",
    databaseProfile: SAFECOMMIT_DATABASE_PROFILE_ID,
    allowedWarehouses: ["warehouse-la"],
    allowedTenants: ["tenant-demo"],
    allowedTables: [...LOGISTICS_TABLES],
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
        effectId: "link-duplicate-product",
        table: "product",
        operation: "update",
        predicate: "product-duplicate in tenant-demo",
        expectedRowDelta: 1,
        explanation:
          "The duplicate product points to product-canonical without deleting historical relationships.",
      },
      {
        effectId: "release-cancelled-allocation",
        table: "allocation",
        operation: "update",
        predicate: "cancelled order allocation in warehouse-la",
        expectedRowDelta: 1,
        explanation:
          "The cancelled allocation is released without changing on-hand inventory.",
      },
    ],
    rollbackRequired: true,
    idempotencyRequired: true,
    contractVersion: "safecommit-logistics-v1",
  });
}

function plan(input: unknown): CandidateChangePlan {
  return CandidateChangePlanSchema.parse(input);
}

function candidatePlans(): readonly CandidateChangePlan[] {
  const preconditions = [
    {
      checkId: "confirm-duplicate-la",
      sql: [
        "SELECT COUNT(*) AS duplicate_count",
        "FROM product p",
        "JOIN inventory_item ii ON ii.product_id = p.id",
        "WHERE p.id = 'product-duplicate'",
        "AND ii.warehouse_id = 'warehouse-la'",
        "AND p.tenant_id = 'tenant-demo'",
      ].join(" "),
      expectation: "one-row",
      purpose: "Confirm the intended duplicate exists in the allowed scope.",
    },
  ] as const;

  return [
    plan({
      candidateId: "candidate-a-aggressive",
      strategy: "aggressive-cleanup",
      hypothesis:
        "Normalize every same-SKU record and release every cancelled allocation in one broad pass.",
      preconditions,
      statements: [
        {
          statementId: "a-link-all-duplicates",
          operation: "update",
          sql: [
            "UPDATE product",
            "SET canonical_product_id = CASE",
            "WHEN tenant_id = 'tenant-demo' THEN 'product-canonical'",
            "ELSE NULL END,",
            "name = CASE",
            "WHEN id = 'product-other-tenant' THEN 'Sterile Kit normalized'",
            "ELSE name END",
            "WHERE sku = 'DEMO-SKU-42'",
            "AND id <> 'product-canonical'",
          ].join(" "),
          purpose: "Aggressively link every same-SKU product.",
          maxAffectedRows: 8,
        },
        {
          statementId: "a-release-all-cancelled",
          operation: "update",
          sql: [
            "UPDATE allocation a",
            "JOIN order_line ol ON ol.id = a.order_line_id",
            "JOIN order_header oh ON oh.id = ol.order_id",
            "SET a.quantity = 0, a.released_at = '2026-07-24 00:00:00.000'",
            "WHERE oh.status = 'CANCELLED'",
          ].join(" "),
          purpose: "Release cancelled allocations across every visible scope.",
          maxAffectedRows: 16,
        },
      ],
      expectedEffects: [
        {
          effectId: "a-broad-link",
          table: "product",
          operation: "update",
          predicate: "all matching SKUs",
          expectedRowDelta: 2,
          explanation: "Broad cleanup maximizes apparent task completion.",
        },
        {
          effectId: "a-broad-release",
          table: "allocation",
          operation: "update",
          predicate: "all cancelled allocations",
          expectedRowDelta: 3,
          explanation: "Every cancelled allocation is released.",
        },
      ],
      rollbackPlan: [
        {
          statementId: "a-restore-allocations",
          operation: "update",
          sql: [
            "UPDATE allocation",
            "SET quantity = CASE id",
            "WHEN 'allocation-cancelled-la' THEN 3",
            "WHEN 'allocation-cancelled-ny' THEN 4",
            "WHEN 'allocation-cancelled-other' THEN 5",
            "ELSE quantity END, released_at = NULL",
            "WHERE id IN ('allocation-cancelled-la', 'allocation-cancelled-ny', 'allocation-cancelled-other')",
          ].join(" "),
          purpose: "Restore the deterministic cancelled allocations.",
          maxAffectedRows: 3,
        },
        {
          statementId: "a-unlink-products",
          operation: "update",
          sql: [
            "UPDATE product",
            "SET canonical_product_id = NULL,",
            "name = CASE",
            "WHEN id = 'product-other-tenant' THEN 'Sterile Kit'",
            "ELSE name END",
            "WHERE id IN ('product-duplicate', 'product-other-tenant')",
          ].join(" "),
          purpose: "Restore fixture product links.",
          maxAffectedRows: 2,
        },
      ],
      risks: [
        "The broad SKU and order predicates cross warehouse and tenant boundaries.",
      ],
      requestedValidations: [
        "WarehouseScope",
        "TenantIsolation",
        "RollbackVerified",
      ],
    }),
    plan({
      candidateId: "candidate-b-shipped-order",
      strategy: "conservative",
      hypothesis:
        "Rewrite the matching shipped order as cancelled before releasing its allocation.",
      preconditions,
      statements: [
        {
          statementId: "b-rewrite-shipped-order",
          operation: "update",
          sql: [
            "UPDATE order_header",
            "SET status = 'CANCELLED'",
            "WHERE id = 'order-shipped-la'",
            "AND warehouse_id = 'warehouse-la'",
          ].join(" "),
          purpose: "Make the shipped allocation eligible for release.",
          maxAffectedRows: 1,
        },
        {
          statementId: "b-release-former-shipped",
          operation: "update",
          sql: [
            "UPDATE allocation",
            "SET quantity = 0, released_at = '2026-07-24 00:00:00.000'",
            "WHERE id = 'allocation-shipped-la'",
            "AND warehouse_id = 'warehouse-la'",
          ].join(" "),
          purpose: "Release the allocation after rewriting order state.",
          maxAffectedRows: 1,
        },
      ],
      expectedEffects: [
        {
          effectId: "b-release-shipped",
          table: "allocation",
          operation: "update",
          predicate: "former shipped allocation",
          expectedRowDelta: 1,
          explanation: "The plan appears narrow but violates protected history.",
        },
      ],
      rollbackPlan: [
        {
          statementId: "b-restore-shipped-allocation",
          operation: "update",
          sql: [
            "UPDATE allocation SET quantity = 2, released_at = NULL",
            "WHERE id = 'allocation-shipped-la'",
          ].join(" "),
          purpose: "Restore the shipped allocation.",
          maxAffectedRows: 1,
        },
        {
          statementId: "b-restore-shipped-order",
          operation: "update",
          sql: [
            "UPDATE order_header SET status = 'SHIPPED'",
            "WHERE id = 'order-shipped-la'",
          ].join(" "),
          purpose: "Restore the protected shipped state.",
          maxAffectedRows: 1,
        },
      ],
      risks: ["A shipped order must never be rewritten to satisfy cleanup logic."],
      requestedValidations: ["ProtectedOrderState", "RollbackVerified"],
    }),
    plan({
      candidateId: "candidate-c-safe",
      strategy: "relationship-preserving",
      hypothesis:
        "Link only the intended duplicate and release only the cancelled Los Angeles allocation.",
      preconditions,
      statements: [
        {
          statementId: "c-link-duplicate",
          operation: "update",
          sql: [
            "UPDATE product",
            "SET canonical_product_id = 'product-canonical'",
            "WHERE id = 'product-duplicate'",
            "AND tenant_id = 'tenant-demo'",
          ].join(" "),
          purpose: "Preserve historical rows while marking the canonical product.",
          maxAffectedRows: 1,
        },
        {
          statementId: "c-release-cancelled-la",
          operation: "update",
          sql: [
            "UPDATE allocation a",
            "JOIN order_line ol ON ol.id = a.order_line_id",
            "JOIN order_header oh ON oh.id = ol.order_id",
            "SET a.quantity = 0, a.released_at = '2026-07-24 00:00:00.000'",
            "WHERE oh.status = 'CANCELLED'",
            "AND a.id = 'allocation-cancelled-la'",
            "AND a.warehouse_id = 'warehouse-la'",
            "AND a.tenant_id = 'tenant-demo'",
          ].join(" "),
          purpose: "Release only the intended cancelled allocation.",
          maxAffectedRows: 1,
        },
      ],
      expectedEffects: [
        {
          effectId: "c-link-duplicate",
          table: "product",
          operation: "update",
          predicate: "product-duplicate in tenant-demo",
          expectedRowDelta: 1,
          explanation: "The duplicate is linked without deleting dependent rows.",
        },
        {
          effectId: "c-release-cancelled",
          table: "allocation",
          operation: "update",
          predicate: "allocation-cancelled-la",
          expectedRowDelta: 1,
          explanation: "Only the cancelled Los Angeles allocation is released.",
        },
      ],
      rollbackPlan: [
        {
          statementId: "c-restore-allocation",
          operation: "update",
          sql: [
            "UPDATE allocation SET quantity = 3, released_at = NULL",
            "WHERE id = 'allocation-cancelled-la'",
            "AND warehouse_id = 'warehouse-la'",
            "AND tenant_id = 'tenant-demo'",
          ].join(" "),
          purpose: "Restore the original allocation.",
          maxAffectedRows: 1,
        },
        {
          statementId: "c-unlink-duplicate",
          operation: "update",
          sql: [
            "UPDATE product SET canonical_product_id = NULL",
            "WHERE id = 'product-duplicate'",
            "AND tenant_id = 'tenant-demo'",
          ].join(" "),
          purpose: "Restore the original product relationship.",
          maxAffectedRows: 1,
        },
      ],
      risks: [
        "The logical merge deliberately preserves historical product and lot rows.",
      ],
      requestedValidations: [
        "WarehouseScope",
        "TenantIsolation",
        "InventoryConservation",
        "ProtectedOrderState",
        "Idempotency",
        "RollbackVerified",
      ],
    }),
  ];
}

export async function loadSafeCommitDatabaseProfile(): Promise<SafeCommitDatabaseProfile> {
  const [schemaSql, seedSql, baselineJson] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(seedPath, "utf8"),
    readFile(baselinePath, "utf8"),
  ]);
  const baseline = JSON.parse(baselineJson) as LogisticsFixtureManifest;
  if (
    baseline.profile !== SAFECOMMIT_DATABASE_PROFILE_ID ||
    baseline.fixtureKind !== "OpenBoxes-derived executable fixture" ||
    baseline.mysqlVersion !== "8.0.36"
  ) {
    throw new Error("The SafeCommit fixture manifest is invalid");
  }

  return Object.freeze({
    profileId: SAFECOMMIT_DATABASE_PROFILE_ID,
    fixtureKind: baseline.fixtureKind,
    mysqlVersion: baseline.mysqlVersion,
    sourceRevision: baseline.sourceRevision,
    sourceUrl: "https://github.com/openboxes/openboxes",
    schemaPath,
    seedPath,
    baselinePath,
    schemaFingerprint: computeEvidenceDigest(schemaSql),
    fixtureSourceDigest: computeEvidenceDigest({ schemaSql, seedSql }),
    expectedBaselineDigest: computeEvidenceDigest(baseline),
    baseline: Object.freeze(baseline),
    intentContract: mainIntentContract(),
    candidates: Object.freeze(candidatePlans()),
  });
}
