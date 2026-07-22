# SafeFlash runbook

This runbook separates the reproducible local path from the externally blocked
provider path. Do not change the mode label, edit evidence JSON, or describe a
local result as Daytona/Braintrust/Fireworks/GitHub/CodeRabbit output.

## 1. Prerequisites

- Windows PowerShell
- Git
- Node.js 22 or newer
- npm 10 or newer
- Visual Studio C++ build tools with MSVC and CMake
- Google Chrome for the configured Playwright project

The verified machine found Visual Studio under `D:\visual_studio`. The firmware
script also searches `cmake.exe` on `PATH`; override the installation only when
needed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-firmware.ps1 `
  -VisualStudioRoot "D:\visual_studio"
```

## 2. Install without credentials

From the repository root:

```powershell
npm ci
npm run typecheck
```

Do not create `.env.local` for the local path. The deterministic local
tournament does not need provider keys.

## 3. Reproduce the unsafe baseline

```powershell
npm run test:firmware
```

Expected contract:

- CMake configure exits 0.
- The C build exits 0.
- All five unit assertions pass.
- The safety executable exits nonzero with three passing and three failing
  assertions.
- `sensor_disconnect_enters_safe_state`,
  `stale_sample_limit_enters_safe_state`, and
  `normal_sample_cannot_clear_latched_fault` fail.
- The wrapper reports `PHASE1_RESULT=PASS` because observing this exact unsafe
  baseline is the expected Phase 1 result.

The run writes a timestamped package below
`artifacts/evidence/phase-1/` and updates that phase's `latest-run.txt`.

## 4. Run the local Safety Tournament

First require a clean, committed source revision:

```powershell
git status --short
npm run demo:local
```

The command should create three unique paths below
`.safeflash/local-sandboxes/`, execute real CMake/CTest work, and write a new
summary plus hash-chained event file under `artifacts/evidence/phase-3/`.

Expected shape—not hard-coded winner logic—is:

- Candidate A builds and passes 5/5 unit assertions but fails 0/6 safety
  assertions. Its score can be higher than the winner and it remains
  ineligible.
- Candidate B fails compilation, so later tests do not run and it is
  ineligible.
- Candidate C builds, passes 5/5 unit and 6/6 safety assertions, passes every
  hard gate, and is selected.
- The event chain contains 27 events and replays to `completed` with three
  candidates and an eligible winner.

If the source tree is dirty, the runner marks the revision uncommitted and the
web session service refuses to treat it as approval-grade evidence. Commit only
intended work; do not bypass this guard.

## 5. Run the console locally

Development server:

```powershell
npm run dev
```

Open `http://127.0.0.1:3000` (or the URL printed by Next.js), then:

1. Confirm the header says `MOCK • NOT PROVIDER-VERIFIED`.
2. Click **Run Safety Tournament**.
3. Wait for the real local CMake/CTest run to finish.
4. Check that all three candidate cards remain visible and that Candidate A's
   higher score cannot overcome its failed safety gate.
5. Open Candidate C's diff/evidence.
6. Click **Approve evidence (no live PR)**.
7. Confirm the decision becomes disabled and the page says live publishing
   remains blocked.
8. Reload the page and confirm the same approval and timeline are restored.

The local endpoint intentionally does not create a PR. Its recorded state
remains `AWAITING_HUMAN_APPROVAL`, and `pullRequest` remains absent.

### Production build

```powershell
npm run build
npm run start --workspace @safeflash/web -- --hostname 127.0.0.1 --port 3000
```

The web build runs TypeScript first, then Next.js compile and generate modes as
defined in `apps/web/package.json`.

## 6. Run the automated checks

Run individual layers while diagnosing:

```powershell
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:adversarial
npm run test:e2e
```

During development, run the complete repository contract without evidence
capture:

```powershell
npm run verify
git diff --check
```

`npm run verify` performs typecheck, all Vitest suites, a production web build,
and the Chrome 1440×900 Playwright suite. E2E starts its own production server
on an automatically selected localhost port.

After all intended files are committed and `git status --short` is empty, run
the authoritative local P0 capture:

```powershell
npm run verify:p0
```

`verify:p0` refuses a dirty tree, strips provider credentials from child
processes, binds the run to `git rev-parse HEAD`, and captures these four
commands in order:

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. `npm run test:e2e`

It also reads the Vitest JSON report and requires all 14 specification P0 test
names to be present and passing. The resulting redacted logs, Vitest report,
P0 matrix, summary, and SHA-256 manifest are written below a timestamped
`artifacts/evidence/phase-6/p0-verification-*/` directory, with
`phase-6/latest-run.txt` pointing to the latest capture. A pass proves the full
local contract only; its provenance notice explicitly excludes external live
providers.

## 7. Validate committed evidence

Start with the ledgers:

```powershell
Get-Content HACKATHON_BUILD.md
Get-Content artifacts/evidence/phase-4/latest-run.txt
Get-Content artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/verification.json
```

Verify the Phase 4 manifest from its directory:

```powershell
Push-Location artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z
Get-Content manifest.sha256 | ForEach-Object {
  $parts = $_ -split '  ', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $parts[1]).Hash.ToLower()
  if ($actual -ne $parts[0]) { throw "Hash mismatch: $($parts[1])" }
}
Pop-Location
```

