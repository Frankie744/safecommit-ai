import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRecordedLiveArtifact,
  serializeRecordedLiveArtifact,
} from "@safeflash/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getActiveSessionService } from "../../apps/web/server/active-session-service";
import {
  RecordedLiveSessionService,
  recordedLiveArtifactToSessionView,
} from "../../apps/web/server/recorded-live-session-service";
import { SessionServiceError } from "../../apps/web/server/session-service";
import {
  RECORDED_LIVE_TEST_SIGNING_KEY,
  recordedLiveCaptureFixture,
} from "../fixtures/recorded-live";

const temporaryDirectories: string[] = [];

async function writeFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "safeflash-recorded-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "recorded-live.json");
  const artifact = createRecordedLiveArtifact(
    recordedLiveCaptureFixture(),
    RECORDED_LIVE_TEST_SIGNING_KEY,
  );
  await writeFile(
    path,
    serializeRecordedLiveArtifact(
      artifact,
      RECORDED_LIVE_TEST_SIGNING_KEY,
    ),
    {
    encoding: "utf8",
    flag: "wx",
    },
  );
  return path;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  globalThis.__safeFlashRecordedLiveSessionService = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("recorded-live session service", () => {
  it("replays the immutable artifact as cached and recorded-live everywhere", async () => {
    const path = await writeFixture();
    const service = new RecordedLiveSessionService({
      artifactPath: path,
      signingKey: RECORDED_LIVE_TEST_SIGNING_KEY,
    });
    const [view] = await service.list();

    expect(view).toBeDefined();
    expect(view!.mode).toBe("cached");
    expect(view!.scenario).toMatchObject({
      id: "happy-path",
      default: false,
    });
    expect(view!.currentCommitSha).toBe("2".repeat(40));
    expect(view!.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    const provenances = [
      view!.incident.provenance,
      view!.policy.provenance,
      ...view!.events.map((event) => event.provenance),
      ...view!.candidates.flatMap((candidate) => [
        candidate.generation!.provenance,
        candidate.sandbox.provenance,
        candidate.build.provenance,
        candidate.tests.provenance,
        candidate.safetyGate.provenance,
        candidate.score.provenance,
      ]),
      view!.pullRequest!.provenance,
      view!.review!.provenance,
    ];
    expect(
      provenances.every(
        (provenance) =>
          provenance.kind === "recorded-live" && provenance.verified,
      ),
    ).toBe(true);
    expect(view!.candidates[0]!.sandbox.provenance.externalId).toContain(
      "sandbox:sandbox-1",
    );
    expect(view!.candidates[0]!.score.resultId).toBe("eval-result-1");
    expect(view!.candidates[0]!.score.provenance.externalId).toContain(
      "eval-result:eval-result-1",
    );
    expect(view!.review!.provenance.externalId).toContain("review:review-1");
    expect(view!.providerEvidence).toHaveLength(5);
    expect(
      view!.providerEvidence?.every(
        (evidence) =>
          evidence.requestIds !== undefined &&
          evidence.resourceIds.length > 0,
      ),
    ).toBe(true);
    expect(
      view!.providerEvidence?.find(
        (evidence) => evidence.provider === "braintrust",
      ),
    ).toMatchObject({
      requestIds: [],
      resourceIds: [
        "dataset-1",
        "experiment-1",
        "trace-1",
        "eval-result-1",
      ],
      urls: ["https://www.braintrust.dev/app/test/p/experiment-1"],
    });
    expect(view!.cleanup).toMatchObject({
      status: "deleted",
      sandboxIds: ["sandbox-1"],
    });
    expect(view!.cleanup?.provenance.kind).toBe("recorded-live");

    await expect(service.get(view!.id)).resolves.toEqual(view);
    await expect(
      service.create({
        incidentKind: "battery-sensor-disconnect",
        runKind: "tournament",
      }),
    ).resolves.toEqual(view);
    await expect(service.decide(view!.id, {})).rejects.toMatchObject({
      code: "RECORDED_LIVE_READ_ONLY",
    } satisfies Partial<SessionServiceError>);
  });

  it("fails closed on a modified digest and never returns a mock session", async () => {
    const path = await writeFixture();
    const parsed = JSON.parse(
      serializeRecordedLiveArtifact(
        createRecordedLiveArtifact(
          recordedLiveCaptureFixture(),
          RECORDED_LIVE_TEST_SIGNING_KEY,
        ),
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ) as {
      providers: { resources: { id: string }[] }[];
    };
    parsed.providers[0]!.resources[0]!.id = "tampered";
    await writeFile(path, JSON.stringify(parsed), "utf8");

    const service = new RecordedLiveSessionService({
      artifactPath: path,
      signingKey: RECORDED_LIVE_TEST_SIGNING_KEY,
    });
    await expect(service.list()).rejects.toMatchObject({
      code: "RECORDED_LIVE_INVALID",
    } satisfies Partial<SessionServiceError>);
  });

  it("requires an explicit artifact and routes cached mode without mock fallback", async () => {
    expect(() => new RecordedLiveSessionService()).toThrowError(
      expect.objectContaining({
        code: "RECORDED_LIVE_CONFIGURATION_UNAVAILABLE",
      }),
    );

    const path = await writeFixture();
    vi.stubEnv("SAFEFLASH_DEFAULT_MODE", "cached");
    vi.stubEnv("SAFEFLASH_RECORDED_LIVE_PATH", path);
    vi.stubEnv(
      "SAFEFLASH_RECORDED_LIVE_SIGNING_KEY",
      RECORDED_LIVE_TEST_SIGNING_KEY,
    );
    const service = getActiveSessionService();
    const sessions = await service.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.mode).toBe("cached");
    expect(sessions[0]?.incident.provenance.kind).toBe("recorded-live");
  });

  it("maps only validated artifacts into a replay view", () => {
    const artifact = createRecordedLiveArtifact(
      recordedLiveCaptureFixture(),
      RECORDED_LIVE_TEST_SIGNING_KEY,
    );
    const view = recordedLiveArtifactToSessionView(artifact);
    expect(view.mode).toBe("cached");
    expect(view.pullRequest?.status).toBe("open");
    expect(view.review?.headSha).toBe(view.currentCommitSha);
    expect(view.events.at(-1)?.state).toBe("READY_TO_MERGE");
  });
});
