# SafeFlash competition demo runbook

This runbook optimizes for a reliable three-minute story without weakening the
evidence boundary. Read the matching [three-minute pitch](three-minute-pitch.md)
before rehearsing.

## Truth banner

The operator must choose and announce one evidence class before the demo:

| Mode shown | What is happening | Required wording |
|---|---|---|
| `LIVE` | The current run is calling the named external providers. | “This stage is live; these are the current provider references.” |
| `RECORDED_LIVE` | The UI or browser is showing immutable evidence captured from an earlier external run. | “This is recorded live evidence from the stated capture.” |
| `MOCK` | SafeFlash is running the deterministic local fixture and local toolchain. | “This is the deterministic fallback; it does not claim provider execution.” |

The configured `cached` application mode routes only to the read-only
recorded-live service. It requires a schema-valid, digest-bound artifact at
`SAFEFLASH_RECORDED_LIVE_PATH` and the same server-only
`SAFEFLASH_RECORDED_LIVE_SIGNING_KEY` used for capture. It verifies the
HMAC-SHA-256 attestation, rejects missing/invalid/wrong-key artifacts, and
cannot accept a decision. Do not use the label for arbitrary cached or mock
data.
On a complete `npm run demo:live` run, SafeFlash creates the redacted artifact
only after `READY_TO_MERGE` from the in-memory authority-bearing provider
envelopes, under `.safeflash/recorded-live/`. It cannot be generated from the
mock UI or from a serialized partial snapshot.

