import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  computeEvidenceDigest,
  type DatabaseEvidence,
} from "@safeflash/domain";
import {
  ProviderResponseError,
  SafeCommitDaytonaAdapter,
  readSafeCommitDaytonaConfig,
  type DaytonaClientPort,
  type DaytonaSandboxPort,
  type SafeCommitDaytonaConfig,
} from "@safeflash/integrations";
import { loadSafeCommitDatabaseProfile } from "@safeflash/orchestrator";
import { describe, expect, it } from "vitest";

const SOURCE_SHA = "c".repeat(40);

async function committedSafeCandidate() {
  const evidenceRoot = resolve(
    process.cwd(),
    "artifacts/evidence/safecommit-database-local",
  );
  const latestRun = (
    await readFile(resolve(evidenceRoot, "latest-run.txt"), "utf8")
  ).trim();
  const raw = JSON.parse(
    await readFile(
      resolve(evidenceRoot, latestRun, "database-evidence.json"),
      "utf8",
    ),
  ) as {
    result: {
      candidates: Array<{
        plan: Awaited<
          ReturnType<typeof loadSafeCommitDatabaseProfile>
        >["candidates"][number];
        evidence: DatabaseEvidence;
        gates: {
          eligible: boolean;
          failedGateNames: string[];
          results: Array<{
            name: string;
            passed: boolean;
            explanation: string;
            evidenceDigest: string;
          }>;
        };
      }>;
    };
  };
  const candidate = raw.result.candidates.find(
    (item) => item.plan.candidateId === "candidate-c-safe",
  )!;
  return candidate;
}

function config(): SafeCommitDaytonaConfig {
  return {
    mode: "live",
    apiKey: "contract-test",
    databaseSnapshot: "safecommit-openboxes-mysql-v1",
    databaseConnectionUri:
      "mysql://safecommit:fixture-only-password-123456@127.0.0.1:3306/safecommit",
    retainSandboxes: false,
    createTimeoutSeconds: 90,
    deleteTimeoutSeconds: 60,
    ttlMinutes: 10,
  };
}

