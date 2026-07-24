import { NextResponse } from "next/server";

import { loadRecordedLiveSession } from "../../../../server/recorded-live-session";
import { apiErrorResponse } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await loadRecordedLiveSession());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
