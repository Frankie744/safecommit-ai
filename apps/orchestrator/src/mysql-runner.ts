import { randomUUID } from "node:crypto";

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

import {
  computeEvidenceDigest,
  type CandidateChangePlan,
  type DatabaseEvidence,
  type IntentContract,
  type StatementEvidence,
} from "@safeflash/domain";
import {
  evaluateDatabaseHardGates,
  validateSqlPlanIntegrity,
  type DatabaseGateEvaluation,
  type DatabaseInvariantContext,
} from "@safeflash/safety-policy";

import {
  LOGISTICS_TABLES,
  type SafeCommitDatabaseProfile,
} from "./database-profile";
import {
  computeRowDelta,
  createDatabaseStateSnapshot,
  type DatabaseRow,
  type DatabaseStateSnapshot,
  type DatabaseTables,
} from "./row-delta";

export interface LocalMysqlCandidateOptions {
  connectionUri: string;
  profile: SafeCommitDatabaseProfile;
  plan: CandidateChangePlan;
  intentContract: IntentContract;
  sessionId: string;
  sourceCommitSha: string;
  timeoutMs?: number;
  sandboxId?: string;
  runId?: string;
}

export interface LocalMysqlCandidateResult {
  evidence: DatabaseEvidence;
  gates: DatabaseGateEvaluation;
  before: DatabaseStateSnapshot;
  after: DatabaseStateSnapshot;
  secondRun: DatabaseStateSnapshot;
  rollback: DatabaseStateSnapshot;
}

function safeConnectionUri(uri: string): string {
  const value = uri.trim();
  if (value.length === 0) {
    throw new Error("SAFECOMMIT_MYSQL_URL is required for local MySQL evidence");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "mysql:") {
    throw new Error("SafeCommit local execution requires a mysql:// URL");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error(
      "Local-test MySQL execution is restricted to a loopback host",
    );
  }
  return value;
}

function normalizeRow(row: RowDataPacket): DatabaseRow {
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[key] = value;
      continue;
    }
    if (value instanceof Date) {
      normalized[key] = value.toISOString();
      continue;
    }
    if (Buffer.isBuffer(value)) {
      normalized[key] = value.toString("hex");
      continue;
    }
    throw new TypeError(`Unsupported MySQL value in ${key}`);
  }
  return normalized;
}

async function queryRows(
  connection: Connection,
  sql: string,
  timeoutMs: number,
): Promise<readonly DatabaseRow[]> {
  const [rows] = await connection.query({
    sql,
    timeout: timeoutMs,
  });
  if (!Array.isArray(rows)) {
    throw new Error("Expected a MySQL row result");
  }
  return (rows as RowDataPacket[]).map(normalizeRow);
}

async function captureState(
  connection: Connection,
  timeoutMs: number,
): Promise<DatabaseStateSnapshot> {
  const tables: Record<string, readonly DatabaseRow[]> = {};
  for (const table of LOGISTICS_TABLES) {
    tables[table] = await queryRows(
      connection,
      `SELECT * FROM \`${table}\` ORDER BY \`id\``,
      timeoutMs,
    );
  }
  return createDatabaseStateSnapshot(tables as DatabaseTables);
}

