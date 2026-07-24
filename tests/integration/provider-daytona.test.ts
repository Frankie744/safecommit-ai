import { describe, expect, it } from "vitest";

import type { CandidatePatch } from "@safeflash/domain";
import {
  DEFAULT_DAYTONA_COMMAND_POLICY,
  DAYTONA_DELETE_MAX_ATTEMPTS,
  DaytonaAdapter,
  DaytonaAttemptError,
  ProviderResponseError,
  createDaytonaClient,
  readDaytonaConfig,
  type DaytonaClientPort,
  type DaytonaConfig,
  type DaytonaSandboxPort,
} from "@safeflash/integrations";

const COMMIT = "a".repeat(40);
const VALIDATED_TREE = "b".repeat(40);
const POLICY = {
  policyVersion: "policy-v1",
  allowedPatchPaths: ["fixtures/battery-controller/src/**"],
  maxChangedFiles: 1,
  maxChangedLines: 120,
} as const;

const CONFIG: DaytonaConfig = {
  mode: "live",
  apiKey: "test-only-not-a-live-key",
  retainSandboxes: false,
  createTimeoutSeconds: 90,
  deleteTimeoutSeconds: 60,
  ttlMinutes: 10,
};

const CANDIDATE: CandidatePatch = {
  candidateId: "candidate-daytona",
  strategy: "fail-closed",
  hypothesis: "Latch the sensor fault and disable charging.",
  unifiedDiff:
    "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -1 +1 @@\n-old\n+new\n",
  expectedSafetyEffect: ["charging is disabled"],
  risks: ["manual fault clear is required"],
  testsToRun: ["this-is-descriptive-and-never-executed"],
};

class FakeDaytona implements DaytonaClientPort {
  readonly transport = "local-test" as const;
  readonly events: string[] = [];
  readonly commands: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }[] = [];
  readonly cloneArgs: unknown[][] = [];
  readonly createParams: unknown[] = [];
  failCommand?: string;
  failClone = false;
  failDelete = false;
  createError?: unknown;
  deleteFailuresRemaining = 0;
  wrongCommit = false;
  smokeMode = false;

  readonly sandbox: DaytonaSandboxPort = {
    id: "sandbox-contract-id",
    git: {
      clone: async (...args) => {
        this.events.push("clone");
        this.cloneArgs.push(args);
        if (this.failClone) throw new Error("secret clone transport detail");
      },
    },
    fs: {
      uploadFile: async (file, remotePath) => {
        this.events.push("upload");
        expect(remotePath).toBe("/tmp/safeflash-candidate.patch");
        expect(file.toString("utf8")).toBe(CANDIDATE.unifiedDiff);
      },
    },
    process: {
      executeCommand: async (command, cwd, env, timeout) => {
        this.events.push(`command:${command}`);
        this.commands.push({ command, cwd, env, timeout });
        if (this.smokeMode) {
          return { exitCode: 0, result: "SAFEFLASH_DAYTONA_SMOKE" };
        }
        if (command === "git rev-parse HEAD") {
          return {
            exitCode: 0,
            result: this.wrongCommit ? "c".repeat(40) : COMMIT,
          };
        }
        if (command === "git write-tree") {
          return { exitCode: 0, result: VALIDATED_TREE };
        }
        return {
          exitCode: this.failCommand === command ? 1 : 0,
          result: this.failCommand === command ? "trusted command failed" : "ok",
        };
      },
    },
    updateNetworkSettings: async ({ networkBlockAll }) => {
      this.events.push(`network:${networkBlockAll}`);
    },
  };

  async create(params: unknown): Promise<DaytonaSandboxPort> {
    this.events.push("create");
    this.createParams.push(params);
    if (this.createError !== undefined) throw this.createError;
    return this.sandbox;
  }

  async delete(): Promise<void> {
    this.events.push("delete");
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining -= 1;
      throw new Error("secret transient cleanup transport detail");
    }
    if (this.failDelete) throw new Error("secret cleanup transport detail");
  }
}

