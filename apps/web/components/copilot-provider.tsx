"use client";

import { CopilotKitProvider, HttpAgent } from "@copilotkit/react-core/v2";
import { useMemo, type ReactNode } from "react";

export function SafeCommitCopilotProvider({
  children,
}: {
  children: ReactNode;
}) {
  const agent = useMemo(
    () =>
      new HttpAgent({
        agentId: "safecommit",
        description:
          "SafeCommit database evidence agent. Hard gates and approval remain server-owned.",
        url: "/api/copilotkit",
      }),
    [],
  );
  const agents = useMemo(() => ({ safecommit: agent }), [agent]);

  return (
    <CopilotKitProvider agents__unsafe_dev_only={agents}>
      {children}
    </CopilotKitProvider>
  );
}

export const SafeFlashCopilotProvider = SafeCommitCopilotProvider;
