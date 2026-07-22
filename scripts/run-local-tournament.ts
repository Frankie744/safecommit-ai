import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256 } from "@safeflash/domain";
import { runLocalTournament } from "@safeflash/orchestrator";

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
}

async function main(): Promise<void> {
  const capturedAt = new Date();
  const sessionId = `phase3-evidence-${safeTimestamp(capturedAt)}`;
  const workspaceRoot = resolve(process.cwd());
  const result = await runLocalTournament({
    sessionId,
    workspaceRoot,
    commandTimeoutMs: 90_000,
  });
  const eventLog = await readFile(result.eventLogPath, "utf8");
  const events = eventLog
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { eventHash: string });
  const evidenceDirectory = join(
    workspaceRoot,
    "artifacts",
    "evidence",
    "phase-3",
    sessionId,
  );
  await mkdir(evidenceDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    sessionId,
    mode: "mock",
    provenance: result.provenance,
    claim:
      "Real local Git/CMake/CTest evidence. This is not Daytona, Fireworks, Braintrust, GitHub, CodeRabbit, or recorded-live evidence.",
    sourceCommitSha:
      result.candidates[0]?.commands[0]?.commitSha ?? "LOCAL_UNCOMMITTED_TREE",
    toolchain: result.toolchain,
    eventChain: {
      eventCount: events.length,
      eventLogSha256: sha256(eventLog),
      lastEventHash: events.at(-1)?.eventHash ?? null,
      replayStatus: result.replayedState.status,
      replayWinnerCandidateId: result.replayedState.winnerCandidateId,
    },
    decision: result.decision,
    candidates: result.candidates.map((candidate) => ({
      candidateId: candidate.candidate.candidateId,
      strategy: candidate.candidate.strategy,
      patchSha256: sha256(candidate.candidate.unifiedDiff),
      sandboxId: candidate.sandboxId,
      fixtureHashBeforePatch: candidate.fixtureHashBeforePatch,
      fixtureHashAfterPatch: candidate.fixtureHashAfterPatch,
      buildPassed: candidate.buildPassed,
      unitTests: candidate.unitTests,
      safetyTests: candidate.safetyTests,
      scores: candidate.scores,
      eligible: candidate.eligible,
      weightedScore: candidate.weightedScore,
      hardGateFailures: candidate.hardGateFailures,
      evidenceDigest: candidate.evidenceDigest,
      commands: candidate.commands.map((command) => ({
        commandId: command.commandId,
        argv: command.argv,
        commandHash: command.commandHash,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        timedOut: command.timedOut,
        artifactHash: command.artifactHash,
        stdoutHash: command.stdoutHash,
        stderrHash: command.stderrHash,
      })),
    })),
  };

  await writeFile(
    join(evidenceDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(evidenceDirectory, "events.jsonl"), eventLog, "utf8");
  await writeFile(
    join(workspaceRoot, "artifacts", "evidence", "phase-3", "latest-run.txt"),
    `${sessionId}\n`,
    "utf8",
  );

  process.stdout.write(
    `${JSON.stringify({
      result: "pass",
      sessionId,
      winnerCandidateId: result.decision.winnerCandidateId,
      eventCount: events.length,
      lastEventHash: events.at(-1)?.eventHash ?? null,
      evidenceDirectory,
      provenance: result.provenance,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
