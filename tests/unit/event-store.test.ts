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
    await Promise.all(
      ["STARTED", "CANDIDATE_DONE", "COMPLETED"].map((eventType, index) =>
        store.append({
          sessionId: "session-event-store",
          eventType,
          occurredAt: `2026-07-22T12:00:0${index}.000Z`,
          payload: { index },
        }),
      ),
    );

    const events = await store.readAll();
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[0]?.previousEventHash).toBeNull();
    expect(events[1]?.previousEventHash).toBe(events[0]?.eventHash);
    expect(events.every((event) => event.provenance.mode === "mock")).toBe(true);
    expect(events.every((event) => event.provenance.kind === "local-test")).toBe(true);

    const replayed = replayEvents(events, [] as string[], (state, event) => [
      ...state,
      event.eventType,
    ]);
    expect(replayed).toEqual(["STARTED", "CANDIDATE_DONE", "COMPLETED"]);
  });

  it("rejects a modified historical event", async () => {
    const store = await temporaryStore();
    await store.append({
      sessionId: "session-tamper",
      eventType: "SAFE_RESULT",
      occurredAt: "2026-07-22T12:00:00.000Z",
      payload: { eligible: false },
    });

    const original = await readFile(store.filePath, "utf8");
    await writeFile(store.filePath, original.replace("false", "true"), "utf8");

    await expect(store.readAll()).rejects.toBeInstanceOf(EventChainIntegrityError);
  });
});
