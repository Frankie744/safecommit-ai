import { readFile } from "node:fs/promises";

import {
  CandidateChangePlanSchema,
  IntentContractSchema,
} from "@safeflash/domain";
import { loadSafeCommitDatabaseProfile } from "../apps/orchestrator/src/database-profile";
import { runLocalMysqlCandidate } from "../apps/orchestrator/src/mysql-runner";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const [planJson, intentJson, profile] = await Promise.all([
    readFile(required("SAFECOMMIT_PLAN_PATH"), "utf8"),
    readFile(required("SAFECOMMIT_INTENT_PATH"), "utf8"),
    loadSafeCommitDatabaseProfile(),
  ]);
  const plan = CandidateChangePlanSchema.parse(JSON.parse(planJson));
  const intentContract = IntentContractSchema.parse(JSON.parse(intentJson));
  const result = await runLocalMysqlCandidate({
    connectionUri: required("SAFECOMMIT_MYSQL_URL"),
    profile,
    plan,
    intentContract,
    sessionId: required("SAFECOMMIT_SESSION_ID"),
    runId: required("SAFECOMMIT_RUN_ID"),
    sandboxId: required("SAFECOMMIT_SANDBOX_ID"),
    sourceCommitSha: required("SAFECOMMIT_SOURCE_COMMIT_SHA"),
  });
  const liveEvidence = {
    ...result.evidence,
    providerEvidence: {
      provenance: "live" as const,
      executionProvider: "daytona" as const,
      evaluationProvider: "local-deterministic" as const,
      providerResourceIds: [required("SAFECOMMIT_SANDBOX_ID")],
      evidenceRefs: [],
    },
  };
  process.stdout.write(
    JSON.stringify({ evidence: liveEvidence, gates: result.gates }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`SafeCommit database candidate failed: ${message}\n`);
  process.exitCode = 1;
});
