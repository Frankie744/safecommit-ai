import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "../../../server/http";
import { getActiveSessionService } from "../../../server/active-session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ sessions: await getActiveSessionService().list() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await getActiveSessionService().create(
      await readJsonBody(request),
    );
    return NextResponse.json(
      { session },
      { status: session.mode === "live" ? 202 : 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
