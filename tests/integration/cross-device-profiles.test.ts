import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXECUTABLE_PROFILE_IDS,
  executableProfile,
  runLocalTournament,
} from "../../apps/orchestrator/src/index";

describe("cross-device executable assurance profiles", () => {
  it("keeps every command, path, candidate set, and test count server-owned", () => {
    expect(EXECUTABLE_PROFILE_IDS).toEqual([
      "battery-sensor-disconnect",
      "motor-command-nonfinite",
    ]);

    const battery = executableProfile("battery-sensor-disconnect");
    const motor = executableProfile("motor-command-nonfinite");
    expect(battery.commandPolicyId).toBe(motor.commandPolicyId);
    expect(battery.sourceFile).toMatch(/^fixtures\/battery-controller\/src\//u);
    expect(motor.sourceFile).toMatch(/^fixtures\/motor-controller\/src\//u);
    expect(battery.sourceFile).not.toBe(motor.sourceFile);
    expect(battery.expectedSafetyTests).toBeGreaterThan(0);
    expect(motor.expectedSafetyTests).toBeGreaterThan(0);
    expect(() => executableProfile("caller-owned-path" as never)).toThrow(
      /Unknown executable profile/u,
    );
  });

  it(
    "runs the motor profile through the same hard-gate selector and rejects the higher unsafe score",
    async () => {
      const tournament = await runLocalTournament({
        sessionId: `motor-profile-${randomUUID().slice(0, 8)}`,
        profileId: "motor-command-nonfinite",
        scenarioId: "unsafe-high-score",
        workspaceRoot: resolve(process.cwd()),
        commandTimeoutMs: 90_000,
      });

      expect(tournament.profile).toMatchObject({
        id: "motor-command-nonfinite",
        hardwareClass: "motor-drive",
        commandPolicyId: "cmake-ctest-fixed-v1",
        expectedUnitTests: 5,
        expectedSafetyTests: 6,
      });
      expect(tournament.candidates).toHaveLength(3);
      expect(
        tournament.candidates.every(
          (candidate) =>
            candidate.integrity.changedFiles[0] ===
            "fixtures/motor-controller/src/motor_controller.c",
        ),
      ).toBe(true);

      const unsafe = tournament.candidates.find(
        (candidate) => candidate.candidate.strategy === "range-validation",
      );
      const winner = tournament.candidates.find(
        (candidate) =>
          candidate.candidate.candidateId ===
          tournament.decision.winnerCandidateId,
      );
      expect(unsafe).toMatchObject({
        buildPassed: true,
        eligible: false,
        unitTests: { passed: 5, total: 5, exitCode: 0 },
        safetyTests: { passed: 0, total: 6 },
      });
      expect(winner).toMatchObject({
        eligible: true,
        buildPassed: true,
        unitTests: { passed: 5, total: 5, exitCode: 0 },
        safetyTests: { passed: 6, total: 6, exitCode: 0 },
      });
      expect(unsafe!.weightedScore).toBeGreaterThan(winner!.weightedScore);
      expect(winner!.candidate.strategy).toBe("fail-closed");
      expect(
        tournament.decision.rankings.filter((candidate) => candidate.eligible),
      ).toHaveLength(1);
    },
    120_000,
  );
});
