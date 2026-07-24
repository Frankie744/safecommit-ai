import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeDatabaseQualityScores,
  computeDatabaseWeightedScore,
  loadSafeCommitDatabaseProfile,
  rankDatabaseCandidates,
  type DatabaseTournamentCandidate,
} from "@safeflash/orchestrator";
import {
  SafeCommitBraintrustAdapter,
  SafeCommitDaytonaAdapter,
  SafeCommitFireworksAdapter,
  readSafeCommitBraintrustConfig,
  readSafeCommitDaytonaConfig,
  readSafeCommitFireworksConfig,
  redactProviderError,
} from "@safeflash/integrations";

const EVIDENCE_ROOT = resolve(
  "artifacts/evidence/safecommit-database-live",
);

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertCleanRemoteHead(): {
  sourceCommitSha: string;
  branch: string;
  repositoryUrl: string;
} {
  if (git("status", "--porcelain") !== "") {
    throw new Error("Live database tournament requires a clean Git worktree");
  }
  const sourceCommitSha = git("rev-parse", "HEAD");
  const branch = git("branch", "--show-current");
  const repositoryUrl = git("remote", "get-url", "origin");
  const parsed = new URL(repositoryUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !/^[0-9a-f]{40}$/u.test(sourceCommitSha) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(branch)
  ) {
    throw new Error(
      "Live database tournament requires a public GitHub HTTPS remote and full commit SHA",
    );
  }
  const remoteLine = git("ls-remote", "--heads", "origin", branch);
  const remoteSha = remoteLine.split(/\s+/u)[0]?.toLowerCase();
  if (remoteSha !== sourceCommitSha.toLowerCase()) {
    throw new Error(
      "Live database tournament requires the exact local HEAD on the remote branch",
    );
  }
  return { sourceCommitSha, branch, repositoryUrl };
}

function timestampId(now = new Date()): string {
  return now.toISOString().replace(/[-:.]/gu, "").replace("Z", "Z");
}

