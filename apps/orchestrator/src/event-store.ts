import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  canonicalJson,
  computeEvidenceDigest,
  type JsonObject,
} from "@safeflash/domain";

export interface LocalTestProvenance {
  mode: "mock";
  kind: "local-test";
  provider: "local-process";
  notice: "LOCAL TEST EVIDENCE - NOT DAYTONA OR RECORDED LIVE";
}
export const LOCAL_TEST_PROVENANCE: LocalTestProvenance = Object.freeze({
  mode: "mock",
  kind: "local-test",
  provider: "local-process",
  notice: "LOCAL TEST EVIDENCE - NOT DAYTONA OR RECORDED LIVE",
});

export interface EventToAppend {
  sessionId: string;
  eventType: string;
  occurredAt: string;
  payload: JsonObject;
  provenance?: LocalTestProvenance;
}

export interface StoredEvent extends EventToAppend {
  schemaVersion: 1;
  sequence: number;
  provenance: LocalTestProvenance;
  previousEventHash: string | null;
  eventHash: string;
}

export class EventChainIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventChainIntegrityError";
  }
}

function eventHashInput(event: Omit<StoredEvent, "eventHash">): JsonObject {
  return event as unknown as JsonObject;
}

function parseJsonLine(line: string, lineNumber: number): StoredEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new EventChainIntegrityError(
      `Event log line ${lineNumber} is not valid JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new EventChainIntegrityError(`Event log line ${lineNumber} is not an object`);
  }
  return decoded as StoredEvent;
}

export function verifyEventChain(events: readonly StoredEvent[]): void {
  let previousEventHash: string | null = null;
  let sessionId: string | undefined;
  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1;
    if (event.schemaVersion !== 1 || event.sequence !== expectedSequence) {
      throw new EventChainIntegrityError(
        `Event ${expectedSequence} has an invalid schema version or sequence`,
      );
    }
    if (sessionId === undefined) sessionId = event.sessionId;
    if (event.sessionId !== sessionId) {
      throw new EventChainIntegrityError("A JSONL event file cannot mix session IDs");
    }
    if (
      event.provenance?.mode !== "mock" ||
      event.provenance.kind !== "local-test" ||
      event.provenance.provider !== "local-process"
    ) {
      throw new EventChainIntegrityError(
        `Event ${expectedSequence} does not carry local-test/mock provenance`,
      );
    }
    if (event.previousEventHash !== previousEventHash) {
      throw new EventChainIntegrityError(
        `Event ${expectedSequence} does not link to the previous event hash`,
      );
    }
    const { eventHash, ...unsigned } = event;
    const expectedHash = computeEvidenceDigest(eventHashInput(unsigned));
    if (eventHash !== expectedHash) {
      throw new EventChainIntegrityError(
        `Event ${expectedSequence} hash does not match its content`,
      );
    }
    previousEventHash = eventHash;
  }
}

export class JsonlEventStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(public readonly filePath: string) {}

  async readAll(): Promise<readonly StoredEvent[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) {
      throw new EventChainIntegrityError(
        "Event log ends with a partial line; append-only recovery is required",
      );
    }
    const events = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseJsonLine);
    verifyEventChain(events);
    return events;
  }

  append(input: EventToAppend): Promise<StoredEvent> {
    let resolveResult!: (event: StoredEvent) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<StoredEvent>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.writeQueue = this.writeQueue
      .then(async () => {
        const current = await this.readAll();
        const last = current.at(-1);
        if (last !== undefined && last.sessionId !== input.sessionId) {
          throw new EventChainIntegrityError(
            "Cannot append a different session to an existing event log",
          );
        }
        const unsigned: Omit<StoredEvent, "eventHash"> = {
          schemaVersion: 1,
          sequence: current.length + 1,
          sessionId: input.sessionId,
          eventType: input.eventType,
          occurredAt: input.occurredAt,
          payload: input.payload,
          provenance: input.provenance ?? LOCAL_TEST_PROVENANCE,
          previousEventHash: last?.eventHash ?? null,
        };
        const event: StoredEvent = {
          ...unsigned,
          eventHash: computeEvidenceDigest(eventHashInput(unsigned)),
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${canonicalJson(event)}\n`, "utf8");
        resolveResult(event);
      })
      .catch((error: unknown) => {
        rejectResult(error);
      });

    return result;
  }
}

export function replayEvents<State>(
  events: readonly StoredEvent[],
  initialState: State,
  reducer: (state: State, event: StoredEvent) => State,
): State {
  verifyEventChain(events);
  return events.reduce(reducer, initialState);
}

export interface TournamentReplayCandidate {
  sandboxId: string;
  buildPassed: boolean;
  unitTestsPassed: boolean;
  safetyTestsPassed: boolean;
  eligible: boolean;
  weightedScore: number;
}

export interface TournamentReplayState {
  sessionId: string | null;
  provenance: LocalTestProvenance | null;
  status: "idle" | "running" | "completed" | "failed";
  candidates: Readonly<Record<string, TournamentReplayCandidate>>;
  winnerCandidateId: string | null;
}

export const EMPTY_TOURNAMENT_REPLAY: TournamentReplayState = {
  sessionId: null,
  provenance: null,
  status: "idle",
  candidates: {},
  winnerCandidateId: null,
};

export function reduceTournamentEvent(
  state: TournamentReplayState,
  event: StoredEvent,
): TournamentReplayState {
  switch (event.eventType) {
    case "TOURNAMENT_STARTED":
      return {
        ...state,
        sessionId: event.sessionId,
        provenance: event.provenance,
        status: "running",
      };
    case "CANDIDATE_VALIDATION_COMPLETED": {
      const payload = event.payload as {
        candidateId: string;
        sandboxId: string;
        buildPassed: boolean;
        unitTestsPassed: boolean;
        safetyTestsPassed: boolean;
        eligible: boolean;
        weightedScore: number;
      };
      return {
        ...state,
        candidates: {
          ...state.candidates,
          [payload.candidateId]: {
            sandboxId: payload.sandboxId,
            buildPassed: payload.buildPassed,
            unitTestsPassed: payload.unitTestsPassed,
            safetyTestsPassed: payload.safetyTestsPassed,
            eligible: payload.eligible,
            weightedScore: payload.weightedScore,
          },
        },
      };
    }
    case "TOURNAMENT_COMPLETED":
      return {
        ...state,
        status: "completed",
        winnerCandidateId:
          typeof event.payload.winnerCandidateId === "string"
            ? event.payload.winnerCandidateId
            : null,
      };
    case "TOURNAMENT_FAILED":
      return { ...state, status: "failed" };
    default:
      return state;
  }
}
