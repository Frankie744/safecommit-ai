import { NextResponse } from "next/server";

import { authorizeDatabaseMutation } from "../../../../../server/database-auth";
import { getDatabaseSessionService } from "../../../../../server/database-session-service";
import { apiErrorResponse } from "../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ sessionId: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const denied = authorizeDatabaseMutation(request);
  if (denied !== undefined) return denied;
  try {
    const { sessionId } = await context.params;
    return NextResponse.json(
      getDatabaseSessionService().revalidate(sessionId),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