describe("SafeCommit Daytona database adapter", () => {
  it("binds a candidate to a snapshot, blocks network, and proves cleanup", async () => {
    const profile = await loadSafeCommitDatabaseProfile();
    const committed = await committedSafeCandidate();
    const sandboxId = "daytona-sandbox-contract";
    const evidence: DatabaseEvidence = {
      ...committed.evidence,
      sessionId: "safecommit-live-session",
      runId: "safecommit-live-run-c",
      sandboxId,
      sourceCommitSha: SOURCE_SHA,
      schemaFingerprint: profile.schemaFingerprint,
      providerEvidence: {
        provenance: "live",
        executionProvider: "daytona",
        evaluationProvider: "local-deterministic",
        providerResourceIds: [sandboxId],
        evidenceRefs: [],
      },
    };
    const commands: string[] = [];
    const uploads: string[] = [];
    let creates = 0;
    let deletes = 0;
    const sandbox: DaytonaSandboxPort = {
      id: sandboxId,
      git: { async clone() {} },
      fs: {
        async uploadFile(_file, remotePath) {
          uploads.push(remotePath);
        },
      },
      process: {
        async executeCommand(command) {
          commands.push(command);
          if (command.startsWith("node -e")) {
            return { exitCode: 0, result: "" };
          }
          if (command.startsWith("git checkout --detach")) {
            return { exitCode: 0, result: "" };
          }
          if (command.startsWith("git clone /tmp/")) {
            return { exitCode: 0, result: "" };
          }
          if (command === "git rev-parse HEAD") {
            return { exitCode: 0, result: SOURCE_SHA };
          }
          return {
            exitCode: 0,
            result: JSON.stringify({
              evidence,
              gates: committed.gates,
            }),
          };
        },
      },
      async updateNetworkSettings() {},
    };
    const client: DaytonaClientPort = {
      transport: "local-test",
      async create(params) {
        creates += 1;
        if (creates === 1) {
          throw Object.assign(new Error("connection reset"), {
            code: "ECONNRESET",
          });
        }
        expect(params.snapshot).toBe("safecommit-openboxes-mysql-v1");
        expect(params.ephemeral).toBe(true);
        expect(params.public).toBe(false);
        expect(params.networkBlockAll).toBe(true);
        expect(params.domainAllowList).toBeUndefined();
        expect(params.envVars).toMatchObject({
          MYSQL_DATABASE: "safecommit",
          MYSQL_USER: "safecommit",
          MYSQL_PASSWORD: "fixture-only-password-123456",
        });
        expect(params.envVars?.MYSQL_ROOT_PASSWORD).toMatch(
          /^[A-Za-z0-9_-]{40,}$/u,
        );
        expect(params.envVars?.MYSQL_ROOT_PASSWORD).not.toBe(
          params.envVars?.MYSQL_PASSWORD,
        );
        return sandbox;
      },
      async delete() {
        deletes += 1;
      },
    };

    const result = await new SafeCommitDaytonaAdapter(
      config(),
      client,
    ).validateCandidate({
      sessionId: evidence.sessionId,
      runId: evidence.runId,
      sourceCommitSha: SOURCE_SHA,
      repositoryUrl: "https://github.com/example/safeflash.git",
      sourceBundle: Buffer.from("test Git bundle"),
      sourceBundleDigest: createHash("sha256")
        .update("test Git bundle")
        .digest("hex"),
      candidate: committed.plan,
      intentContract: profile.intentContract,
      profile: {
        profileId: profile.profileId,
        fixtureSourceDigest: profile.fixtureSourceDigest,
        schemaFingerprint: profile.schemaFingerprint,
      },
    });

    expect(result.provenance.kind).toBe("local-test");
    expect(creates).toBe(2);
    expect(result.data.destroyed).toBe(true);
    expect(result.data.planDigest).toBe(
      computeEvidenceDigest(committed.plan),
    );
    expect(commands.some((command) => command.startsWith("node -e"))).toBe(
      true,
    );
    expect(
      commands.some((command) => command.startsWith("iptables -F OUTPUT")),
    ).toBe(true);
    expect(commands).toContain(
      "git clone /tmp/safecommit-source.bundle /workspace/safecommit-repository",
    );
    expect(commands).toContain(`git checkout --detach ${SOURCE_SHA}`);
    expect(uploads).toEqual([
      "/tmp/safecommit-source.bundle",
      "/tmp/safecommit-plan.json",
      "/tmp/safecommit-intent.json",
    ]);
    expect(commands).toContain(
      "/workspace/node_modules/.bin/tsx scripts/run-daytona-database-candidate.ts",
    );
    expect(deletes).toBe(1);
  });

  it("requires the live snapshot and a sandbox-local MySQL URL", () => {
    expect(() =>
      readSafeCommitDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured",
        DAYTONA_DATABASE_SNAPSHOT: "snapshot",
        DAYTONA_DATABASE_MYSQL_URL:
          "mysql://user:password@remote.example/safecommit",
      }),
    ).toThrow(ProviderResponseError);
    expect(() =>
      readSafeCommitDaytonaConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        DAYTONA_API_KEY: "configured",
        DAYTONA_DATABASE_SNAPSHOT: "snapshot",
        DAYTONA_DATABASE_MYSQL_URL:
          "mysql://root@127.0.0.1:3306/safecommit",
      }),
    ).toThrow(ProviderResponseError);
  });

  it("fails closed when cleanup cannot be proven", async () => {
    const profile = await loadSafeCommitDatabaseProfile();
    const committed = await committedSafeCandidate();
    const sandbox: DaytonaSandboxPort = {
      id: "cleanup-failure-sandbox",
      git: { async clone() {} },
      fs: { async uploadFile() {} },
      process: {
        async executeCommand() {
          throw new Error("runner unavailable");
        },
      },
      async updateNetworkSettings() {},
    };
    const client: DaytonaClientPort = {
      transport: "local-test",
      async create() {
        return sandbox;
      },
      async delete() {
        throw new Error("delete unavailable");
      },
    };
    await expect(
      new SafeCommitDaytonaAdapter(config(), client).validateCandidate({
        sessionId: "safecommit-cleanup-test",
        runId: "safecommit-cleanup-run",
        sourceCommitSha: SOURCE_SHA,
        repositoryUrl: "https://github.com/example/safeflash.git",
        sourceBundle: Buffer.from("test Git bundle"),
        sourceBundleDigest: createHash("sha256")
          .update("test Git bundle")
          .digest("hex"),
        candidate: committed.plan,
        intentContract: profile.intentContract,
        profile: {
          profileId: profile.profileId,
          fixtureSourceDigest: profile.fixtureSourceDigest,
          schemaFingerprint: profile.schemaFingerprint,
        },
      }),
    ).rejects.toThrow(/cleanup failed/iu);
  });
});
