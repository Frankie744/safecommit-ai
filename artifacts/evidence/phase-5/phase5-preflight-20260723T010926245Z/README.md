# Phase 5 external preflight evidence

- Command: `npm run smoke:external -- --provider=all`
- Captured at: `2026-07-23T01:09:26.245Z`
- Result: `blocked` (expected non-zero exit)
- Network/provider clients constructed: none
- External mutation: none

The aggregate preflight failed closed because live mode and the required
Fireworks, Daytona, Braintrust, GitHub, and CodeRabbit configuration were not
present. `external-smoke.json` is the exact redacted JSON emitted by the smoke
runner. No provider is represented as successful.