The manifest covers the screenshot, session, copied event log, browser
inspection, replay result, README, and verification JSON. It proves local
production-console behavior only.

## 8. Configure external smoke checks

Only do this with authorized accounts and a public demo repository. Copy the
template and keep the result untracked:

```powershell
Copy-Item .env.example .env.local
```

Required live switch:

```text
SAFEFLASH_ALLOW_LIVE=true
```

Provider variables:

| Provider | Required values | Additional prerequisite |
|---|---|---|
| Fireworks | `FIREWORKS_API_KEY`, `FIREWORKS_MODEL` | model supports the requested JSON Schema response |
| Daytona | `DAYTONA_API_KEY` | account can create/delete a private sandbox |
| Braintrust | `BRAINTRUST_API_KEY` | permission to create Dataset/Trace/Experiment in the configured project |
| GitHub | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` | public repo; token reports push and PR write access |
| CodeRabbit | the GitHub values plus `SAFEFLASH_SMOKE_PR_NUMBER`, `SAFEFLASH_SMOKE_PR_HEAD_SHA` | CodeRabbit App installed; existing open PR at that exact SHA |

Optional provider settings and defaults are documented in
[`../.env.example`](../.env.example). Never use a provider secret in a
`NEXT_PUBLIC_` variable.

Run one provider at a time:

```powershell
npm run smoke:external -- --provider=fireworks
npm run smoke:external -- --provider=daytona
npm run smoke:external -- --provider=braintrust
npm run smoke:external -- --provider=github
npm run smoke:external -- --provider=coderabbit
```

The command performs a pure configuration preflight before constructing any
provider client. If preflight passes, the bounded external effects are:

- Fireworks: one metered structured-output inference request.
- Daytona: one private, network-blocked ephemeral sandbox, one exact smoke
  command, then synchronous deletion.
- Braintrust: test-labelled Dataset rows, one Trace, and one one-case
  Experiment in the configured project.
- GitHub: authenticated identity and repository/base-head reads only.
- CodeRabbit: one read of an existing open PR plus its exact-head reviews,
  comments, and checks.

The smoke command never creates, updates, or merges a GitHub PR. Fireworks and
Daytona accept only their pinned official HTTPS endpoints; a custom credential
exfiltration endpoint is rejected before network access.

Or run all checks:

```powershell
npm run smoke:external
```

Exit codes:

- `0`: every requested provider returned verified live smoke evidence.
- `2`: at least one provider is blocked by configuration or a non-passing
  exact-head CodeRabbit gate.
- `1`: a provider call failed.

At the current committed checkpoint, the expected result is exit code `2` with
all five services blocked. Do not edit that output into a pass.

### Important live-path limitation

Passing the smoke checks validates individual provider adapters. It does **not**
turn the current production session route into a full live orchestration path.
`SessionService.create()` currently invokes the local deterministic tournament
and marks it `mock/local-test`. A real end-to-end provider demo requires the
adapters to be composed into the server workflow and then verified with fresh
provider IDs, a PR URL, and an exact-head CodeRabbit result.

## 9. Offline evidence fallback

The committed fallback requires no network or provider account:

1. Open
   `artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/console-1440x900.png`.
2. Point out the red incident, three candidate cards, provenance label, and
   disabled post-approval control.
3. Open `verification.json` and read the candidate/sandbox, approval-binding,
   replay, browser, and test assertions.
4. Open `replay.txt` and `manifest.sha256` to show the independently verified
   27-event chain and artifact hashes.
5. Say explicitly: “This is committed local-test evidence, not recorded-live
   Daytona or Braintrust evidence.”

This is an evidence walkthrough, not a provider replay. A true Cached Evidence
mode must carry `recorded-live` provenance, original capture time, provider
references, and immutable artifacts before it can be advertised as such.

## 10. Troubleshooting

### Firmware toolchain is missing

Confirm the Visual Studio installation contains MSVC and CMake, then pass the
correct absolute `-VisualStudioRoot`. Do not replace the native fixture with a
fake build result.

### Session creation returns 409

The source is not a clean committed revision or the event binding is invalid.
Inspect `git status --short`; do not weaken `UNCOMMITTED_VALIDATION_SOURCE`.

### Session read reports `CORRUPT_SESSION`

The persisted view no longer matches its JSONL evidence, commit, patch digest,
evidence digest, or approval. Keep the corrupt files for diagnosis and create a
new clean session. Do not hand-edit the snapshot.

### Copilot endpoint returns 503

This is the current honest behavior: no server-side CopilotKit model provider
is configured. The evidence console and backend approval endpoint still work.
Do not claim live Copilot chat from the HITL registration alone.

### External smoke is blocked

Read each redacted `reason`, confirm `SAFEFLASH_ALLOW_LIVE=true`, and supply
only the named authorized credential. CodeRabbit additionally needs an
installed App and a real PR number plus exact head SHA.

### Do not modify during the last hour

- Hard-gate eligibility and score weights
- Patch-integrity protected paths or threshold detection
- Approval binding fields
- Event canonicalization/hash-chain validation
- Exact-head GitHub/CodeRabbit checks
- Provenance labels or live fail-closed behavior
- The Battery Sentinel fixture and its expected baseline failure
