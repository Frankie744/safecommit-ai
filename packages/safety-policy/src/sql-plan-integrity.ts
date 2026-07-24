import sqlParser from "node-sql-parser";

import type {
  CandidateChangePlan,
  DatabaseOperationKind,
  IntentContract,
  SqlStatement,
} from "@safeflash/domain";

const { Parser } = sqlParser;

export type SqlPlanIntegrityViolationCode =
  | "PARSE_ERROR"
  | "MULTIPLE_STATEMENTS"
  | "NON_SELECT_PRECONDITION"
  | "FORBIDDEN_STATEMENT_TYPE"
  | "OPERATION_MISMATCH"
  | "TABLE_OUTSIDE_CONTRACT"
  | "AFFECTED_ROW_LIMIT_EXCEEDED"
  | "UNBOUNDED_MUTATION"
  | "NON_DETERMINISTIC_MUTATION"
  | "FORBIDDEN_DATABASE_FEATURE";

export interface SqlPlanIntegrityViolation {
  code: SqlPlanIntegrityViolationCode;
  statementId: string;
  message: string;
}

export interface SqlPlanIntegrityResult {
  passed: boolean;
  violations: readonly SqlPlanIntegrityViolation[];
  referencedTables: readonly string[];
  parser: "node-sql-parser/mysql";
}

type AstRecord = Record<string, unknown> & { type?: unknown };

const parser = new Parser();
const forbiddenFunctions = new Set([
  "BENCHMARK",
  "GET_LOCK",
  "IS_FREE_LOCK",
  "IS_USED_LOCK",
  "LOAD_FILE",
  "MASTER_POS_WAIT",
  "RELEASE_ALL_LOCKS",
  "RELEASE_LOCK",
  "SLEEP",
  "SYS_EXEC",
  "SYS_EVAL",
]);

const nonDeterministicFunctions = new Set([
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "NOW",
  "RAND",
  "SYSDATE",
  "UUID",
  "UUID_SHORT",
]);

function parseSingleStatement(
  sql: string,
): { ast?: AstRecord; error?: string } {
  try {
    const parsed = parser.astify(sql, { database: "MySQL" }) as unknown;
    if (Array.isArray(parsed)) {
      return {
        error:
          parsed.length === 1
            ? "SQL parser returned an unexpected statement array"
            : "exactly one SQL statement is permitted",
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { error: "SQL parser did not return a statement AST" };
    }
    return { ast: parsed as AstRecord };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "unknown SQL parse error",
    };
  }
}

function tableNames(sql: string): readonly string[] {
  const entries = parser.tableList(sql, { database: "MySQL" }) as string[];
  return entries.map((entry) => entry.split("::").at(-1) ?? "").filter(Boolean);
}

