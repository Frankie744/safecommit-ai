import { NextResponse } from "next/server";

import { getActiveSessionService } from "../../../../../server/active-session-service";
import { apiErrorResponse } from "../../../../../server/http";
import { SessionServiceError } from "../../../../../server/session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

export async function POST(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { sessionId } = await context.params;
    const service = getActiveSessionService();
    if (service.retry === undefined) {
      throw new SessionServiceError(
        409,
        "RETRY_NOT_AVAILABLE",
        "The selected session mode has no resumable provider operation.",
      );
    }
    return NextResponse.json({ session: await service.retry(sessionId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
