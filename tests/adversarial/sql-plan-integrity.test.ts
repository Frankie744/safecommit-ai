import { describe, expect, it } from "vitest";

import { CandidateChangePlanSchema } from "@safeflash/domain";
import { validateSqlPlanIntegrity } from "@safeflash/safety-policy";
import {
  logisticsCandidatePlan,
  logisticsIntentContract,
} from "../fixtures/database";

describe("MySQL AST plan integrity", () => {
  it("accepts a bounded, allowlisted transaction plan", () => {
    const result = validateSqlPlanIntegrity(
      logisticsCandidatePlan(),
      logisticsIntentContract(),
    );
    expect(result.passed).toBe(true);
    expect(result.parser).toBe("node-sql-parser/mysql");
    expect(result.referencedTables).toEqual([
      "allocation",
      "order_header",
      "order_line",
    ]);
  });

  it.each([
    [
      "DDL",
      "CREATE TABLE stolen (id INT)",
      "FORBIDDEN_STATEMENT_TYPE",
    ],
    [
      "unbounded update",
      "UPDATE allocation SET quantity = 0",
      "UNBOUNDED_MUTATION",
    ],
    [
      "out-of-contract table",
      "UPDATE user_account SET is_admin = 1 WHERE id = 'attacker'",
      "TABLE_OUTSIDE_CONTRACT",
    ],
    [
      "multiple statements",
      "UPDATE allocation SET quantity = 0 WHERE id = 'a'; DROP TABLE allocation",
      "MULTIPLE_STATEMENTS",
    ],
  ])("rejects %s using parsed SQL evidence", (_label, sql, code) => {
    const base = logisticsCandidatePlan();
    const plan = CandidateChangePlanSchema.parse({
      ...base,
      statements: [{ ...base.statements[0], sql }],
    });
    const result = validateSqlPlanIntegrity(plan, logisticsIntentContract());
    expect(result.passed).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(code);
  });

  it("does not allow a model to turn a precondition into a mutation", () => {
    const base = logisticsCandidatePlan();
    const plan = CandidateChangePlanSchema.parse({
      ...base,
      preconditions: [
        {
          ...base.preconditions[0],
          sql: "DELETE FROM allocation WHERE id = 'allocation-cancelled-la'",
        },
      ],
    });
    expect(
      validateSqlPlanIntegrity(plan, logisticsIntentContract()).violations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NON_SELECT_PRECONDITION" }),
      ]),
    );
  });
});
