# SafeFlash

**The safety gate for AI-generated firmware.**

SafeFlash generates multiple firmware repair candidates, executes each inside
an isolated environment, evaluates non-negotiable physical-safety invariants,
and requires evidence-bound human approval before it can create a pull request.
An independent CodeRabbit review can send the selected patch through the full
validation pipeline again. SafeFlash never merges a PR.

## Verification status

The project started from an empty-workspace baseline on 2026-07-22. Local and
external capabilities are reported separately. A local contract test is never
presented as Daytona, Braintrust, Fireworks, GitHub, or CodeRabbit evidence.

Current authoritative status is maintained in `HACKATHON_BUILD.md` and
`artifacts/evidence/`.

## Development prerequisites

- Node.js 22+
- npm 10+
- Visual Studio C++ build tools with CMake (for the firmware fixture)

Copy `.env.example` to `.env.local` only when configuring credentials. Never
commit `.env.local`.

```powershell
npm ci
npm run dev
```

Run `npm run verify` while developing. After all intended changes are committed
and `git status --short` is empty, `npm run verify:p0` captures typecheck,
production build, Vitest, Chrome Playwright, a final bundle/staging secret scan,
and the exact 14-test P0 matrix in a hash-manifested Phase 6 evidence package.
This is a local-test claim only.

Project handoff:

- [Architecture](docs/architecture.md)
- [Setup, verification, and external smoke runbook](docs/runbook.md)
- [P0 and judging map](docs/judging-map.md)
- [Three-minute demo runbook](DEMO_RUNBOOK.md)
- [Devpost draft](DEVPOST.md)

The live Fireworks, Daytona, Braintrust, GitHub, and CodeRabbit path still
requires authorized credentials, a public demo repository, and CodeRabbit App
installation. Missing provider access fails closed and is never relabelled as
live success.
