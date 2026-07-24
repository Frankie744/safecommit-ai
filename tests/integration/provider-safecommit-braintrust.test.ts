import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LOGISTICS_MUTATION_CASES,
  LOGISTICS_MUTATION_DATASET_VERSION,
} from "@safeflash/evals";
import type { DatabaseEvidence } from "@safeflash/domain";
import {
  SafeCommitBraintrustAdapter,
  readSafeCommitBraintrustConfig,
  scoreSafeCommitDatabaseCase,
  type BraintrustConfig,
  type SafeCommitBraintrustExperimentCase,
  type SafeCommitBraintrustPort,
} from "@safeflash/integrations";
import { describe, expect, it } from "vitest";

const CONFIG: BraintrustConfig = {
  mode: "live",
  apiKey: "contract-test",
  projectName: "SafeCommit",
  datasetName: "SafeCommit Logistics Mutations",
};

async function caseFromEvidence(): Promise<SafeCommitBraintrustExperimentCase> {
  const evidenceRoot = resolve(
    process.cwd(),
    "artifacts/evidence/safecommit-database-local",
  );
  const latestRun = (
    await readFile(resolve(evidenceRoot, "latest-run.txt"), "utf8")
  ).trim();
  const artifact = JSON.parse(
    await readFile(
      resolve(evidenceRoot, latestRun, "database-evidence.json"),
      "utf8",
    ),
  ) as {
    result: {
      candidates: Array<{
        plan: SafeCommitBraintrustExperimentCase["plan"];
        evidence: DatabaseEvidence;
        gates: SafeCommitBraintrustExperimentCase["gates"];
        weightedScore: number;
      }>;
    };
  };
  const candidate = artifact.result.candidates.find(
    (item) => item.plan.candidateId === "candidate-c-safe",
  )!;
  return { ...candidate, candidateId: candidate.plan.candidateId, metadata: {} };
}

describe("SafeCommit Braintrust integration", () => {
  it("seeds the 12-case corpus and preserves remote evidence IDs", async () => {
    const testCase = await caseFromEvidence();
    const scores = scoreSafeCommitDatabaseCase(testCase);
    const port: SafeCommitBraintrustPort = {
      transport: "local-test",
      async seedDataset(_config, cases) {
        expect(cases).toHaveLength(12);
        return {
          datasetId: "dataset-safecommit-1",
          datasetName: CONFIG.datasetName,
          datasetVersion: LOGISTICS_MUTATION_DATASET_VERSION,
          datasetUrl: "https://www.braintrust.dev/app/dataset-safecommit-1",
          rowIds: cases.map((item) => `row-${item.id}`),
          totalRecords: cases.length,
        };
      },
      async writeTrace(_config, event) {
        expect(event.name).toBe("safecommit.database-tournament");
        return {
          traceId: "trace-safecommit-1",
          spanId: "span-safecommit-1",
          traceUrl: "https://www.braintrust.dev/app/trace-safecommit-1",
        };
      },
      async runExperiment(_config, experimentName, cases) {
        expect(cases[0]?.output.scores).toEqual(scores);
        return {
          projectName: CONFIG.projectName,
          experimentName,
          projectId: "project-safecommit-1",
          experimentId: "experiment-safecommit-1",
          experimentUrl:
            "https://www.braintrust.dev/app/experiment-safecommit-1",
          resultCount: 1,
          results: [
            {
              resultId: "result-safecommit-1",
              candidateId: testCase.candidateId,
              evidenceDigest: cases[0]!.output.evidenceDigest,
              scores,
            },
          ],
        };
      },
    };
    const adapter = new SafeCommitBraintrustAdapter(CONFIG, port);
    const [dataset, trace, experiment] = await Promise.all([
      adapter.seedLogisticsDataset(LOGISTICS_MUTATION_CASES),
      adapter.traceTournament({
        input: { taskId: "merge-duplicate-sku-la" },
        output: { winnerCandidateId: "candidate-c-safe" },
        metadata: { provenance: "contract-test" },
      }),
      adapter.runDatabaseExperiment(
        "safecommit-contract-test",
        [testCase],
      ),
    ]);

    expect(dataset.provenance.kind).toBe("local-test");
    expect(dataset.data.totalRecords).toBe(12);
    expect(trace.data.traceId).toBe("trace-safecommit-1");
    expect(experiment.data.experimentId).toBe(
      "experiment-safecommit-1",
    );
  });

  it("recomputes hard gates from database evidence", async () => {
    const testCase = await caseFromEvidence();
    expect(scoreSafeCommitDatabaseCase(testCase)).toHaveLength(15);
    expect(
      scoreSafeCommitDatabaseCase(testCase).find(
        (score) => score.name === "ProtectedOrderState",
      )?.score,
    ).toBe(1);

    const inconsistent = {
      ...testCase,
      gates: {
        ...testCase.gates,
        eligible: false,
      },
    };
    expect(() => scoreSafeCommitDatabaseCase(inconsistent)).toThrow(
      /gates do not match/iu,
    );
  });

  it("requires explicit live authorization", () => {
    expect(() =>
      readSafeCommitBraintrustConfig({
        BRAINTRUST_API_KEY: "configured",
      }),
    ).toThrow();
    expect(
      readSafeCommitBraintrustConfig({
        SAFEFLASH_ALLOW_LIVE: "true",
        BRAINTRUST_API_KEY: "configured",
      }),
    ).toMatchObject({
      projectName: "SafeCommit",
      datasetName: "SafeCommit Logistics Mutations",
    });
  });
});
