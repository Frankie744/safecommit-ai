import { NextResponse } from "next/server";

import { getDatabaseSessionService } from "../../../../server/database-session-service";
import { apiErrorResponse } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { sessionId } = await context.params;
    return NextResponse.json(getDatabaseSessionService().get(sessionId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
