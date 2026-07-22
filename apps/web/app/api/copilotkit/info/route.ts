import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      available: false,
      mode: "mock",
      agents: [],
      provenance: {
        kind: "local-test",
        provider: "none",
        verified: false,
      },
      reason: "No server-side CopilotKit model provider is configured.",
    },
    { status: 200 },
  );
}
