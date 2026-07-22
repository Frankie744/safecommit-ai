import { SafeFlashCopilotProvider } from "../components/copilot-provider";
import { SafeFlashConsole } from "../components/safeflash-console";

export default function HomePage() {
  return (
    <SafeFlashCopilotProvider>
      <SafeFlashConsole />
    </SafeFlashCopilotProvider>
  );
}
