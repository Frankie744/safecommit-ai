import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  LOGISTICS_TABLES,
  loadSafeCommitDatabaseProfile,
} from "@safeflash/orchestrator";
import { validateSqlPlanIntegrity } from "@safeflash/safety-policy";

describe("OpenBoxes-derived MySQL 8 profile", () => {
  it("loads a deterministic, source-attributed fixture manifest", async () => {
    const first = await loadSafeCommitDatabaseProfile();
    const second = await loadSafeCommitDatabaseProfile();

    expect(first.profileId).toBe("openboxes-mysql-v1");
    expect(first.fixtureKind).toBe("OpenBoxes-derived executable fixture");
    expect(first.mysqlVersion).toBe("8.0.36");
    expect(first.sourceRevision).toBe(
      "99fb3e61d2ba220dc1d83847e4852e2846ee17f0",
    );
    expect(first.fixtureSourceDigest).toBe(
      "7a061b129b0a65e1a6f189dbc7ff653fc3762a282fd8530f344892120cc28781",
    );
    expect(first.expectedBaselineDigest).toBe(
      "e983bcffebc5e550e80a3cdb0500a8321ef3ecdcc98a8b858a1e82e174331ab2",
    );
    expect(first.expectedBaselineDigest).toBe(second.expectedBaselineDigest);
    expect(first.fixtureSourceDigest).toBe(second.fixtureSourceDigest);
    expect(Object.keys(first.baseline.counts).sort()).toEqual(
      [...LOGISTICS_TABLES].sort(),
    );
    expect(first.baseline.inventoryUnits).toBe(34);
    expect(first.baseline.allocatedUnits).toBe(14);
  });

  it("defines exactly three AST-valid plans from one intent contract", async () => {
    const profile = await loadSafeCommitDatabaseProfile();
    expect(profile.candidates).toHaveLength(3);
    expect(new Set(profile.candidates.map((plan) => plan.candidateId)).size).toBe(
      3,
    );
    for (const candidate of profile.candidates) {
      expect(
        validateSqlPlanIntegrity(candidate, profile.intentContract),
      ).toMatchObject({
        passed: true,
        parser: "node-sql-parser/mysql",
      });
    }
  });

  it("preserves real relational traps in schema and synthetic seed", async () => {
    const profile = await loadSafeCommitDatabaseProfile();
    const [schema, seed] = await Promise.all([
      readFile(profile.schemaPath, "utf8"),
      readFile(profile.seedPath, "utf8"),
    ]);

    for (const table of LOGISTICS_TABLES) {
      expect(schema).toContain(`CREATE TABLE ${table}`);
    }
    expect(schema.match(/FOREIGN KEY/gu)?.length).toBeGreaterThanOrEqual(20);
    expect(schema).toContain("UNIQUE KEY uq_serial_tenant_value");
    expect(seed).toContain("'order-cancelled-la'");
    expect(seed).toContain("'order-shipped-la'");
    expect(seed).toContain("'allocation-cancelled-ny'");
    expect(seed).toContain("'product-other-tenant'");
  });
});
