import { NextResponse } from "next/server";

import { loadRecordedLiveSession } from "../../../../server/recorded-live-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await loadRecordedLiveSession());
  } catch (error) {
    console.error("Recorded Live evidence replay failed", error);
    return NextResponse.json(
      {
        error: {
          code: "RECORDED_LIVE_REPLAY_FAILED",
          message: "The verified Recorded Live evidence could not be loaded.",
        },
      },
      { status: 500 },
    );
  }
}
