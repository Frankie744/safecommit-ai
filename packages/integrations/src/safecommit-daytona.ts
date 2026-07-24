import { Buffer } from "node:buffer";

import {
  CandidateChangePlanSchema,
  DatabaseEvidenceSchema,
  IntentContractSchema,
  canonicalJson,
  computeEvidenceDigest,
  type CandidateChangePlan,
  type DatabaseEvidence,
  type IntentContract,
  type OperatingMode,
} from "@safeflash/domain";
import {
  validateSqlPlanIntegrity,
  type DatabaseGateEvaluation,
} from "@safeflash/safety-policy";

import {
  createDaytonaClient,
  readDaytonaConfig,
  type DaytonaClientPort,
  type DaytonaConfig,
  type DaytonaSandboxPort,
} from "./daytona";
import {
  ProviderResponseError,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
} from "./provider";

const REPOSITORY_PATH = "/workspace/safecommit-repository";
const PLAN_PATH = "/tmp/safecommit-plan.json";
const INTENT_PATH = "/tmp/safecommit-intent.json";
const RUN_COMMAND =
  "npx --no-install tsx scripts/run-daytona-database-candidate.ts";

export interface SafeCommitDaytonaConfig extends DaytonaConfig {
  databaseSnapshot: string;
  databaseConnectionUri: string;
}

export interface SafeCommitDaytonaRequest {
  sessionId: string;
  runId: string;
  sourceCommitSha: string;
  repositoryUrl: string;
  candidate: CandidateChangePlan;
  intentContract: IntentContract;
  profile: {
    profileId: "openboxes-mysql-v1";
    fixtureSourceDigest: string;
    schemaFingerprint: string;
  };
}

export interface SafeCommitDaytonaEvidence {
  sessionId: string;
  runId: string;
  candidateId: string;
  sandboxId: string;
  snapshotName: string;
  sourceCommitSha: string;
  planDigest: string;
  intentContractDigest: string;
  fixtureSourceDigest: string;
  schemaFingerprint: string;
  databaseEvidence: DatabaseEvidence;
  gates: DatabaseGateEvaluation;
  networkBlockedBeforeExecution: true;
  destroyed: true;
}

interface SandboxOutput {
  evidence: unknown;
  gates: DatabaseGateEvaluation;
}

function assertLoopbackMysqlUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderResponseError(
      "daytona",
      "DAYTONA_DATABASE_MYSQL_URL must be a mysql:// URI",
      false,
    );
  }
  if (
    parsed.protocol !== "mysql:" ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
  ) {
    throw new ProviderResponseError(
      "daytona",
      "The Daytona fixture database must be loopback-local to its sandbox",
      false,
    );
  }
  return value;
}

export function readSafeCommitDaytonaConfig(
  environment: Environment = process.env,
  mode: OperatingMode = "live",
): SafeCommitDaytonaConfig {
  const required = requireLiveConfiguration(
    "daytona",
    mode,
    environment,
    [
      "DAYTONA_DATABASE_SNAPSHOT",
      "DAYTONA_DATABASE_MYSQL_URL",
    ] as const,
  );
  const base = readDaytonaConfig(environment, mode);
  return {
    ...base,
    databaseSnapshot: required.DAYTONA_DATABASE_SNAPSHOT,
    databaseConnectionUri: assertLoopbackMysqlUri(
      required.DAYTONA_DATABASE_MYSQL_URL,
    ),
  };
}

