import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "../../../server/http";
import { getSessionService } from "../../../server/session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ sessions: await getSessionService().list() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await getSessionService().create(await readJsonBody(request));
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