function numeric(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Expected numeric database value, received ${String(value)}`);
  }
  return parsed;
}

function sumColumn(rows: readonly DatabaseRow[], column: string): number {
  return rows.reduce((sum, row) => sum + numeric(row[column]), 0);
}

function liveBaselineManifest(
  profile: SafeCommitDatabaseProfile,
  snapshot: DatabaseStateSnapshot,
): SafeCommitDatabaseProfile["baseline"] {
  const counts = Object.fromEntries(
    LOGISTICS_TABLES.map((table) => [table, snapshot.tables[table]?.length ?? 0]),
  ) as SafeCommitDatabaseProfile["baseline"]["counts"];
  const protectedStates = new Set(profile.intentContract.protectedOrderStates);
  return {
    profile: profile.profileId,
    fixtureKind: profile.fixtureKind,
    mysqlVersion: profile.mysqlVersion,
    counts,
    inventoryUnits: sumColumn(
      snapshot.tables.inventory_item ?? [],
      "quantity",
    ),
    allocatedUnits: sumColumn(snapshot.tables.allocation ?? [], "quantity"),
    protectedOrderCount: (snapshot.tables.order_header ?? []).filter((row) =>
      protectedStates.has(String(row.status)),
    ).length,
    sourceRevision: profile.sourceRevision,
  };
}

function assertBaseline(
  profile: SafeCommitDatabaseProfile,
  snapshot: DatabaseStateSnapshot,
): void {
  const actual = liveBaselineManifest(profile, snapshot);
  const actualDigest = computeEvidenceDigest(actual);
  if (actualDigest !== profile.expectedBaselineDigest) {
    throw new Error(
      `MySQL fixture baseline mismatch: expected ${profile.expectedBaselineDigest}, observed ${actualDigest}`,
    );
  }
}

function expectationPassed(
  expectation: CandidateChangePlan["preconditions"][number]["expectation"],
  rows: readonly DatabaseRow[],
): boolean {
  if (expectation === "zero-rows") return rows.length === 0;
  if (expectation === "one-row") return rows.length === 1;
  if (expectation === "non-empty") return rows.length > 0;
  const firstRow = rows[0];
  const firstValue =
    firstRow === undefined ? undefined : Object.values(firstRow)[0];
  return firstValue === true || firstValue === 1 || firstValue === "1";
}

async function executeStatements(
  connection: Connection,
  statements: CandidateChangePlan["statements"],
  timeoutMs: number,
): Promise<readonly StatementEvidence[]> {
  const results: StatementEvidence[] = [];
  for (const [executionOrder, statement] of statements.entries()) {
    const started = performance.now();
    const [result] = await connection.query({
      sql: statement.sql,
      timeout: timeoutMs,
    });
    if (Array.isArray(result)) {
      throw new Error(`Mutation ${statement.statementId} returned rows`);
    }
    const mutation = result as ResultSetHeader;
    if (mutation.affectedRows > statement.maxAffectedRows) {
      throw new Error(
        `${statement.statementId} affected ${mutation.affectedRows} rows, above its plan limit ${statement.maxAffectedRows}`,
      );
    }
    results.push({
      statementId: statement.statementId,
      executionOrder,
      affectedRows: mutation.affectedRows,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      resultDigest: computeEvidenceDigest({
        statementId: statement.statementId,
        affectedRows: mutation.affectedRows,
        changedRows: mutation.changedRows,
        warningStatus: mutation.warningStatus,
      }),
    });
  }
  return results;
}

function ids(rows: readonly DatabaseRow[]): ReadonlySet<string> {
  return new Set(rows.map((row) => String(row.id)));
}

function countReferentialViolations(snapshot: DatabaseStateSnapshot): number {
  const tables = snapshot.tables;
  const tenants = ids(tables.tenant ?? []);
  const warehouses = ids(tables.warehouse ?? []);
  const locations = ids(tables.location ?? []);
  const products = ids(tables.product ?? []);
  const lots = ids(tables.lot ?? []);
  const inventory = ids(tables.inventory_item ?? []);
  const orders = ids(tables.order_header ?? []);
  const lines = ids(tables.order_line ?? []);
  let violations = 0;
  const has = (set: ReadonlySet<string>, value: unknown): boolean =>
    set.has(String(value));

  for (const row of tables.warehouse ?? []) {
    if (!has(tenants, row.tenant_id)) violations += 1;
  }
  for (const row of tables.location ?? []) {
    if (!has(warehouses, row.warehouse_id)) violations += 1;
  }
  for (const row of tables.product ?? []) {
    if (!has(tenants, row.tenant_id)) violations += 1;
    if (
      row.canonical_product_id !== null &&
      !has(products, row.canonical_product_id)
    ) {
      violations += 1;
    }
  }
  for (const row of tables.lot ?? []) {
    if (!has(tenants, row.tenant_id) || !has(products, row.product_id)) {
      violations += 1;
    }
  }
  for (const row of tables.inventory_item ?? []) {
    if (
      !has(tenants, row.tenant_id) ||
      !has(warehouses, row.warehouse_id) ||
      !has(locations, row.location_id) ||
      !has(products, row.product_id) ||
      (row.lot_id !== null && !has(lots, row.lot_id))
    ) {
      violations += 1;
    }
  }
  for (const row of tables.serial_number ?? []) {
    if (!has(tenants, row.tenant_id) || !has(inventory, row.inventory_item_id)) {
      violations += 1;
    }
  }
  for (const row of tables.order_header ?? []) {
    if (!has(tenants, row.tenant_id) || !has(warehouses, row.warehouse_id)) {
      violations += 1;
    }
  }
  for (const row of tables.order_line ?? []) {
    if (!has(orders, row.order_id) || !has(products, row.product_id)) {
      violations += 1;
    }
  }
  for (const row of tables.allocation ?? []) {
    if (
      !has(tenants, row.tenant_id) ||
      !has(warehouses, row.warehouse_id) ||
      !has(lines, row.order_line_id) ||
      !has(inventory, row.inventory_item_id)
    ) {
      violations += 1;
    }
  }
  return violations;
}

function overAllocatedRows(snapshot: DatabaseStateSnapshot): number {
  const inventoryQuantity = new Map(
    (snapshot.tables.inventory_item ?? []).map((row) => [
      String(row.id),
      numeric(row.quantity),
    ]),
  );
  const allocated = new Map<string, number>();
  for (const allocation of snapshot.tables.allocation ?? []) {
    const id = String(allocation.inventory_item_id);
    allocated.set(id, (allocated.get(id) ?? 0) + numeric(allocation.quantity));
  }
  return [...allocated.entries()].filter(
    ([id, quantity]) => quantity > (inventoryQuantity.get(id) ?? -1),
  ).length;
}

function protectedOrderRowsChanged(
  before: DatabaseStateSnapshot,
  after: DatabaseStateSnapshot,
  protectedStates: readonly string[],
): number {
  const protectedSet = new Set(protectedStates);
  const afterById = new Map(
    (after.tables.order_header ?? []).map((row) => [String(row.id), row]),
  );
  return (before.tables.order_header ?? []).filter((row) => {
    if (!protectedSet.has(String(row.status))) return false;
    const current = afterById.get(String(row.id));
    return (
      current === undefined ||
      computeEvidenceDigest(current) !== computeEvidenceDigest(row)
    );
  }).length;
}

function invariantContext(
  contract: IntentContract,
  planIntegrityPassed: boolean,
  statementResults: readonly StatementEvidence[],
  before: DatabaseStateSnapshot,
  after: DatabaseStateSnapshot,
  secondRun: DatabaseStateSnapshot,
  rollback: DatabaseStateSnapshot,
): DatabaseInvariantContext {
  const delta = computeRowDelta(before, after);
  const touchedWarehouses = new Set<string>();
  const touchedTenants = new Set<string>();
  for (const change of delta) {
    for (const row of [change.before, change.after]) {
      if (row === null) continue;
      if (typeof row.warehouse_id === "string") {
        touchedWarehouses.add(row.warehouse_id);
      }
      if (typeof row.tenant_id === "string") touchedTenants.add(row.tenant_id);
    }
  }

  return {
    executionSucceeded: true,
    planIntegrityPassed,
    allowedWarehouses: contract.allowedWarehouses,
    touchedWarehouses: [...touchedWarehouses],
    allowedTenants: contract.allowedTenants,
    touchedTenants: [...touchedTenants],
    inventoryUnitsBefore: sumColumn(
      before.tables.inventory_item ?? [],
      "quantity",
    ),
    inventoryUnitsAfter: sumColumn(
      after.tables.inventory_item ?? [],
      "quantity",
    ),
    negativeInventoryRows: (after.tables.inventory_item ?? []).filter(
      (row) => numeric(row.quantity) < 0,
    ).length,
    overAllocatedRows: overAllocatedRows(after),
    lostLotOrSerialRows:
      computeEvidenceDigest({
        lots: before.tables.lot,
        serialNumbers: before.tables.serial_number,
      }) ===
      computeEvidenceDigest({
        lots: after.tables.lot,
        serialNumbers: after.tables.serial_number,
      })
        ? 0
        : 1,
    referentialIntegrityViolations: countReferentialViolations(after),
    protectedOrderRowsChanged: protectedOrderRowsChanged(
      before,
      after,
      contract.protectedOrderStates,
    ),
    affectedRows: statementResults.reduce(
      (sum, result) => sum + result.affectedRows,
      0,
    ),
    maxAffectedRows: contract.maxAffectedRows,
    afterStateDigest: after.digest,
    secondRunStateDigest: secondRun.digest,
    beforeStateDigest: before.digest,
    rollbackStateDigest: rollback.digest,
  };
}

export async function runLocalMysqlCandidate(
  options: LocalMysqlCandidateOptions,
): Promise<LocalMysqlCandidateResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const planIntegrity = validateSqlPlanIntegrity(
    options.plan,
    options.intentContract,
  );
  if (!planIntegrity.passed) {
    throw new Error(
      `Plan integrity failed: ${planIntegrity.violations
        .map((violation) => `${violation.statementId}:${violation.code}`)
        .join(", ")}`,
    );
  }

  const connection = await mysql.createConnection({
    uri: safeConnectionUri(options.connectionUri),
    decimalNumbers: true,
    dateStrings: true,
    multipleStatements: false,
    namedPlaceholders: false,
    supportBigNumbers: true,
  });
  const sandboxId =
    options.sandboxId ?? `local-mysql-${options.plan.candidateId}-${randomUUID()}`;
  const runId = options.runId ?? randomUUID();

  let transactionOpen = false;
  try {
    const [versionRows] = await connection.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    const version = String(versionRows[0]?.version ?? "");
    if (!version.startsWith(`${options.profile.mysqlVersion}`)) {
      throw new Error(
        `MySQL version mismatch: expected ${options.profile.mysqlVersion}, observed ${version}`,
      );
    }

    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    transactionOpen = true;
    const before = await captureState(connection, timeoutMs);
    assertBaseline(options.profile, before);

    for (const check of options.plan.preconditions) {
      const rows = await queryRows(connection, check.sql, timeoutMs);
      if (!expectationPassed(check.expectation, rows)) {
        throw new Error(`Precondition ${check.checkId} failed`);
      }
    }

    const statementResults = await executeStatements(
      connection,
      options.plan.statements,
      timeoutMs,
    );
    const after = await captureState(connection, timeoutMs);

    await connection.query("SAVEPOINT safecommit_before_idempotency");
    await executeStatements(connection, options.plan.statements, timeoutMs);
    const secondRun = await captureState(connection, timeoutMs);
    await connection.query("ROLLBACK TO SAVEPOINT safecommit_before_idempotency");

    await executeStatements(connection, options.plan.rollbackPlan, timeoutMs);
    const rollback = await captureState(connection, timeoutMs);
    const gates = evaluateDatabaseHardGates(
      invariantContext(
        options.intentContract,
        planIntegrity.passed,
        statementResults,
        before,
        after,
        secondRun,
        rollback,
      ),
    );
    const rowDelta = computeRowDelta(before, after);

    const evidence: DatabaseEvidence = {
      sessionId: options.sessionId,
      candidateId: options.plan.candidateId,
      sourceCommitSha: options.sourceCommitSha,
      snapshotId: options.profile.profileId,
      snapshotDigest: options.profile.fixtureSourceDigest,
      sandboxId,
      runId,
      planDigest: computeEvidenceDigest(options.plan),
      intentContractDigest: computeEvidenceDigest(options.intentContract),
      schemaFingerprint: options.profile.schemaFingerprint,
      beforeStateDigest: before.digest,
      afterStateDigest: after.digest,
      rollbackStateDigest: rollback.digest,
      statementResults: [...statementResults],
      rowDelta: [...rowDelta],
      invariantResults: [...gates.results],
      providerEvidence: {
        provenance: "local-test",
        executionProvider: "local-mysql",
        evaluationProvider: "local-deterministic",
        providerResourceIds: [],
        evidenceRefs: [],
      },
    };

    await connection.rollback();
    transactionOpen = false;
    return { evidence, gates, before, after, secondRun, rollback };
  } finally {
    if (transactionOpen) {
      await connection.rollback().catch(() => undefined);
    }
    await connection.end();
  }
}
