import type { CandidatePatch } from "@safeflash/domain";

import {
  HAPPY_PATH_TOURNAMENT_CANDIDATES,
  LOCAL_TOURNAMENT_CANDIDATES,
} from "../../../demo/candidate-patches/index";
import { MOTOR_TOURNAMENT_CANDIDATES } from "../../../demo/candidate-patches/motor";
import type { DemoScenarioId } from "./demo-scenarios";

export const EXECUTABLE_PROFILE_IDS = [
  "battery-sensor-disconnect",
  "motor-command-nonfinite",
] as const;

export type ExecutableProfileId = (typeof EXECUTABLE_PROFILE_IDS)[number];

/**
 * A server-owned execution contract. User/model inputs may select an ID, but
 * may never supply fixture paths, commands, expected counts, or candidate sets.
 */
export interface ExecutableIncidentProfile {
  id: ExecutableProfileId;
  profileVersion: string;
  commandPolicyId: string;
  hardwareClass: "battery-charger" | "motor-drive";
  displayName: string;
  incident: string;
  unsafeBaseline: string;
  safeOutcome: string;
  fixtureDirectory: string;
  sourceFile: string;
  expectedUnitTests: number;
  expectedSafetyTests: number;
  candidatesForScenario(
    scenarioId: DemoScenarioId,
  ): readonly CandidatePatch[];
}

const BATTERY_PROFILE: ExecutableIncidentProfile = Object.freeze({
  id: "battery-sensor-disconnect",
  profileVersion: "battery-safety-v1",
  commandPolicyId: "cmake-ctest-fixed-v1",
  hardwareClass: "battery-charger",
  displayName: "Battery charger",
  incident: "Temperature sensor disconnected while charging",
  unsafeBaseline: "Sensor fault is ignored; charging remains ON.",
  safeOutcome: "Charging OFF; sensor fault latched until explicit reset.",
  fixtureDirectory: "fixtures/battery-controller",
  sourceFile: "fixtures/battery-controller/src/battery_controller.c",
  expectedUnitTests: 5,
  expectedSafetyTests: 6,
  candidatesForScenario: (scenarioId: DemoScenarioId) =>
    scenarioId === "happy-path"
      ? HAPPY_PATH_TOURNAMENT_CANDIDATES
      : LOCAL_TOURNAMENT_CANDIDATES,
});

const MOTOR_PROFILE: ExecutableIncidentProfile = Object.freeze({
  id: "motor-command-nonfinite",
  profileVersion: "motor-safety-v1",
  commandPolicyId: "cmake-ctest-fixed-v1",
  hardwareClass: "motor-drive",
  displayName: "Motor drive",
  incident: "Non-finite torque command reaches the motor controller",
  unsafeBaseline: "NaN bypasses range checks; PWM remains enabled.",
  safeOutcome: "PWM OFF; applied torque zero; command fault latched.",
  fixtureDirectory: "fixtures/motor-controller",
  sourceFile: "fixtures/motor-controller/src/motor_controller.c",
  expectedUnitTests: 5,
  expectedSafetyTests: 6,
  candidatesForScenario: (_scenarioId: DemoScenarioId) =>
    MOTOR_TOURNAMENT_CANDIDATES,
});

const PROFILE_REGISTRY: Readonly<
  Record<ExecutableProfileId, ExecutableIncidentProfile>
> = Object.freeze({
  "battery-sensor-disconnect": BATTERY_PROFILE,
  "motor-command-nonfinite": MOTOR_PROFILE,
});

export function executableProfile(
  profileId: ExecutableProfileId,
): ExecutableIncidentProfile {
  const profile = PROFILE_REGISTRY[profileId];
  if (profile === undefined) {
    throw new Error(`Unknown executable profile: ${String(profileId)}`);
  }
  return profile;
}

export function executableProfiles(): readonly ExecutableIncidentProfile[] {
  return EXECUTABLE_PROFILE_IDS.map((id) => executableProfile(id));
}
