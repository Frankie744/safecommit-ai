import { NextResponse } from "next/server";

import { SessionServiceError } from "./session-service";

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof SessionServiceError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
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
