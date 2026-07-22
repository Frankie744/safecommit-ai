import { describe, expect, it } from "vitest";

import type { CandidatePatch } from "@safeflash/domain";
import {
  DEFAULT_DAYTONA_COMMAND_POLICY,
  DaytonaAdapter,
  ProviderResponseError,
  type DaytonaClientPort,
  type DaytonaConfig,
  type DaytonaSandboxPort,
} from "@safeflash/integrations";

const COMMIT = "a".repeat(40);

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
  smokeMode = false;

  readonly sandbox: DaytonaSandboxPort = {
    id: "sandbox-contract-id",
    git: {
      clone: async (...args) => {
        this.events.push("clone");
        this.cloneArgs.push(args);
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
          return { exitCode: 0, result: COMMIT };
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
    return this.sandbox;
  }

  async delete(): Promise<void> {
    this.events.push("delete");
  }
}

describe("Daytona isolation contract", () => {
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
    });

    expect(result.data.passed).toBe(true);
    expect(result.data.destroyed).toBe(true);
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
    });
    expect(result.data.passed).toBe(false);
    expect(result.data.commands.at(-1)?.exitCode).toBe(1);
    expect(fake.events.at(-1)).toBe("delete");
    expect(fake.commands).toHaveLength(5);
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
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(fake.events).toEqual([]);
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
        }),
      ).rejects.toBeInstanceOf(ProviderResponseError);
      expect(fake.events).toEqual([]);
    }
  });

  it("runs a network-blocked disposable smoke and verifies exact output", async () => {
    const fake = new FakeDaytona();
    fake.smokeMode = true;
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
    expect(fake.events.at(-1)).toBe("delete");
  });
});
