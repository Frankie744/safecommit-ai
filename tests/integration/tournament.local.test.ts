import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { CandidatePatchSchema } from "../../packages/domain/src/index";
import { LOCAL_TOURNAMENT_CANDIDATES } from "../../demo/candidate-patches/index";
import {
  buildLocalChildEnvironment,
  JsonlEventStore,
  LiveTournamentProviderRequiredError,
  runLocalTournament,
  runSafetyTournament,
  type LocalTournamentResult,
} from "../../apps/orchestrator/src/index";

describe("Phase 3 local safety tournament", () => {
  let tournament: LocalTournamentResult;

  beforeAll(async () => {
    tournament = await runLocalTournament({
      sessionId: `phase3-${randomUUID().slice(0, 8)}`,
      workspaceRoot: resolve(process.cwd()),
      commandTimeoutMs: 90_000,
    });
  }, 120_000);

  it("executes three strict patches in unique local-test sandboxes with real outcomes", () => {
    expect(LOCAL_TOURNAMENT_CANDIDATES).toHaveLength(3);
    for (const candidate of LOCAL_TOURNAMENT_CANDIDATES) {
      expect(CandidatePatchSchema.safeParse(candidate).success).toBe(true);
    }

    expect(tournament.provenance).toMatchObject({
      mode: "mock",
      kind: "local-test",
      provider: "local-process",
    });
    expect(tournament.provenance.notice).toContain("NOT DAYTONA");
    expect(tournament.candidates).toHaveLength(3);

    const sandboxIds = tournament.candidates.map((candidate) => candidate.sandboxId);
    expect(new Set(sandboxIds).size).toBe(3);
    expect(sandboxIds.every((sandboxId) => sandboxId.startsWith("localtest-"))).toBe(
      true,
    );

    for (const result of tournament.candidates) {
      expect(result.integrity.valid).toBe(true);
      expect(result.integrity.changedFiles).toEqual([
        "fixtures/battery-controller/src/battery_controller.c",
      ]);
      expect(result.fixtureHashAfterPatch).not.toBe(result.fixtureHashBeforePatch);
      expect(result.commands.length).toBeGreaterThanOrEqual(4);
      for (const command of result.commands) {
        expect(command.argv.length).toBeGreaterThan(1);
        expect(command.commandHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(command.artifactHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(command.stdoutHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(command.stderrHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(command.durationMs).toBeGreaterThanOrEqual(0);
        expect(command.source).toBe("local-test");
      }
    }

    const candidateA = tournament.candidates.find(
      (result) => result.candidate.strategy === "range-validation",
    );
    const candidateB = tournament.candidates.find(
      (result) => result.candidate.strategy === "retry-and-latch",
    );
    const candidateC = tournament.candidates.find(
      (result) => result.candidate.strategy === "fail-closed",
    );

    expect(candidateA).toMatchObject({
      buildPassed: true,
      eligible: false,
      unitTests: { executed: true, exitCode: 0 },
    });
    expect(candidateA?.safetyTests.executed).toBe(true);
    expect(candidateA?.safetyTests.exitCode).not.toBe(0);

    expect(candidateB).toMatchObject({
      buildPassed: false,
      eligible: false,
      unitTests: { executed: false },
      safetyTests: { executed: false },
    });

    expect(candidateC).toMatchObject({
      buildPassed: true,
      eligible: true,
      unitTests: { executed: true, exitCode: 0, passed: 5, total: 5 },
      safetyTests: { executed: true, exitCode: 0, passed: 6, total: 6 },
    });
    expect(candidateA!.weightedScore).toBeGreaterThan(
      candidateC!.weightedScore,
    );
    expect(candidateA!.eligible).toBe(false);
    expect(tournament.decision.winnerCandidateId).toBe(candidateC?.candidate.candidateId);
    expect(tournament.decision.rankings.filter((ranking) => ranking.eligible)).toHaveLength(
      1,
    );
  });

  it("demo_session_can_be_replayed_from_recorded_evidence", async () => {
    const events = await new JsonlEventStore(tournament.eventLogPath).readAll();
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((event) => event.provenance.mode === "mock")).toBe(true);
    expect(events.every((event) => event.provenance.kind === "local-test")).toBe(true);
    expect(events.some((event) => JSON.stringify(event).includes("recorded-live"))).toBe(
      false,
    );
    expect(tournament.replayedState).toMatchObject({
      sessionId: tournament.sessionId,
      status: "completed",
      winnerCandidateId: tournament.decision.winnerCandidateId,
      provenance: { mode: "mock", kind: "local-test" },
    });
    expect(Object.keys(tournament.replayedState.candidates)).toHaveLength(3);
  });

  it("live mode without a provider fails closed instead of using local evidence", async () => {
    await expect(
      runSafetyTournament({
        mode: "live",
        sessionId: `live-missing-${randomUUID().slice(0, 8)}`,
        workspaceRoot: resolve(process.cwd()),
      }),
    ).rejects.toBeInstanceOf(LiveTournamentProviderRequiredError);
  });

  it("does not expose provider secrets to repository-owned local test binaries", () => {
    const environment = buildLocalChildEnvironment({
      PATH: "C:/trusted-tools",
      SYSTEMROOT: "C:/Windows",
      DAYTONA_API_KEY: "daytona-secret",
      FIREWORKS_API_KEY: "fireworks-secret",
      BRAINTRUST_API_KEY: "braintrust-secret",
      GITHUB_TOKEN: "github-secret",
    });

    expect(environment.PATH).toBe("C:/trusted-tools");
    expect(environment.SYSTEMROOT).toBe("C:/Windows");
    expect(environment.DAYTONA_API_KEY).toBeUndefined();
    expect(environment.FIREWORKS_API_KEY).toBeUndefined();
    expect(environment.BRAINTRUST_API_KEY).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
  });

  it("rejects an external provider that self-reports inconsistent provenance", async () => {
    await expect(
      runSafetyTournament({
        mode: "live",
        sessionId: "live-forged-provenance",
        provider: {
          run: async () =>
            ({
              provenance: {
                mode: "live",
                kind: "recorded-live",
                provider: "forged-provider",
              },
            }) as never,
        },
      }),
    ).rejects.toBeInstanceOf(LiveTournamentProviderRequiredError);
  });
});
