import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DEMO_SCENARIO_ID,
  DEMO_SCENARIOS,
  runLocalTournament,
} from "../../apps/orchestrator/src/index";
import {
  CreateSessionRequestSchema,
  SessionService,
} from "../../apps/web/server/session-service";

describe("Phase 8 explicit competition scenarios", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("makes unsafe-high-score the unique default and accepts happy-path", () => {
    expect(DEMO_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "unsafe-high-score",
      "happy-path",
      "provider-failure",
    ]);
    expect(DEMO_SCENARIOS.filter((scenario) => scenario.default)).toEqual([
      expect.objectContaining({ id: "unsafe-high-score" }),
    ]);
    expect(
      CreateSessionRequestSchema.parse({
        incidentKind: "battery-sensor-disconnect",
        runKind: "tournament",
      }).scenarioId,
    ).toBe(DEFAULT_DEMO_SCENARIO_ID);
    expect(
      CreateSessionRequestSchema.parse({
        incidentKind: "battery-sensor-disconnect",
        runKind: "tournament",
        scenarioId: "happy-path",
      }).scenarioId,
    ).toBe("happy-path");
  });

  it("keeps provider-failure out of the executable local tournament", async () => {
    await expect(
      runLocalTournament({
        sessionId: "provider-failure-direct",
        scenarioId: "provider-failure",
      }),
    ).rejects.toThrow(/fail-closed API fixture/u);
  });

  it(
    "runs a distinct happy path whose real safe candidates are ranked normally",
    async () => {
      const happy = await runLocalTournament({
        sessionId: `happy-path-${Date.now().toString(36)}`,
        workspaceRoot: resolve(process.cwd()),
        scenarioId: "happy-path",
        commandTimeoutMs: 90_000,
      });
      const winner = happy.candidates.find(
        (candidate) =>
          candidate.candidate.candidateId ===
          happy.decision.winnerCandidateId,
      );
      expect(happy.candidates).toHaveLength(3);
      expect(happy.candidates.every((candidate) => candidate.eligible)).toBe(
        true,
      );
      expect(
        happy.candidates.every(
          (candidate) =>
            candidate.buildPassed &&
            candidate.unitTests.exitCode === 0 &&
            candidate.safetyTests.exitCode === 0,
        ),
      ).toBe(true);
      expect(winner?.candidate.strategy).toBe("fail-closed");
      expect(
        happy.candidates.every(
          (candidate) =>
            candidate === winner ||
            winner!.weightedScore > candidate.weightedScore,
        ),
      ).toBe(true);
      const firstEvent = JSON.parse(
        (await readFile(happy.eventLogPath, "utf8")).split(/\r?\n/u)[0]!,
      ) as { payload?: { scenarioId?: string } };
      expect(firstEvent.payload?.scenarioId).toBe("happy-path");
    },
    120_000,
  );

  it("persists an honest MOCK provider failure with every mutation blocked", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "safeflash-provider-failure-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const service = new SessionService({
      workspaceRoot: resolve(process.cwd()),
      storageDirectory: join(temporaryRoot, "sessions"),
    });
    const failed = await service.create({
      incidentKind: "battery-sensor-disconnect",
      runKind: "tournament",
      scenarioId: "provider-failure",
    });

    expect(failed).toMatchObject({
      mode: "mock",
      state: "FAILED",
      scenario: { id: "provider-failure" },
      candidates: [],
      cleanup: { status: "not-run", sandboxIds: [] },
      failure: { recoverable: false },
    });
    expect(failed.approval).toBeUndefined();
    expect(failed.pullRequest).toBeUndefined();
    expect(failed.review).toBeUndefined();
    expect(failed.currentEvidenceDigest).toBeUndefined();
    expect(failed.providerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "fireworks",
          status: "failed",
          resourceIds: [],
          provenance: {
            kind: "mock",
            provider: "injected-fixture",
            verified: false,
          },
        }),
      ]),
    );
    expect(await service.get(failed.id)).toEqual(failed);
  });
});
