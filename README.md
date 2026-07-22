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
npm install
npm run dev
```

The full setup, live-provider smoke tests, fallback replay, and demo runbook are
added as their corresponding phases become verified.
