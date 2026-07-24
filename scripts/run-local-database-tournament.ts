import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  canonicalJson,
  computeEvidenceDigest,
  sha256,
} from "@safeflash/domain";
import {
  runLocalDatabaseTournament,
  type DatabaseTournamentResult,
} from "@safeflash/orchestrator";

const execFileAsync = promisify(execFile);

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.]/gu, "");
}

async function git(command: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", command, {
    cwd: process.cwd(),
    windowsHide: true,
  });
  return result.stdout.trim();
}

function assertTournament(result: DatabaseTournamentResult): void {
  if (result.candidates.length !== 3) {
    throw new Error("SafeCommit requires exactly three database candidates");
  }
  const byId = new Map(
    result.candidates.map((candidate) => [
      candidate.plan.candidateId,
      candidate,
    ]),
  );
  const aggressive = byId.get("candidate-a-aggressive");
  const protectedOrder = byId.get("candidate-b-shipped-order");
  const safe = byId.get("candidate-c-safe");
  if (
    aggressive === undefined ||
    protectedOrder === undefined ||
    safe === undefined ||
    result.winnerCandidateId !== safe.plan.candidateId ||
    aggressive.gates.eligible ||
    protectedOrder.gates.eligible ||
    !safe.gates.eligible ||
    aggressive.weightedScore <= safe.weightedScore ||
    !aggressive.gates.failedGateNames.includes("WarehouseScope") ||
    !aggressive.gates.failedGateNames.includes("TenantIsolation") ||
    !protectedOrder.gates.failedGateNames.includes("ProtectedOrderState")
  ) {
    throw new Error(
      `SafeCommit Magic Moment invariant failed: ${JSON.stringify({
        winnerCandidateId: result.winnerCandidateId,
        candidates: result.candidates.map((candidate) => ({
          candidateId: candidate.plan.candidateId,
          weightedScore: candidate.weightedScore,
          eligible: candidate.gates.eligible,
          failedGateNames: candidate.gates.failedGateNames,
        })),
      })}`,
    );
  }
  for (const candidate of result.candidates) {
    if (
      candidate.evidence.beforeStateDigest !==
      candidate.evidence.rollbackStateDigest
    ) {
      throw new Error(
        `Rollback digest mismatch for ${candidate.plan.candidateId}`,
      );
    }
    if (
      !candidate.evidence.invariantResults.some(
        (gate) => gate.name === "Idempotency" && gate.passed,
      )
    ) {
      throw new Error(`Idempotency failed for ${candidate.plan.candidateId}`);
    }
  }
}

async function main(): Promise<void> {
  const connectionUri = process.env.SAFECOMMIT_MYSQL_URL?.trim();
  if (!connectionUri) {
    throw new Error(
      "Set server-only SAFECOMMIT_MYSQL_URL before running the local database tournament",
    );
  }
  const [sourceCommitSha, status] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain"]),
  ]);
  if (
    status !== "" &&
    process.env.SAFECOMMIT_ALLOW_DIRTY_LOCAL !== "true"
  ) {
    throw new Error(
      "Refusing to capture source-bound database evidence from a dirty worktree",
    );
  }

  const result = await runLocalDatabaseTournament({
    connectionUri,
    sourceCommitSha,
  });
  assertTournament(result);

  const evidenceRoot = resolve(
    process.env.SAFECOMMIT_DATABASE_EVIDENCE_DIR?.trim() ||
      "artifacts/evidence/safecommit-database-local",
  );
  const runId = `safecommit-mysql-${timestampId()}`;
  const runDirectory = join(evidenceRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  const evidencePayload = {
    schemaVersion: 1,
    status: "LOCAL_TEST",
    providerCertified: false,
    capturedAt: new Date().toISOString(),
    sourceCommitSha,
    worktreeClean: status === "",
    result,
  };
  const evidenceJson = `${canonicalJson(evidencePayload)}\n`;
  const summary = {
    schemaVersion: 1,
    runId,
    status: "LOCAL_TEST",
    mysql: "8.0.36",
    fixtureKind: result.fixtureKind,
    sourceCommitSha,
    worktreeClean: status === "",
    candidateCount: result.candidates.length,
    winnerCandidateId: result.winnerCandidateId,
    tournamentDigest: result.tournamentDigest,
    candidates: result.candidates.map((candidate) => ({
      candidateId: candidate.plan.candidateId,
      weightedScore: candidate.weightedScore,
      eligible: candidate.gates.eligible,
      failedGateNames: candidate.gates.failedGateNames,
      affectedRows: candidate.evidence.statementResults.reduce(
        (sum, statement) => sum + statement.affectedRows,
        0,
      ),
      beforeStateDigest: candidate.evidence.beforeStateDigest,
      afterStateDigest: candidate.evidence.afterStateDigest,
      rollbackStateDigest: candidate.evidence.rollbackStateDigest,
      evidenceDigest: computeEvidenceDigest(candidate.evidence),
    })),
    liveProviderCalls: 0,
    liveCertified: false,
  };
  const summaryJson = `${JSON.stringify(summary, null, 2)}\n`;
  const files = [
    ["database-evidence.json", evidenceJson],
    ["summary.json", summaryJson],
  ] as const;
  await Promise.all(
    files.map(([name, contents]) =>
      writeFile(join(runDirectory, name), contents, "utf8"),
    ),
  );
  const manifest = files
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join("\n");
  await writeFile(join(runDirectory, "manifest.sha256"), `${manifest}\n`, "utf8");
  await writeFile(join(evidenceRoot, "latest-run.txt"), `${runId}\n`, "utf8");

  process.stdout.write(
    [
      "SAFECOMMIT_DATABASE_LOCAL=PASS",
      "PROVENANCE=LOCAL_TEST",
      `MYSQL_VERSION=${summary.mysql}`,
      `CANDIDATES=${summary.candidateCount}`,
      `WINNER=${summary.winnerCandidateId}`,
      `TOURNAMENT_DIGEST=${summary.tournamentDigest}`,
      "FIREWORKS_LIVE=BLOCKED",
      "DAYTONA_LIVE=BLOCKED",
      "BRAINTRUST_LIVE=BLOCKED",
      "LIVE_CERTIFIED=NO",
      `EVIDENCE=${runDirectory}`,
      "",
    ].join("\n"),
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
