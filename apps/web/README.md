# SafeFlash Web Console

The UI is a Next.js 16 App Router application driven only by the SafeFlash
session API. It does not contain a production mock data path or a prerecorded
animation.

The root workspace currently pins the TypeScript 7 native-preview package. It
does not ship the legacy `typescript/lib/typescript.js` entry that Next 16's
built-in dependency checker expects. The workspace build therefore runs the
real TypeScript 7 typecheck first, then uses Next's supported compile and
generate build modes to produce the finalized application without invoking
that incompatible legacy checker.

CopilotKit v2 is integrated through `useAgentContext` for the current API
snapshot and `useHumanInTheLoop` for evidence-bound approval interrupts. The
visible approval gate and CopilotKit interrupt both submit to the backend
decision endpoint; neither can create a pull request in the browser.
