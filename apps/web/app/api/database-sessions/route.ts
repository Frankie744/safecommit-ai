import { NextResponse } from "next/server";

import { authorizeDatabaseMutation } from "../../../server/database-auth";
import { getDatabaseSessionService } from "../../../server/database-session-service";
import { apiErrorResponse, readJsonBody } from "../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    sessions: getDatabaseSessionService().list(),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = authorizeDatabaseMutation(request);
  if (denied !== undefined) return denied;
  try {
    const session = await getDatabaseSessionService().create(
      await readJsonBody(request),
    );
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
