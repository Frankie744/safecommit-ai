import type { SessionMode, SessionView } from "../lib/session-types";
import { getLiveSessionService } from "./live-session-service";
import { getRecordedLiveSessionService } from "./recorded-live-session-service";
import {
  getSessionService,
  SessionServiceError,
} from "./session-service";

export interface SessionApiService {
  create(input: unknown): Promise<SessionView>;
  get(sessionId: string): Promise<SessionView>;
  list(): Promise<readonly SessionView[]>;
  decide(sessionId: string, input: unknown): Promise<SessionView>;
  retry?(sessionId: string): Promise<SessionView>;
}

/** Selects one honest execution mode. Unsupported/cached modes never fall back. */
export function getActiveSessionMode(): Extract<
  SessionMode,
  "live" | "cached" | "mock"
> {
  const mode = process.env.SAFEFLASH_DEFAULT_MODE ?? "mock";
  if (mode === "mock" || mode === "live" || mode === "cached") return mode;
  throw new SessionServiceError(
    503,
    "UNSUPPORTED_SESSION_MODE",
    "SAFEFLASH_DEFAULT_MODE must be exactly live, cached, or mock.",
  );
}

export function getActiveSessionService(): SessionApiService {
  const mode = getActiveSessionMode();
  if (mode === "mock") return getSessionService();
  if (mode === "live") return getLiveSessionService();
  return getRecordedLiveSessionService();
}
