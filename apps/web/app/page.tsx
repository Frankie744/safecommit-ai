import { SafeCommitCopilotProvider } from "../components/copilot-provider";
import { SafeCommitConsole } from "../components/safecommit-console";

export default function HomePage() {
  return (
    <SafeCommitCopilotProvider>
      <SafeCommitConsole />
    </SafeCommitCopilotProvider>
  );
}
