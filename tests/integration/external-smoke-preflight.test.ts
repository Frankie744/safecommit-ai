import { describe, expect, it } from "vitest";

import {
  configurationBlockers,
  runProvider,
  runSelectedProviders,
  selectedProviders,
} from "../../scripts/smoke-external";

describe("external provider smoke preflight", () => {
  it("reports every missing provider requirement before network access", async () => {
    const fireworks = await runProvider("fireworks", {});
    expect(fireworks).toMatchObject({
      status: "blocked",
      blockers: [
        "SAFEFLASH_ALLOW_LIVE must equal true",
        "FIREWORKS_API_KEY is required",
        "FIREWORKS_MODEL is required",
      ],
    });
    expect(fireworks.reason).toContain("before network access");
    expect(fireworks.nextAction).toContain("--provider=fireworks");

    const coderabbit = await runProvider("coderabbit", {});
    expect(coderabbit.status).toBe("blocked");
    expect(coderabbit.blockers).toEqual([
      "SAFEFLASH_ALLOW_LIVE must equal true",
      "GITHUB_TOKEN is required",
      "GITHUB_OWNER is required",
      "GITHUB_REPO is required",
      "SAFEFLASH_SMOKE_PR_NUMBER is required",
      "SAFEFLASH_SMOKE_PR_HEAD_SHA is required",
    ]);
    expect(coderabbit.externalEffects.join(" ")).toContain("Read-only");
  });

  it("blocks malformed optional endpoints and exact-head inputs locally", () => {
    expect(
      configurationBlockers("fireworks", {
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "secret-not-returned",
        FIREWORKS_MODEL: "accounts/fireworks/models/example",
        FIREWORKS_BASE_URL: "https://credential-collector.example/v1",
      }),
    ).toEqual([
      "FIREWORKS_BASE_URL must be the official https://api.fireworks.ai/inference/v1 endpoint",
    ]);
    expect(
      configurationBlockers("daytona", {
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "secret-not-returned",
        DAYTONA_API_URL: "https://credential-collector.example/api",
      }),
    ).toEqual([
      "DAYTONA_API_URL must be the official https://app.daytona.io/api endpoint",
    ]);

    const blockers = configurationBlockers("coderabbit", {
      SAFEFLASH_ALLOW_LIVE: "true",
      GITHUB_TOKEN: "secret-not-returned",
      GITHUB_OWNER: "owner",
      GITHUB_REPO: "repo",
      SAFEFLASH_SMOKE_PR_NUMBER: "not-a-number",
      SAFEFLASH_SMOKE_PR_HEAD_SHA: "main",
      CODERABBIT_REVIEW_TIMEOUT_MS: "999",
      CODERABBIT_POLL_INTERVAL_MS: "70000",
    });
    expect(blockers).toEqual([
      "SAFEFLASH_SMOKE_PR_NUMBER must be a positive safe integer",
      "SAFEFLASH_SMOKE_PR_HEAD_SHA must be the exact full 40- or 64-character PR head SHA",
      "CODERABBIT_REVIEW_TIMEOUT_MS must be an integer from 1000 through 900000",
      "CODERABBIT_POLL_INTERVAL_MS must be an integer from 250 through 60000 and not exceed the timeout",
    ]);
    expect(blockers.join(" ")).not.toContain("secret-not-returned");
    expect(
      configurationBlockers("github", {
        SAFEFLASH_ALLOW_LIVE: "true",
        GITHUB_TOKEN: "secret-not-returned",
        GITHUB_OWNER: "../attacker",
        GITHUB_REPO: "repo",
        GITHUB_BASE_BRANCH: "refs//heads/main",
      }),
    ).toEqual([
      "GITHUB_OWNER is not a safe GitHub owner name",
      "GITHUB_BASE_BRANCH is not a safe Git ref",
    ]);
  });

  it("selects only known provider names", () => {
    expect(selectedProviders([])).toEqual([
      "fireworks",
      "daytona",
      "braintrust",
      "github",
      "coderabbit",
    ]);
    expect(selectedProviders(["--provider=github"])).toEqual(["github"]);
    expect(() => selectedProviders(["--provider=unknown"])).toThrow(
      /Unknown --provider/u,
    );
  });

  it("preflights every requested provider before running any external operation", async () => {
    const calls: string[] = [];
    const results = await runSelectedProviders(
      ["fireworks", "daytona"],
      {
        SAFEFLASH_ALLOW_LIVE: "true",
        FIREWORKS_API_KEY: "configured-but-must-not-be-used",
        FIREWORKS_MODEL: "accounts/fireworks/models/example",
      },
      async (provider) => {
        calls.push(provider);
        throw new Error("runner must not be reached when aggregate preflight fails");
      },
    );

    expect(calls).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      provider: "fireworks",
      status: "blocked",
      blockers: [
        "Aggregate preflight aborted because another requested provider is not configured",
      ],
    });
    expect(results[1]).toMatchObject({
      provider: "daytona",
      status: "blocked",
      blockers: ["DAYTONA_API_KEY is required"],
    });
  });
});
