import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable() {
  const configuredMode = process.env.SAFEFLASH_DEFAULT_MODE ?? "mock";
  const sessionMode = ["live", "cached", "mock"].includes(configuredMode)
    ? configuredMode
    : "invalid";
  return {
  error: {
    code: "COPILOT_RUNTIME_NOT_CONFIGURED",
    message:
      "CopilotKit live runtime is unavailable. Configure a server-side model provider before enabling agent chat.",
  },
  capability: {
    available: false,
    mode: "chat-runtime-not-configured",
    uiBridgeAvailable: true,
    sessionMode,
    provenance: {
      kind: "unknown",
      provider: "copilotkit-chat-runtime",
      verified: false,
    },
  },
  } as const;
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(unavailable(), { status: 503 });
}

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(unavailable(), { status: 503 });
}
