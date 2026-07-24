export const DEMO_SCENARIO_IDS = [
  "happy-path",
  "unsafe-high-score",
  "provider-failure",
] as const;

export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

export const DEFAULT_DEMO_SCENARIO_ID: DemoScenarioId = "unsafe-high-score";

export interface DemoScenario {
  id: DemoScenarioId;
  label: string;
  summary: string;
  default: boolean;
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = Object.freeze([
  {
    id: "unsafe-high-score",
    label: "Unsafe high score",
    summary:
      "The highest soft score violates a hard safety invariant and must be rejected.",
    default: true,
  },
  {
    id: "happy-path",
    label: "Happy path",
    summary:
      "Three candidates are validated and the eligible fail-closed repair reaches human approval.",
    default: false,
  },
  {
    id: "provider-failure",
    label: "Provider failure",
    summary:
      "A deterministic mock fault proves that missing provider evidence fails closed.",
    default: false,
  },
]);

export function demoScenario(id: DemoScenarioId): DemoScenario {
  const scenario = DEMO_SCENARIOS.find((entry) => entry.id === id);
  if (scenario === undefined) {
    throw new Error(`Unsupported demo scenario: ${id}`);
  }
  return scenario;
}
