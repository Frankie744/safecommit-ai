import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { DatabaseSessionServiceError } from "./database-session-service";
import { SessionServiceError } from "./session-service";

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof SessionServiceError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof DatabaseSessionServiceError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFIGURATION_BLOCKED"
          ? 503
          : 409;
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "The request did not match the strict API contract.",
        },
      },
      { status: 400 },
    );
  }
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    },
    { status: 500 },
  );
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new SessionServiceError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}
