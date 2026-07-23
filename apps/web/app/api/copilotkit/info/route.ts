import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const configuredMode = process.env.SAFEFLASH_DEFAULT_MODE ?? "mock";
  const sessionMode = ["live", "cached", "mock"].includes(configuredMode)
    ? configuredMode
    : "invalid";
  return NextResponse.json(
    {
      // `available` describes model-backed chat, not the state/HITL UI bridge.
      available: false,
      mode: "chat-runtime-not-configured",
      agents: [],
      provenance: {
        kind: "unknown",
        provider: "copilotkit-chat-runtime",
        verified: false,
      },
      uiBridge: {
        available: true,
        mode: `${sessionMode}-session-api`,
        sessionMode,
        capabilities: [
          "readable-session-state",
          "evidence-bound-human-approval",
          "server-owned-session-polling",
        ],
        runtimeUrl: "/api/copilotkit",
      },
      chatRuntime: {
        available: false,
        modelProvider: null,
        model: null,
      },
      reason:
        "CopilotKit state sharing and HITL UI are wired to the session API; no server-side model/chat runtime is configured.",
    },
    { status: 200 },
  );
}
