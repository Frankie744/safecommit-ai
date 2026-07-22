import { NextResponse } from "next/server";

import { apiErrorResponse } from "../../../../server/http";
import { getSessionService } from "../../../../server/session-service";

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
    return NextResponse.json({ session: await getSessionService().get(sessionId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
