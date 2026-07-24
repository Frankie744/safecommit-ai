"use client";

import type { DatabaseSessionView } from "./database-session-types";

async function requestSession(
  path: string,
  options?: {
    method?: "POST";
    token?: string;
    body?: unknown;
  },
): Promise<DatabaseSessionView> {
  const response = await fetch(path, {
    method: options?.method ?? "GET",
    headers:
      options?.method === "POST"
        ? {
            "content-type": "application/json",
            "x-safecommit-operator-token": options.token ?? "",
          }
        : undefined,
    body:
      options?.method === "POST"
        ? JSON.stringify(options.body ?? {})
        : undefined,
    cache: "no-store",
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null &&
      "message" in payload.error
        ? String(payload.error.message)
        : `SafeCommit API failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as DatabaseSessionView;
}

export async function listDatabaseSessions(): Promise<
  readonly DatabaseSessionView[]
> {
  const response = await fetch("/api/database-sessions", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Unable to list SafeCommit sessions: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    sessions?: readonly DatabaseSessionView[];
  };
  return payload.sessions ?? [];
}

export function createDatabaseSession(
  token: string,
  mode: "mock" | "local-test",
): Promise<DatabaseSessionView> {
  return requestSession("/api/database-sessions", {
    method: "POST",
    token,
    body: { mode },
  });
}

export function decideDatabaseSession(
  sessionId: string,
  token: string,
  decision: "approved" | "rejected" | "changes_requested",
): Promise<DatabaseSessionView> {
  return requestSession(
    `/api/database-sessions/${encodeURIComponent(sessionId)}/decision`,
    {
      method: "POST",
      token,
      body: { decision },
    },
  );
}

export function revalidateDatabaseSession(
  sessionId: string,
  token: string,
): Promise<DatabaseSessionView> {
  return requestSession(
    `/api/database-sessions/${encodeURIComponent(sessionId)}/revalidate`,
    {
      method: "POST",
      token,
    },
  );
}
