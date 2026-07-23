import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  EXECUTABLE_PROFILE_IDS,
  runLocalTournament,
  type ExecutableProfileId,
  type LocalTournamentResult,
} from "@safeflash/orchestrator";

function assertProfileResult(
  profileId: ExecutableProfileId,
  result: LocalTournamentResult,
): void {
  const winner = result.candidates.find(
    (candidate) =>
      candidate.candidate.candidateId === result.decision.winnerCandidateId,
  );
  const unsafeHighScore = result.candidates.find(
    (candidate) =>
      candidate.candidate.strategy === "range-validation",
  );
  if (
    result.profile.id !== profileId ||
    result.provenance.kind !== "local-test" ||
    winner === undefined ||
    !winner.eligible ||
    winner.candidate.strategy !== "fail-closed" ||
    unsafeHighScore === undefined ||
    unsafeHighScore.eligible ||
    unsafeHighScore.weightedScore <= winner.weightedScore
  ) {
    throw new Error(
      `${profileId} did not prove that hard gates reject the higher soft score`,
    );
  }
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(process.cwd());
  const results: LocalTournamentResult[] = [];

  for (const profileId of EXECUTABLE_PROFILE_IDS) {
    const result = await runLocalTournament({
      sessionId: `cross-device-${profileId}-${randomUUID().slice(0, 8)}`,
      profileId,
      scenarioId: "unsafe-high-score",
      workspaceRoot,
      commandTimeoutMs: 90_000,
    });
    assertProfileResult(profileId, result);
    results.push(result);
  }

  console.log(`EXECUTABLE_PROFILES=${results.length}`);
  console.log("BATTERY_PROFILE=PASS");
  console.log("MOTOR_PROFILE=PASS");
  console.log("SIMULATED_DEVICES=YES");
  console.log("PROVIDER_PROVENANCE=LOCAL_TEST_NOT_LIVE");
  console.log("HARD_GATE_BYPASS=0");
  for (const result of results) {
    console.log(
      `${result.profile.id.toUpperCase().replaceAll("-", "_")}_WINNER=${
        result.decision.winnerCandidateId
      }`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    `CROSS_DEVICE_PROOF=FAIL ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
