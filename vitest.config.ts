import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/{unit,integration,adversarial}/**/*.test.ts"],
    reporters: ["default", "json"],
    outputFile: {
      json: "artifacts/evidence/latest-vitest.json"
    },
    testTimeout: 15_000
  }
});
