import { describe, expect, it } from "vitest";

import {
  computeRowDelta,
  createDatabaseStateSnapshot,
} from "@safeflash/orchestrator";

describe("explainable row delta", () => {
  it("reports inserted, updated, and deleted rows deterministically", () => {
    const before = createDatabaseStateSnapshot({
      allocation: [
        { id: "allocation-a", quantity: 3, warehouse_id: "warehouse-la" },
        { id: "allocation-deleted", quantity: 1, warehouse_id: "warehouse-la" },
      ],
      product: [{ id: "product-a", active: true }],
    });
    const after = createDatabaseStateSnapshot({
      product: [
        { id: "product-a", active: true },
        { id: "product-new", active: true },
      ],
      allocation: [
        { id: "allocation-a", quantity: 0, warehouse_id: "warehouse-la" },
      ],
    });

    expect(computeRowDelta(before, after)).toEqual([
      expect.objectContaining({
        table: "allocation",
        primaryKey: { id: "allocation-a" },
        changeKind: "updated",
      }),
      expect.objectContaining({
        table: "allocation",
        primaryKey: { id: "allocation-deleted" },
        changeKind: "deleted",
      }),
      expect.objectContaining({
        table: "product",
        primaryKey: { id: "product-new" },
        changeKind: "inserted",
      }),
    ]);
    expect(before.digest).not.toBe(after.digest);
  });
});
