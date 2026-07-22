"use client";

import { CopilotKitProvider, HttpAgent } from "@copilotkit/react-core/v2";
import { useMemo, type ReactNode } from "react";

export function SafeFlashCopilotProvider({
  children,
}: {
  children: ReactNode;
}) {
  const agent = useMemo(
    () =>
      new HttpAgent({
        agentId: "safeflash",
        description:
          "SafeFlash evidence console agent. High-risk decisions remain server-gated.",
        url: "/api/copilotkit",
      }),
    [],
  );
  const agents = useMemo(() => ({ safeflash: agent }), [agent]);

  return (
    <CopilotKitProvider agents__unsafe_dev_only={agents}>
      {children}
    </CopilotKitProvider>
  );
}
