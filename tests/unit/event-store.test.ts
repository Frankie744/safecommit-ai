import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EventChainIntegrityError,
  JsonlEventStore,
  replayEvents,
} from "../../apps/orchestrator/src/event-store";

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<JsonlEventStore> {
  const directory = await mkdtemp(join(tmpdir(), "safeflash-event-store-"));
  temporaryDirectories.push(directory);
  return new JsonlEventStore(join(directory, "events.jsonl"));
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(join(tmpdir(), "safeflash-event-store-"))) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
describe("append-only hash-chain event store", () => {
  it("serializes concurrent appends and replays verified local evidence", async () => {
    const store = await temporaryStore();
    await store.append({
      sessionId: "session-event-store",
      eventType: "TOURNAMENT_STARTED",
      occurredAt: "2026-07-22T12:00:00.000Z",
      payload: { candidateCount: 3 },
    });
    await Promise.all(
      ["candidate-a", "candidate-b", "candidate-c"].map((candidateId, index) =>
        store.append({
          sessionId: "session-event-store",
          eventType: "CANDIDATE_VALIDATION_STARTED",
          occurredAt: `2026-07-22T12:00:0${index + 1}.000Z`,
          payload: { candidateId, sandboxId: `sandbox-${index}` },
        }),
      ),
    );

    const events = await store.readAll();
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[0]?.previousEventHash).toBeNull();
    expect(events[1]?.previousEventHash).toBe(events[0]?.eventHash);
    expect(events.every((event) => event.provenance.mode === "mock")).toBe(true);
    expect(events.every((event) => event.provenance.kind === "local-test")).toBe(true);

    const replayed = replayEvents(events, [] as string[], (state, event) => [
      ...state,
      event.eventType,
    ]);
    expect(replayed).toEqual([
      "TOURNAMENT_STARTED",
      "CANDIDATE_VALIDATION_STARTED",
      "CANDIDATE_VALIDATION_STARTED",
      "CANDIDATE_VALIDATION_STARTED",
    ]);
  });

  it("rejects a modified historical event", async () => {
    const store = await temporaryStore();
    await store.append({
      sessionId: "session-tamper",
      eventType: "TOURNAMENT_STARTED",
      occurredAt: "2026-07-22T12:00:00.000Z",
      payload: { candidateCount: 3 },
    });

    const original = await readFile(store.filePath, "utf8");
    await writeFile(store.filePath, original.replace("candidateCount\":3", "candidateCount\":2"), "utf8");

    await expect(store.readAll()).rejects.toBeInstanceOf(EventChainIntegrityError);
  });

  it("rejects a hash-valid completion that skips candidate evidence", async () => {
    const store = await temporaryStore();
    await store.append({
      sessionId: "session-semantic-forgery",
      eventType: "TOURNAMENT_STARTED",
      occurredAt: "2026-07-22T12:00:00.000Z",
      payload: { candidateCount: 3 },
    });

    await expect(
      store.append({
        sessionId: "session-semantic-forgery",
        eventType: "TOURNAMENT_COMPLETED",
        occurredAt: "2026-07-22T12:00:01.000Z",
        payload: { winnerCandidateId: "candidate-never-validated" },
      }),
    ).rejects.toBeInstanceOf(EventChainIntegrityError);
  });
});