async function persistEvidence(
  runDirectory: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await mkdir(runDirectory, { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const digest = createHash("sha256").update(body).digest("hex");
  await Promise.all([
    writeFile(resolve(runDirectory, "database-live-evidence.json"), body, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(
      resolve(runDirectory, "manifest.sha256"),
      `${digest}  database-live-evidence.json\n`,
      { encoding: "utf8", flag: "wx" },
    ),
  ]);
}

export async function main(): Promise<void> {
  if (process.env.SAFEFLASH_ALLOW_LIVE !== "true") {
    throw new Error("SAFEFLASH_ALLOW_LIVE must equal true");
  }
  const { sourceCommitSha, branch, repositoryUrl } = assertCleanRemoteHead();
  const profile = await loadSafeCommitDatabaseProfile();
  const sessionId = `safecommit-live-${randomUUID()}`;
  const fireworks = new SafeCommitFireworksAdapter(
    readSafeCommitFireworksConfig(process.env, "live"),
  );
  const daytona = new SafeCommitDaytonaAdapter(
    readSafeCommitDaytonaConfig(process.env, "live"),
  );
  const braintrust = new SafeCommitBraintrustAdapter(
    readSafeCommitBraintrustConfig(process.env, "live"),
  );
  const databaseProfile = {
    profileId: profile.profileId,
    fixtureKind: profile.fixtureKind,
    mysqlVersion: profile.mysqlVersion,
    schemaFingerprint: profile.schemaFingerprint,
    sourceRevision: profile.sourceRevision,
    tables: Object.keys(profile.baseline.counts).sort(),
  } as const;

  const generated = [];
  for (const [index, slot] of profile.candidates.entries()) {
    generated.push(
      await fireworks.generateCandidate({
        sessionId,
        candidateId: slot.candidateId,
        strategy: slot.strategy,
        seed: 202_607_240 + index,
        intentContract: profile.intentContract,
        databaseProfile,
      }),
    );
  }

  const validated = await Promise.all(
    generated.map(async (candidate, index) => {
      const runId = `daytona-${index + 1}-${randomUUID()}`;
      const result = await daytona.validateCandidate({
        sessionId,
        runId,
        sourceCommitSha,
        repositoryUrl,
        candidate: candidate.data.candidate,
        intentContract: profile.intentContract,
        profile: {
          profileId: profile.profileId,
          fixtureSourceDigest: profile.fixtureSourceDigest,
          schemaFingerprint: profile.schemaFingerprint,
        },
      });
      const qualityScores = computeDatabaseQualityScores(
        candidate.data.candidate,
        result.data.databaseEvidence,
        result.data.gates,
      );
      return {
        plan: candidate.data.candidate,
        evidence: result.data.databaseEvidence,
        gates: result.data.gates,
        qualityScores,
        weightedScore: computeDatabaseWeightedScore(qualityScores),
        fireworks: {
          requestId: candidate.data.requestId,
          requestDigest: candidate.data.requestDigest,
          model: candidate.data.model,
          latencyMs: candidate.data.latencyMs,
          totalTokens: candidate.data.totalTokens,
          finishReason: candidate.data.finishReason,
        },
        daytona: {
          sandboxId: result.data.sandboxId,
          runId: result.data.runId,
          snapshotName: result.data.snapshotName,
          networkBlockedBeforeExecution:
            result.data.networkBlockedBeforeExecution,
          destroyed: result.data.destroyed,
        },
      };
    }),
  );

  const tournamentCandidates: DatabaseTournamentCandidate[] = validated.map(
    ({ plan, evidence, gates, qualityScores, weightedScore }) => ({
      plan,
      evidence,
      gates,
      qualityScores,
      weightedScore,
    }),
  );
  const rankings = rankDatabaseCandidates(tournamentCandidates);
  const winnerCandidateId =
    rankings.find((candidate) => candidate.eligible)?.candidateId ?? null;
  const experimentCases = validated.map((candidate) => ({
    candidateId: candidate.plan.candidateId,
    plan: candidate.plan,
    evidence: candidate.evidence,
    gates: candidate.gates,
    weightedScore: candidate.weightedScore,
    metadata: {
      provenance: "live",
      sourceCommitSha,
      branch,
      sessionId,
      sandboxId: candidate.daytona.sandboxId,
      runId: candidate.daytona.runId,
    },
  }));
  const experimentName = `safecommit-live-${timestampId()}`;
  const [dataset, trace, experiment] = await Promise.all([
    braintrust.seedLogisticsDataset(),
    braintrust.traceTournament({
      input: {
        taskId: profile.intentContract.taskId,
        sourceCommitSha,
        candidateIds: validated.map((candidate) => candidate.plan.candidateId),
      },
      output: { winnerCandidateId, rankings },
      metadata: { provenance: "live", sessionId, branch },
    }),
    braintrust.runDatabaseExperiment(experimentName, experimentCases),
  ]);
  const capturedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    capturedAt,
    provenance: "live",
    status:
      winnerCandidateId === null ? "BLOCKED" : "AWAITING_HUMAN_APPROVAL",
    liveCertified: false,
    sourceCommitSha,
    branch,
    repositoryUrl,
    sessionId,
    profile: {
      profileId: profile.profileId,
      fixtureKind: profile.fixtureKind,
      mysqlVersion: profile.mysqlVersion,
      sourceRevision: profile.sourceRevision,
      fixtureSourceDigest: profile.fixtureSourceDigest,
      schemaFingerprint: profile.schemaFingerprint,
    },
    candidates: validated,
    rankings,
    winnerCandidateId,
    braintrust: {
      dataset: dataset.data,
      trace: trace.data,
      experiment: experiment.data,
    },
    claim:
      winnerCandidateId === null
        ? "No candidate passed every database hard gate; publication is blocked."
        : "Provider-live tournament evidence exists, but publication remains blocked pending explicit human approval and exact-evidence binding.",
  };
  const runDirectoryName = `safecommit-live-${timestampId(
    new Date(capturedAt),
  )}`;
  const runDirectory = resolve(EVIDENCE_ROOT, runDirectoryName);
  await persistEvidence(runDirectory, payload);
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await writeFile(
    resolve(EVIDENCE_ROOT, "latest-run.txt"),
    `${runDirectoryName}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "passed",
        status: payload.status,
        sourceCommitSha,
        sessionId,
        candidateCount: validated.length,
        winnerCandidateId,
        rankings,
        fireworksRequestIds: validated.map(
          (candidate) => candidate.fireworks.requestId,
        ),
        daytonaSandboxIds: validated.map(
          (candidate) => candidate.daytona.sandboxId,
        ),
        allDaytonaSandboxesDestroyed: validated.every(
          (candidate) => candidate.daytona.destroyed,
        ),
        braintrustDatasetUrl: dataset.data.datasetUrl,
        braintrustTraceUrl: trace.data.traceUrl,
        braintrustExperimentUrl: experiment.data.experimentUrl,
        evidenceDirectory: runDirectory,
        liveCertified: false,
      },
      null,
      2,
    )}\n`,
  );
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  resolve(entryPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `SafeCommit live database tournament failed: ${redactProviderError(
        error,
      )}\n`,
    );
    process.exitCode = 1;
  });
}
