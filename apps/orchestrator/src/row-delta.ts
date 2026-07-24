import {
  computeEvidenceDigest,
  type RowDelta,
} from "@safeflash/domain";

export type DatabaseScalar = string | number | boolean | null;
export type DatabaseRow = Readonly<Record<string, DatabaseScalar>>;
export type DatabaseTables = Readonly<
  Record<string, readonly DatabaseRow[]>
>;

export interface DatabaseStateSnapshot {
  tables: DatabaseTables;
  digest: string;
}

function rowKey(row: DatabaseRow): string {
  const id = row.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Every SafeCommit fixture row must have a string id");
  }
  return id;
}

export function createDatabaseStateSnapshot(
  tables: DatabaseTables,
): DatabaseStateSnapshot {
  const normalized: Record<string, readonly DatabaseRow[]> = {};
  for (const table of Object.keys(tables).sort()) {
    normalized[table] = [...(tables[table] ?? [])].sort((left, right) =>
      rowKey(left).localeCompare(rowKey(right)),
    );
  }
  return {
    tables: normalized,
    digest: computeEvidenceDigest(normalized),
  };
}

export function computeRowDelta(
  before: DatabaseStateSnapshot,
  after: DatabaseStateSnapshot,
): readonly RowDelta[] {
  const result: RowDelta[] = [];
  const tables = new Set([
    ...Object.keys(before.tables),
    ...Object.keys(after.tables),
  ]);

  for (const table of [...tables].sort()) {
    const beforeRows = new Map(
      (before.tables[table] ?? []).map((row) => [rowKey(row), row]),
    );
    const afterRows = new Map(
      (after.tables[table] ?? []).map((row) => [rowKey(row), row]),
    );
    const rowIds = new Set([...beforeRows.keys(), ...afterRows.keys()]);

    for (const id of [...rowIds].sort()) {
      const beforeRow = beforeRows.get(id);
      const afterRow = afterRows.get(id);
      if (
        beforeRow !== undefined &&
        afterRow !== undefined &&
        computeEvidenceDigest(beforeRow) === computeEvidenceDigest(afterRow)
      ) {
        continue;
      }
      result.push({
        table,
        primaryKey: { id },
        changeKind:
          beforeRow === undefined
            ? "inserted"
            : afterRow === undefined
              ? "deleted"
              : "updated",
        before: beforeRow === undefined ? null : { ...beforeRow },
        after: afterRow === undefined ? null : { ...afterRow },
      });
    }
  }

  return result;
}
