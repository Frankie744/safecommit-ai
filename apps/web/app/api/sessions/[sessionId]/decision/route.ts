import { NextResponse } from "next/server";

import { getActiveSessionService } from "../../../../../server/active-session-service";
import { apiErrorResponse, readJsonBody } from "../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const { sessionId } = await context.params;
    const session = await getActiveSessionService().decide(
      sessionId,
      await readJsonBody(request),
    );
    return NextResponse.json({ session });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