function functionName(record: Record<string, unknown>): string | undefined {
  if (record.type !== "function" && record.type !== "aggr_func") {
    return undefined;
  }
  if (typeof record.name === "string") return record.name.toUpperCase();
  if (
    record.name !== null &&
    typeof record.name === "object" &&
    Array.isArray((record.name as { name?: unknown }).name)
  ) {
    const parts = (record.name as { name: unknown[] }).name
      .map((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { value?: unknown }).value === "string"
          ? (part as { value: string }).value
          : "",
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join(".").toUpperCase();
  }
  return undefined;
}

function containsFunction(
  value: unknown,
  names: ReadonlySet<string>,
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = containsFunction(item, names);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const name = functionName(record);
  if (name !== undefined && names.has(name)) return name;
  for (const item of Object.values(record)) {
    const found = containsFunction(item, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

function containsForbiddenFeature(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = containsForbiddenFeature(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  if (record.into !== undefined && record.into !== null) {
    const into = record.into as Record<string, unknown>;
    if (
      Object.entries(into).some(
        ([key, item]) =>
          key !== "position" && item !== null && item !== undefined,
      )
    ) {
      return "SELECT INTO/OUTFILE is forbidden";
    }
  }
  const forbiddenFunction = functionName(record);
  if (
    forbiddenFunction !== undefined &&
    forbiddenFunctions.has(forbiddenFunction)
  ) {
    return `database function ${forbiddenFunction} is forbidden`;
  }
  if (
    record.type === "var" ||
    record.type === "origin" ||
    record.type === "procedure"
  ) {
    return `database feature ${String(record.type)} is forbidden`;
  }
  for (const item of Object.values(record)) {
    const found = containsForbiddenFeature(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

function operationForAstType(type: unknown): DatabaseOperationKind | undefined {
  if (type === "insert" || type === "update" || type === "delete") return type;
  return undefined;
}

function validateMutation(
  statement: SqlStatement,
  contract: IntentContract,
  violations: SqlPlanIntegrityViolation[],
  referencedTables: Set<string>,
): void {
  const parsed = parseSingleStatement(statement.sql);
  if (parsed.error !== undefined || parsed.ast === undefined) {
    violations.push({
      code: parsed.error?.includes("exactly one")
        ? "MULTIPLE_STATEMENTS"
        : "PARSE_ERROR",
      statementId: statement.statementId,
      message: parsed.error ?? "SQL parse failed",
    });
    return;
  }

  const operation = operationForAstType(parsed.ast.type);
  if (operation === undefined) {
    violations.push({
      code: "FORBIDDEN_STATEMENT_TYPE",
      statementId: statement.statementId,
      message: `P0 permits transaction-safe DML only, received ${String(parsed.ast.type)}`,
    });
  } else if (
    operation !== statement.operation ||
    !contract.operationKinds.includes(operation)
  ) {
    violations.push({
      code: "OPERATION_MISMATCH",
      statementId: statement.statementId,
      message: `AST operation ${operation} does not match the plan or intent contract`,
    });
  }

  if (
    (operation === "update" || operation === "delete") &&
    (parsed.ast.where === null || parsed.ast.where === undefined)
  ) {
    violations.push({
      code: "UNBOUNDED_MUTATION",
      statementId: statement.statementId,
      message: "UPDATE and DELETE statements require an AST-visible WHERE clause",
    });
  }

  if (statement.maxAffectedRows > contract.maxAffectedRows) {
    violations.push({
      code: "AFFECTED_ROW_LIMIT_EXCEEDED",
      statementId: statement.statementId,
      message: "statement row limit exceeds the server-owned intent contract",
    });
  }

  for (const table of tableNames(statement.sql)) {
    referencedTables.add(table);
    if (
      !contract.allowedTables.some(
        (allowed) => allowed.toLowerCase() === table.toLowerCase(),
      )
    ) {
      violations.push({
        code: "TABLE_OUTSIDE_CONTRACT",
        statementId: statement.statementId,
        message: `table ${table} is outside the intent contract`,
      });
    }
  }

  const forbidden = containsForbiddenFeature(parsed.ast);
  if (forbidden !== undefined) {
    violations.push({
      code: "FORBIDDEN_DATABASE_FEATURE",
      statementId: statement.statementId,
      message: forbidden,
    });
  }

  if (contract.idempotencyRequired) {
    const nonDeterministic = containsFunction(
      parsed.ast,
      nonDeterministicFunctions,
    );
    if (nonDeterministic !== undefined) {
      violations.push({
        code: "NON_DETERMINISTIC_MUTATION",
        statementId: statement.statementId,
        message: `idempotent plans cannot use volatile database function ${nonDeterministic}`,
      });
    }
  }
}

export function validateSqlPlanIntegrity(
  plan: CandidateChangePlan,
  contract: IntentContract,
): SqlPlanIntegrityResult {
  const violations: SqlPlanIntegrityViolation[] = [];
  const referencedTables = new Set<string>();

  for (const check of plan.preconditions) {
    const parsed = parseSingleStatement(check.sql);
    if (parsed.error !== undefined || parsed.ast === undefined) {
      violations.push({
        code: parsed.error?.includes("exactly one")
          ? "MULTIPLE_STATEMENTS"
          : "PARSE_ERROR",
        statementId: check.checkId,
        message: parsed.error ?? "SQL parse failed",
      });
      continue;
    }
    if (parsed.ast.type !== "select") {
      violations.push({
        code: "NON_SELECT_PRECONDITION",
        statementId: check.checkId,
        message: "preconditions must be read-only SELECT statements",
      });
    }
    for (const table of tableNames(check.sql)) {
      referencedTables.add(table);
      if (
        !contract.allowedTables.some(
          (allowed) => allowed.toLowerCase() === table.toLowerCase(),
        )
      ) {
        violations.push({
          code: "TABLE_OUTSIDE_CONTRACT",
          statementId: check.checkId,
          message: `table ${table} is outside the intent contract`,
        });
      }
    }
    const forbidden = containsForbiddenFeature(parsed.ast);
    if (forbidden !== undefined) {
      violations.push({
        code: "FORBIDDEN_DATABASE_FEATURE",
        statementId: check.checkId,
        message: forbidden,
      });
    }
  }

  for (const statement of [...plan.statements, ...plan.rollbackPlan]) {
    validateMutation(statement, contract, violations, referencedTables);
  }

  return {
    passed: violations.length === 0,
    violations,
    referencedTables: [...referencedTables].sort(),
    parser: "node-sql-parser/mysql",
  };
}