function assertRequest(request: SafeCommitDaytonaRequest): void {
  const candidate = CandidateChangePlanSchema.parse(request.candidate);
  const intent = IntentContractSchema.parse(request.intentContract);
  const integrity = validateSqlPlanIntegrity(candidate, intent);
  let repository: URL;
  try {
    repository = new URL(request.repositoryUrl);
  } catch {
    throw new ProviderResponseError(
      "daytona",
      "SafeCommit Daytona requires a public GitHub repository URL",
      false,
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(request.sessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(request.runId) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(request.sourceCommitSha) ||
    repository.protocol !== "https:" ||
    repository.hostname.toLowerCase() !== "github.com" ||
    repository.username !== "" ||
    repository.password !== "" ||
    request.profile.profileId !== intent.databaseProfile ||
    !/^[0-9a-f]{64}$/iu.test(request.profile.fixtureSourceDigest) ||
    !/^[0-9a-f]{64}$/iu.test(request.profile.schemaFingerprint) ||
    !integrity.passed
  ) {
    throw new ProviderResponseError(
      "daytona",
      "SafeCommit Daytona request failed immutable profile or SQL integrity validation",
      false,
    );
  }
}

async function deleteSandbox(
  client: DaytonaClientPort,
  sandbox: DaytonaSandboxPort,
  timeoutSeconds: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await client.delete(sandbox, timeoutSeconds, true);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProviderResponseError(
    "daytona",
    "SafeCommit Daytona sandbox cleanup failed after three attempts",
    false,
    { cause: lastError },
  );
}

function parseSandboxOutput(
  output: string,
  request: SafeCommitDaytonaRequest,
  sandboxId: string,
): { evidence: DatabaseEvidence; gates: DatabaseGateEvaluation } {
  let parsed: SandboxOutput;
  try {
    parsed = JSON.parse(output.trim()) as SandboxOutput;
  } catch {
    throw new ProviderResponseError(
      "daytona",
      "SafeCommit Daytona runner returned invalid JSON",
      false,
    );
  }
  const evidence = DatabaseEvidenceSchema.parse(parsed.evidence);
  if (
    evidence.sessionId !== request.sessionId ||
    evidence.runId !== request.runId ||
    evidence.sandboxId !== sandboxId ||
    evidence.candidateId !== request.candidate.candidateId ||
    evidence.sourceCommitSha.toLowerCase() !==
      request.sourceCommitSha.toLowerCase() ||
    evidence.planDigest !== computeEvidenceDigest(request.candidate) ||
    evidence.intentContractDigest !==
      computeEvidenceDigest(request.intentContract) ||
    evidence.schemaFingerprint !== request.profile.schemaFingerprint ||
    evidence.providerEvidence.provenance !== "live" ||
    evidence.providerEvidence.executionProvider !== "daytona" ||
    !evidence.providerEvidence.providerResourceIds.includes(sandboxId) ||
    !Array.isArray(parsed.gates?.results) ||
    parsed.gates.results.length === 0
  ) {
    throw new ProviderResponseError(
      "daytona",
      "SafeCommit Daytona evidence is not bound to the requested execution",
      false,
    );
  }
  return { evidence, gates: parsed.gates };
}

export class SafeCommitDaytonaAdapter {
  constructor(
    private readonly config: SafeCommitDaytonaConfig,
    private readonly client: DaytonaClientPort = createDaytonaClient(config),
  ) {
    if (
      config.retainSandboxes ||
      config.databaseSnapshot.trim() === "" ||
      config.databaseConnectionUri.trim() === ""
    ) {
      throw new ProviderResponseError(
        "daytona",
        "SafeCommit live database sandboxes must be ephemeral and snapshot-bound",
        false,
      );
    }
  }

  async validateCandidate(
    input: SafeCommitDaytonaRequest,
  ): Promise<ProviderEnvelope<SafeCommitDaytonaEvidence>> {
    const request = structuredClone(input);
    assertRequest(request);
    let sandbox: DaytonaSandboxPort | undefined;
    let destroyed = false;
    try {
      sandbox = await this.client.create(
        {
          language: "typescript",
          snapshot: this.config.databaseSnapshot,
          labels: {
            application: "safecommit",
            session: request.sessionId,
            run: request.runId,
            candidate: request.candidate.candidateId,
          },
          public: false,
          ephemeral: true,
          autoStopInterval: 5,
          ttlMinutes: this.config.ttlMinutes,
          domainAllowList: "github.com,*.githubusercontent.com",
        },
        { timeout: this.config.createTimeoutSeconds },
      );
      await sandbox.git.clone(
        request.repositoryUrl,
        REPOSITORY_PATH,
        undefined,
        request.sourceCommitSha,
      );
      await sandbox.updateNetworkSettings({ networkBlockAll: true });
      await Promise.all([
        sandbox.fs.uploadFile(
          Buffer.from(canonicalJson(request.candidate), "utf8"),
          PLAN_PATH,
          30,
        ),
        sandbox.fs.uploadFile(
          Buffer.from(canonicalJson(request.intentContract), "utf8"),
          INTENT_PATH,
          30,
        ),
      ]);

      const head = await sandbox.process.executeCommand(
        "git rev-parse HEAD",
        REPOSITORY_PATH,
        undefined,
        10,
      );
      if (
        head.exitCode !== 0 ||
        head.result.trim().toLowerCase() !==
          request.sourceCommitSha.toLowerCase()
      ) {
        throw new ProviderResponseError(
          "daytona",
          "SafeCommit Daytona source commit mismatch",
          false,
        );
      }

      const result = await sandbox.process.executeCommand(
        RUN_COMMAND,
        REPOSITORY_PATH,
        {
          SAFECOMMIT_MYSQL_URL: this.config.databaseConnectionUri,
          SAFECOMMIT_PLAN_PATH: PLAN_PATH,
          SAFECOMMIT_INTENT_PATH: INTENT_PATH,
          SAFECOMMIT_SESSION_ID: request.sessionId,
          SAFECOMMIT_RUN_ID: request.runId,
          SAFECOMMIT_SANDBOX_ID: sandbox.id,
          SAFECOMMIT_SOURCE_COMMIT_SHA: request.sourceCommitSha,
        },
        180,
      );
      if (result.exitCode !== 0) {
        throw new ProviderResponseError(
          "daytona",
          "SafeCommit Daytona database runner failed",
          false,
        );
      }
      const validated = parseSandboxOutput(result.result, request, sandbox.id);
      await deleteSandbox(
        this.client,
        sandbox,
        this.config.deleteTimeoutSeconds,
      );
      destroyed = true;

      return transportEnvelope("daytona", this.client, {
        sessionId: request.sessionId,
        runId: request.runId,
        candidateId: request.candidate.candidateId,
        sandboxId: sandbox.id,
        snapshotName: this.config.databaseSnapshot,
        sourceCommitSha: request.sourceCommitSha,
        planDigest: computeEvidenceDigest(request.candidate),
        intentContractDigest: computeEvidenceDigest(request.intentContract),
        fixtureSourceDigest: request.profile.fixtureSourceDigest,
        schemaFingerprint: request.profile.schemaFingerprint,
        databaseEvidence: validated.evidence,
        gates: validated.gates,
        networkBlockedBeforeExecution: true,
        destroyed: true,
      });
    } catch (error) {
      if (sandbox !== undefined && !destroyed) {
        try {
          await deleteSandbox(
            this.client,
            sandbox,
            this.config.deleteTimeoutSeconds,
          );
          destroyed = true;
        } catch (cleanupError) {
          throw cleanupError;
        }
      }
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "daytona",
        "SafeCommit Daytona validation failed",
        false,
        { cause: error },
      );
    }
  }
}
