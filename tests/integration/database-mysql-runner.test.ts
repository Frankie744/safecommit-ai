import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { runLocalDatabaseTournament } from "@safeflash/orchestrator";

const connectionUri = process.env.SAFECOMMIT_MYSQL_URL?.trim();
const mysqlTest = connectionUri ? it : it.skip;

describe("real MySQL 8 database tournament", () => {
  mysqlTest(
    "executes three plans from one baseline and verifies rollback",
    async () => {
      const sourceCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      const result = await runLocalDatabaseTournament({
        connectionUri: connectionUri!,
        sourceCommitSha,
        sessionId: "integration-real-mysql",
      });

      expect(result.provenance).toBe("local-test");
      expect(result.candidates).toHaveLength(3);
      expect(result.winnerCandidateId).toBe("candidate-c-safe");
      expect(
        result.candidates.map((candidate) => candidate.evidence.sandboxId),
      ).toHaveLength(3);
      expect(
        new Set(
          result.candidates.map(
            (candidate) => candidate.evidence.beforeStateDigest,
          ),
        ).size,
      ).toBe(1);
      for (const candidate of result.candidates) {
        expect(candidate.evidence.rollbackStateDigest).toBe(
          candidate.evidence.beforeStateDigest,
        );
      }
      expect(result.rankings[0]).toMatchObject({
        candidateId: "candidate-c-safe",
        eligible: true,
      });
      expect(result.rankings.slice(1).every((ranking) => !ranking.eligible)).toBe(
        true,
      );
    },
    30_000,
  );
});