describe("Daytona isolation contract", () => {
  it("rejects a credential-bearing API endpoint during configuration", () => {
    expect(() =>
      readDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured-for-contract-test",
        DAYTONA_API_URL: "https://embedded:credential@daytona.example/api",
      }),
    ).toThrow(ProviderResponseError);
    expect(() =>
      readDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured-for-contract-test",
        DAYTONA_API_URL: "https://credential-collector.example/api",
      }),
    ).toThrow(ProviderResponseError);
    expect(
      readDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured-for-contract-test",
        DAYTONA_API_URL: "https://app.daytona.io/api",
      }).apiUrl,
    ).toBe("https://app.daytona.io/api");
    expect(() =>
      createDaytonaClient({
        ...CONFIG,
        apiUrl: "https://credential-collector.example/api",
      }),
    ).toThrow(ProviderResponseError);
    expect(() =>
      readDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured-for-contract-test",
        SAFEFLASH_RETAIN_SANDBOXES: "true",
      }),
    ).toThrow(/requires every Daytona sandbox to be deleted/u);
    expect(
      readDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured-for-contract-test",
        SAFEFLASH_RETAIN_SANDBOXES: "false",
      }).retainSandboxes,
    ).toBe(false);
    expect(
      () =>
        new DaytonaAdapter(
          { ...CONFIG, retainSandboxes: true },
          new FakeDaytona(),
        ),
    ).toThrow(/cannot retain Daytona sandboxes/u);
  });

  it("clones an exact commit, blocks network, runs only trusted commands, and destroys", async () => {
    const fake = new FakeDaytona();
    let time = 0;
    const adapter = new DaytonaAdapter(
      CONFIG,
      fake,
      DEFAULT_DAYTONA_COMMAND_POLICY,
      () => new Date((time += 10)),
    );
    const result = await adapter.validateCandidate({
      runId: "run-daytona-1",
      sessionId: "session-daytona",
      candidate: CANDIDATE,
      repository: {
        repoUrl: "https://github.com/example/safeflash.git",
        commitSha: COMMIT,
      },
      policy: POLICY,
    });

    expect(result.data.passed).toBe(true);
    expect(result.data.destroyed).toBe(true);
    expect(result.data.patchDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.data.validatedTreeSha).toBe(VALIDATED_TREE);
    expect(result.data.commands).toHaveLength(
      DEFAULT_DAYTONA_COMMAND_POLICY.length,
    );
    expect(fake.cloneArgs[0]).toEqual([
      "https://github.com/example/safeflash.git",
      "/workspace/safeflash-repository",
      undefined,
      COMMIT,
    ]);
    expect(fake.createParams[0]).toMatchObject({
      public: false,
      ephemeral: true,
      domainAllowList: "github.com,*.githubusercontent.com",
    });
    expect(fake.events.indexOf("clone")).toBeLessThan(
      fake.events.indexOf("network:true"),
    );
    expect(fake.events.indexOf("network:true")).toBeLessThan(
      fake.events.indexOf("upload"),
    );
    expect(fake.events.at(-1)).toBe("delete");
    expect(fake.commands.map((command) => command.command)).toEqual(
      DEFAULT_DAYTONA_COMMAND_POLICY.map((command) => command.command),
    );
    expect(fake.commands.some((command) => command.command.includes(CANDIDATE.testsToRun[0]!)))
      .toBe(false);
    expect(fake.commands.every((command) => command.env === undefined)).toBe(true);
    expect(fake.commands.every((command) => (command.timeout ?? 0) > 0)).toBe(
      true,
    );
    expect(
      fake.commands.find((command) => command.command.startsWith("cmake -S"))
        ?.command,
    ).toContain("fixtures/battery-controller");
    expect(
      fake.commands
        .filter((command) => command.command.startsWith("ctest "))
        .every((command) => command.command.includes("--no-tests=error")),
    ).toBe(true);
    const artifactManifest = result.data.commands.find(
      (command) => command.id.endsWith(":artifact-manifest"),
    );
    expect(artifactManifest?.artifactHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      result.data.commands
        .filter((command) => command !== artifactManifest)
        .every((command) => command.artifactHash === undefined),
    ).toBe(true);
    expect(result.data.commands.every((command) => command.stdoutHash !== undefined))
      .toBe(true);
  });

  it("rejects a command policy whose safety command was replaced", () => {
    const safetyIndex = DEFAULT_DAYTONA_COMMAND_POLICY.findIndex(
      (definition) => definition.id === "safety-tests",
    );
    const runtimeMutable = DEFAULT_DAYTONA_COMMAND_POLICY as unknown as {
      command: string;
    }[];
    expect(() => {
      runtimeMutable[safetyIndex]!.command = "true";
    }).toThrow(TypeError);
    expect(DEFAULT_DAYTONA_COMMAND_POLICY[safetyIndex]?.command).not.toBe("true");

    const modified = DEFAULT_DAYTONA_COMMAND_POLICY.map((definition) =>
      definition.id === "safety-tests"
        ? { ...definition, command: "true" }
        : definition,
    );
    expect(() => new DaytonaAdapter(CONFIG, new FakeDaytona(), modified)).toThrow(
      /command policy was modified/u,
    );
  });

  it("does not retain a caller-owned policy that changes after construction", async () => {
    const mutablePolicy = DEFAULT_DAYTONA_COMMAND_POLICY.map((definition) => ({
      ...definition,
    }));
    const fake = new FakeDaytona();
    const adapter = new DaytonaAdapter(CONFIG, fake, mutablePolicy);
    const safety = mutablePolicy.find(
      (definition) => definition.id === "safety-tests",
    )!;
    safety.command = "true";

    const result = await adapter.validateCandidate({
      runId: "run-policy-alias",
      sessionId: "session-daytona",
      candidate: CANDIDATE,
      repository: {
        repoUrl: "https://github.com/example/safeflash.git",
        commitSha: COMMIT,
      },
      policy: POLICY,
    });
    expect(result.data.passed).toBe(true);
    expect(fake.commands.some((command) => command.command === "true")).toBe(
      false,
    );
    expect(fake.commands.map((command) => command.command)).toEqual(
      DEFAULT_DAYTONA_COMMAND_POLICY.map((definition) => definition.command),
    );
  });

  it("stops after a trusted command failure but still destroys the sandbox", async () => {
    const fake = new FakeDaytona();
    fake.failCommand = "cmake --build build --parallel 2";
    const result = await new DaytonaAdapter(CONFIG, fake).validateCandidate({
      runId: "run-daytona-fail",
      sessionId: "session-daytona",
      candidate: CANDIDATE,
      repository: {
        repoUrl: "https://github.com/example/safeflash.git",
        commitSha: COMMIT,
      },
      policy: POLICY,
    });
    expect(result.data.passed).toBe(false);
    expect(result.data.commands.at(-1)?.exitCode).toBe(1);
    expect(fake.events.at(-1)).toBe("delete");
    expect(fake.commands).toHaveLength(6);
  });

  it("retries sandbox deletion within a fixed bound before returning evidence", async () => {
    const fake = new FakeDaytona();
    fake.deleteFailuresRemaining = DAYTONA_DELETE_MAX_ATTEMPTS - 1;
    const result = await new DaytonaAdapter(CONFIG, fake).validateCandidate({
      runId: "run-daytona-cleanup-retry",
      sessionId: "session-daytona",
      candidate: CANDIDATE,
      repository: {
        repoUrl: "https://github.com/example/safeflash.git",
        commitSha: COMMIT,
      },
      policy: POLICY,
    });

    expect(result.data).toMatchObject({
      retained: false,
      destroyed: true,
      passed: true,
    });
    expect(fake.events.filter((event) => event === "delete")).toHaveLength(
      DAYTONA_DELETE_MAX_ATTEMPTS,
    );
  });

  it("returns sanitized structured attempt evidence after post-create and cleanup failures", async () => {
    const failedClone = new FakeDaytona();
    failedClone.failClone = true;
    let cloneError: unknown;
    try {
      await new DaytonaAdapter(CONFIG, failedClone, undefined, () => new Date(1234))
        .validateCandidate({
          runId: "run-post-create-failure",
          sessionId: "session-daytona",
          candidate: CANDIDATE,
          repository: {
            repoUrl: "https://github.com/example/safeflash.git",
            commitSha: COMMIT,
          },
          policy: POLICY,
        });
    } catch (error) {
      cloneError = error;
    }
    expect(cloneError).toBeInstanceOf(DaytonaAttemptError);
    expect((cloneError as DaytonaAttemptError).retryable).toBe(true);
    expect((cloneError as DaytonaAttemptError).attempt).toEqual({
      sandboxId: "sandbox-contract-id",
      runId: "run-post-create-failure",
      candidateId: CANDIDATE.candidateId,
      capturedAt: new Date(1234).toISOString(),
      disposition: "failed-destroyed",
    });
    expect((cloneError as Error).message).not.toMatch(/secret|clone transport/iu);
    expect(failedClone.events.at(-1)).toBe("delete");

    const failedCleanup = new FakeDaytona();
    failedCleanup.failClone = true;
    failedCleanup.failDelete = true;
    await expect(
      new DaytonaAdapter(CONFIG, failedCleanup).validateCandidate({
        runId: "run-cleanup-failure",
        sessionId: "session-daytona",
        candidate: CANDIDATE,
        repository: {
          repoUrl: "https://github.com/example/safeflash.git",
          commitSha: COMMIT,
        },
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      name: "DaytonaAttemptError",
      retryable: false,
      attempt: {
        sandboxId: "sandbox-contract-id",
        runId: "run-cleanup-failure",
        candidateId: CANDIDATE.candidateId,
        disposition: "cleanup-failed",
      },
    });
    expect(failedCleanup.events.filter((event) => event === "delete")).toHaveLength(
      DAYTONA_DELETE_MAX_ATTEMPTS,
    );

    const nonRetryable = new FakeDaytona();
    nonRetryable.wrongCommit = true;
    await expect(
      new DaytonaAdapter(CONFIG, nonRetryable).validateCandidate({
        runId: "run-nonretryable-failure",
        sessionId: "session-daytona",
        candidate: CANDIDATE,
        repository: {
          repoUrl: "https://github.com/example/safeflash.git",
          commitSha: COMMIT,
        },
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      name: "DaytonaAttemptError",
      retryable: false,
      attempt: { disposition: "failed-destroyed" },
    });
  });

  it("rejects mutable refs or credential-bearing repository URLs before creation", async () => {
    const fake = new FakeDaytona();
    const adapter = new DaytonaAdapter(CONFIG, fake);
    await expect(
      adapter.validateCandidate({
        runId: "run-invalid",
        sessionId: "session-daytona",
        candidate: CANDIDATE,
        repository: {
          repoUrl: "https://token@github.com/example/safeflash.git",
          commitSha: "main",
        },
        policy: POLICY,
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(fake.events).toEqual([]);
  });

  it("classifies injected 401, 403, and 422 create failures as nonretryable", async () => {
    for (const status of [401, 403, 422]) {
      const fake = new FakeDaytona();
      fake.createError = {
        status,
        response: { data: `secret-daytona-body-${status}` },
      };
      const promise = new DaytonaAdapter(CONFIG, fake).validateCandidate({
        runId: `run-daytona-${status}`,
        sessionId: "session-daytona",
        candidate: CANDIDATE,
        repository: {
          repoUrl: "https://github.com/example/safeflash.git",
          commitSha: COMMIT,
        },
        policy: POLICY,
      });
      await expect(promise).rejects.toMatchObject({
        name: "ProviderResponseError",
        provider: "daytona",
        retryable: false,
        message: "Daytona sandbox validation failed",
      });
      await expect(promise).rejects.not.toThrow(/secret-daytona-body/u);
    }
  });

  it("classifies injected 429 and timeout create failures as retryable", async () => {
    for (const error of [
      { statusCode: 429, response: { data: "secret-rate-limit-body" } },
      Object.assign(new Error("Daytona request timed out secret-timeout-body"), {
        code: "ETIMEDOUT",
      }),
    ]) {
      const fake = new FakeDaytona();
      fake.createError = error;
      const promise = new DaytonaAdapter(CONFIG, fake).validateCandidate({
        runId: "run-daytona-retryable",
        sessionId: "session-daytona",
        candidate: CANDIDATE,
        repository: {
          repoUrl: "https://github.com/example/safeflash.git",
          commitSha: COMMIT,
        },
        policy: POLICY,
      });
      await expect(promise).rejects.toMatchObject({
        name: "ProviderResponseError",
        provider: "daytona",
        retryable: true,
        message: "Daytona sandbox validation failed",
      });
      await expect(promise).rejects.not.toThrow(/secret-(?:rate|timeout)/u);
    }
  });

  it("rejects protected-path and threshold patches before creating a sandbox", async () => {
    const unsafeCandidates: CandidatePatch[] = [
      {
        ...CANDIDATE,
        unifiedDiff:
          "diff --git a/fixtures/battery-controller/tests/safety_tests.c b/fixtures/battery-controller/tests/safety_tests.c\n--- a/fixtures/battery-controller/tests/safety_tests.c\n+++ b/fixtures/battery-controller/tests/safety_tests.c\n@@ -1 +1 @@\n-old\n+new\n",
      },
      {
        ...CANDIDATE,
        unifiedDiff:
          "diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c\n--- a/fixtures/battery-controller/src/battery_controller.c\n+++ b/fixtures/battery-controller/src/battery_controller.c\n@@ -1 +1,2 @@\n-old\n+#define SENSOR_STALE_TIMEOUT_MS 9999\n+new\n",
      },
    ];

    for (const candidate of unsafeCandidates) {
      const fake = new FakeDaytona();
      await expect(
        new DaytonaAdapter(CONFIG, fake).validateCandidate({
          runId: "run-unsafe",
          sessionId: "session-daytona",
          candidate,
          repository: {
            repoUrl: "https://github.com/example/safeflash.git",
            commitSha: COMMIT,
          },
          policy: POLICY,
        }),
      ).rejects.toBeInstanceOf(ProviderResponseError);
      expect(fake.events).toEqual([]);
    }
  });

  it("runs a network-blocked disposable smoke and verifies exact output", async () => {
    const fake = new FakeDaytona();
    fake.smokeMode = true;
    fake.deleteFailuresRemaining = DAYTONA_DELETE_MAX_ATTEMPTS - 1;
    const result = await new DaytonaAdapter(CONFIG, fake).smoke();
    expect(result.data).toMatchObject({
      output: "SAFEFLASH_DAYTONA_SMOKE",
      networkBlocked: true,
      destroyed: true,
    });
    expect(fake.createParams[0]).toMatchObject({
      ephemeral: true,
      networkBlockAll: true,
    });
    expect(fake.events.filter((event) => event === "delete")).toHaveLength(
      DAYTONA_DELETE_MAX_ATTEMPTS,
    );
  });

  it("fails the smoke after bounded cleanup retries are exhausted", async () => {
    const fake = new FakeDaytona();
    fake.smokeMode = true;
    fake.failDelete = true;

    await expect(new DaytonaAdapter(CONFIG, fake).smoke()).rejects.toMatchObject({
      name: "ProviderResponseError",
      provider: "daytona",
      retryable: false,
      message: "Daytona smoke sandbox cleanup failed after bounded retries",
    });
    expect(fake.events.filter((event) => event === "delete")).toHaveLength(
      DAYTONA_DELETE_MAX_ATTEMPTS,
    );
  });
});
