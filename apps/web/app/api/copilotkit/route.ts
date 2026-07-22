import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = {
  error: {
    code: "COPILOT_RUNTIME_NOT_CONFIGURED",
    message:
      "CopilotKit live runtime is unavailable. Configure a server-side model provider before enabling agent chat.",
  },
  capability: {
    available: false,
    mode: "mock",
    provenance: {
      kind: "local-test",
      provider: "none",
      verified: false,
    },
  },
} as const;

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(unavailable, { status: 503 });
}

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(unavailable, { status: 503 });
}