A real public [CodeRabbit cycle exists on PR #1](https://github.com/Frankie744/safeflash-ai/pull/1):
the first review requested changes, the repair was applied, and the exact
repaired head was approved. This proves the GitHub/CodeRabbit review boundary.
It does not certify the complete sponsor chain.

```text
RECORDED_LIVE_PROVENANCE=NOT_AVAILABLE
LIVE_CERTIFIED=NO
```

Keep that full-path status unchanged until one uninterrupted Fireworks →
Daytona → Braintrust → human approval → GitHub publication → CodeRabbit
repair/revalidation run has a single verified evidence package.

## Freeze checklist

Complete these steps before adding live credentials:

1. Start at the repository root on the intended committed revision.
2. Confirm `git status --short` is empty.
3. Run the read-only repository check:

   ```powershell
   npm run day-of:check
   npm run prepare:demo-pr -- --dry-run
   ```

4. Run `npm run verify`. On the final clean commit, run `npm run verify:p0` and
   inspect its summary and manifest.
5. Run `npm run rehearsal`; it performs only the software fallback and
   read-only GitHub identity/SHA checks.
6. Run `npm run verify:phase8`, then independently rerun
   `npm run evidence:verify -- artifacts/evidence/phase-8/<run-id>` using the
   run ID printed by the capture command.
7. Confirm Chrome can display `http://127.0.0.1:3018` at 1440×900 without
   clipping the incident, candidate cards, and approval panel.
8. Close private tabs, notifications, password managers, and terminals that
   could reveal credentials.
9. Confirm the projector, network, phone hotspot, and power adapter.

`day-of:check` intentionally rejects a repository-root `.env.local`. Run it
before credential injection. For a live rehearsal, inject secrets into the
server process from an operator-controlled environment after the read-only
checks; never print their values.

## Recommended competition path: deterministic UI plus public review proof

This is the lowest-risk presentation while the complete path is not live
certified.

### Start the console

After the one-time `npm ci`:

```powershell
npm run dev:competition
```

Open `http://127.0.0.1:3018`. Confirm the visible badge says
`MOCK • NOT PROVIDER-VERIFIED`.

### Reset before each rehearsal

- Use a fresh session instead of hand-editing a persisted JSON snapshot.
- Do not delete prior evidence merely because a run failed.
- Keep the browser on the incident view before the clock starts.
- Confirm the approval action says it will not create a live PR in local mode.

### Three-minute operator choreography

| Time | Operator action | Evidence to keep visible |
|---|---|---|
| 0:00–0:20 | Show the battery-sensor incident. | Charging can remain enabled after missing safety evidence; compilation alone is not safety. |
| 0:20–0:40 | Introduce SafeFlash and start the tournament. | Provenance badge and immutable safety invariants. |
| 0:40–1:25 | Keep all candidate cards visible; open one rejected candidate. | Separate strategy, execution identity, build/test result, hard-gate reason, and provenance. |
| 1:25–1:55 | Open the selected candidate’s diff/evidence and record approval. | Exact candidate, patch digest, evidence digest, policy, and source commit. |
| 1:55–2:30 | Show the GitHub/CodeRabbit boundary using PR #1. | Say it is a real prior external review boundary, not a current live workflow or formal recorded-live replay. |
| 2:30–3:00 | Return to the SafeFlash final state and close. | “Ready to merge” is a gate result; SafeFlash never merges. |

Use the exact narration in [three-minute-pitch.md](three-minute-pitch.md).

### Optional immutable full-run replay

Use this only after a complete all-provider live artifact passes integrity and
secret validation:

```powershell
$env:SAFEFLASH_DEFAULT_MODE = "cached"
$env:SAFEFLASH_RECORDED_LIVE_PATH = "C:\absolute\path\to\verified-recorded-live.json"
$env:SAFEFLASH_RECORDED_LIVE_SIGNING_KEY = "<inject outside source and logs>"
npm run dev:competition
```

The service is read-only. If the artifact is absent, oversized, malformed,
digest-mismatched, unsigned, authenticated by the wrong key,
credential-bearing, or missing exact provider bindings, the request fails
closed. The current PR #1 boundary artifact alone is not a substitute for a
complete all-provider replay package.

## Optional full live rehearsal

Use this path only with authorized accounts, sufficient quota, and a disposable
public demo PR. Do not begin it on stage for the first time.

1. Run each bounded preflight separately:

   ```powershell
   npm run smoke:external -- --provider=fireworks
   npm run smoke:external -- --provider=daytona
   npm run smoke:external -- --provider=braintrust
   npm run smoke:external -- --provider=github
   npm run smoke:external -- --provider=coderabbit
   ```

2. Confirm every intended stage has `LIVE` provenance and exact provider
   references. A blocked stage is not success.
3. Confirm Daytona sandbox cleanup and the exact GitHub base/head before
   authorizing publication.
4. Start the interactive workflow only from an operator-controlled TTY:

   ```powershell
   npm run demo:live -- --approver demo-operator
   ```

5. Read the selected diff and type the exact evidence-bound approval phrase
   only if the current evidence is acceptable.
6. Stop before any claim of full certification unless the complete evidence
   package has been verified.

SafeFlash never merges. Do not perform a merge as part of the demo.

## Ninety-second fallback

If localhost, the toolchain, or the network fails:

1. Say, “I am switching to the deterministic fallback; this is `MOCK`, not a
   provider run.”
2. Open the last committed production screenshot and its verification package
   from the evidence ledger.
3. Show the unsafe incident, three candidate outcomes, selected evidence
   binding, and approval gate.
4. Open PR #1 separately and say, “This is a real prior external CodeRabbit
   review boundary. It is not a fresh full workflow or the formal all-provider
   `RECORDED_LIVE` artifact.”
5. Finish with the hard-gate and no-auto-merge guarantees.

See [failure-recovery.md](failure-recovery.md) for stage-specific recovery.

## Claims the operator may and may not make

Safe:

- “The local demo compiles and tests a real native C fixture.”
- “The provider adapters and fail-closed transitions are contract-tested.”
- “PR #1 received a real CodeRabbit changes-requested and approved repair
  cycle.”
- “The recorded-live mechanism is ready, but
  `RECORDED_LIVE_PROVENANCE=NOT_AVAILABLE` until a complete live artifact is
  captured.”
- “The complete path is not yet live certified.”

Unsafe until new evidence exists:

- “These local candidate IDs are Daytona sandbox IDs.”
- “This mock score was written by Braintrust.”
- “The full workflow just ran live.”
- “SafeFlash deployed or merged the firmware.”
- “The battery fixture is a real connected board.”

## After the demo

- Preserve failed and successful evidence; do not rewrite JSON by hand.
- Confirm no unintended Daytona sandbox or GitHub branch remains.
- Revoke temporary tokens and remove them from the process environment.
- Record which segments were `LIVE`, `RECORDED_LIVE`, and `MOCK`; if no valid
  recorded artifact was loaded, record `RECORDED_LIVE_PROVENANCE=NOT_AVAILABLE`.
- If source changed, invalidate old approval and rerun the appropriate
  verification before the next presentation.
