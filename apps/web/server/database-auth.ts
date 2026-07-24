import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_WINDOW = 6;
const attempts = new Map<string, { count: number; windowStartedAt: number }>();

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function authorizeDatabaseMutation(
  request: Request,
): NextResponse | undefined {
  const configured = process.env.SAFECOMMIT_OPERATOR_TOKEN?.trim();
  if (!configured || configured.length < 24) {
    return NextResponse.json(
      {
        error: {
          code: "OPERATOR_AUTH_NOT_CONFIGURED",
          message:
            "Set a server-only SAFECOMMIT_OPERATOR_TOKEN with at least 24 characters.",
        },
      },
      { status: 503 },
    );
  }
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  const expectedOrigin = host === null ? new URL(request.url).origin : `${protocol}://${host}`;
  const referer = request.headers.get("referer");
  let refererOrigin: string | undefined;
  if (referer !== null) {
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      refererOrigin = undefined;
    }
  }
  if (
    origin !== expectedOrigin &&
    (origin !== null || refererOrigin !== expectedOrigin)
  ) {
    return NextResponse.json(
      {
        error: {
          code: "SAME_ORIGIN_REQUIRED",
          message: "Database mutations require an exact same-origin request.",
        },
      },
      { status: 403 },
    );
  }
  const supplied = request.headers.get("x-safecommit-operator-token") ?? "";
  if (!equalSecret(supplied, configured)) {
    return NextResponse.json(
      {
        error: {
          code: "OPERATOR_AUTH_REQUIRED",
          message: "A valid operator token is required.",
        },
      },
      { status: 401 },
    );
  }

  const now = Date.now();
  const key = computeRateLimitKey(supplied);
  const current = attempts.get(key);
  const entry =
    current === undefined || now - current.windowStartedAt >= WINDOW_MS
      ? { count: 0, windowStartedAt: now }
      : current;
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > MAX_MUTATIONS_PER_WINDOW) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "The operator mutation rate limit was exceeded.",
        },
      },
      { status: 429 },
    );
  }
  return undefined;
}

function computeRateLimitKey(token: string): string {
  let hash = 2166136261;
  for (const character of token) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}
