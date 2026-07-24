# SafeFlash demo runbook

> This legacy P0 runbook is superseded for competition use by
> [`docs/demo-runbook.md`](docs/demo-runbook.md). The competition command and
> rehearsed port are `npm run dev:competition` and `127.0.0.1:3018`.

## Demo status

The reliable demo today is a **real local CMake/CTest tournament** presented in
an explicitly labelled `MOCK • NOT PROVIDER-VERIFIED` console. Fireworks,
Daytona, Braintrust, GitHub, and CodeRabbit live execution is not yet verified.
The script below never implies otherwise.

Target runtime: 2:40–2:55, leaving a few seconds for transition.

## Before entering the room

1. Work from a clean committed revision:

   ```powershell
   git status --short
   git rev-parse HEAD
   npm run verify:p0
   ```

   `verify:p0` itself requires a clean tree and captures typecheck, full
   Vitest, production build, Chrome Playwright, and the exact 14-test P0 matrix
   under `artifacts/evidence/phase-6/`.

2. Preserve any previous local web sessions and start with an empty session
   list:

   ```powershell
   $safeFlashSessionDir = Resolve-Path .safeflash -ErrorAction SilentlyContinue
   if ($null -ne $safeFlashSessionDir) {
     $source = Join-Path $safeFlashSessionDir.Path "web-sessions"
     if (Test-Path -LiteralPath $source) {
       $backup = Join-Path $safeFlashSessionDir.Path ("web-sessions.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
       Move-Item -LiteralPath $source -Destination $backup
     }
   }
   ```

   This moves generated session data to a timestamped backup; it does not
   delete evidence.

3. Build and start the production server:

   ```powershell
   npm run build
   npm run start --workspace @safeflash/web -- --hostname 127.0.0.1 --port 3018
   ```

4. Open `http://127.0.0.1:3018` in Chrome at 1440×900. Confirm:

   - the empty-state page is visible;
   - the mode badge will be `MOCK • NOT PROVIDER-VERIFIED`;
   - no private tabs or notifications are visible;
   - browser zoom keeps all three candidate cards and the approval gate legible;
   - the committed fallback screenshot and Phase 4 verification JSON are open
     locally in a separate window, not a public provider tab.

5. Do not use the unconfigured Copilot chat endpoint. CopilotKit state and HITL
   registration are present, but its server model runtime honestly returns 503.

## Three-minute operator and pitch script

### 0:00–0:20 — Hook: compilation is not safety

**Screen:** empty SafeFlash console, Battery Sensor Disconnect incident.

**Say:**

> AI coding agents are moving from websites into devices. But when software
> controls a battery, a patch that compiles can still be physically unsafe.
> Here, disconnecting the temperature sensor produces zero degrees—and the
> baseline firmware keeps charging.

**Point to:** red incident state: sensor fault true, charging on.

Evidence behind the statement: the native baseline builds, passes all five
unit assertions, and fails the disconnect, stale-sample, and latch safety
assertions.

### 0:20–0:35 — Product

**Say:**

> SafeFlash is the safety gate for AI-generated firmware. It does not trust one
> patch or one model answer. It demands executable evidence and keeps deployment
> behind a human boundary.

**Point to:** the safety-policy invariants and the provenance badge.

### 0:35–0:45 — Start the tournament

**Action:** click **Run Safety Tournament** once.

**Say while the server runs:**

> This checkpoint is deliberately labelled local-test, not Daytona. The
> candidates are now running real MSVC, CMake, and CTest commands in three
> unique filesystem copies. Our Daytona adapter implements the remote version,
> but we will not claim a live sandbox without its ID.

Do not double-click. A run typically takes about 20 seconds on the verified
machine.

### 0:45–1:35 — The evidence tournament

**Screen:** all three candidate cards are visible.

**Say:**

> Candidate A clamps the range. It builds and passes all five unit assertions,
> but it fails all six safety assertions. Candidate B tries another latch path
> and does not compile. Candidate C fails closed, preserves the latch, and
> passes the build, five unit assertions, and all six safety assertions.

**Point to in order:** A's safety failure, B's build failure, C's selected
badge.

**Then say:**

> Here is the important part: A scores 0.897—higher than C's 0.890. A still
> loses. Build, physical safety, patch integrity, and a 95 percent unit rate are
> hard gates. No average can compensate for a dangerous patch.

**Open briefly:** Candidate C diff/evidence, then close it before the next step.

### 1:35–2:05 — Evidence-bound human control

**Point to:** approval summary, selected patch/evidence/commit identifiers, and
the button **Approve evidence (no live PR)**.

**Say:**

> The decision is bound to this candidate, patch digest, evidence digest,
> safety policy, and source commit. Change any of them and the approval becomes
> stale. The browser cannot create a pull request on its own.

**Action:** click **Approve evidence (no live PR)**.

**Say:**

> Because this is local-test evidence, the backend records approval but stops
> here. It does not manufacture a GitHub PR or sponsor result.

**Point to:** disabled approval control and “live publish remains blocked.”

### 2:05–2:32 — Independent review design, without a fake review

**Say:**

> The live design has a second independent gate. Our GitHub adapter requires
> the remote branch head to match the approved commit. The CodeRabbit adapter
> accepts only official bot or app evidence for that exact PR head. A Critical
> or High finding sends the candidate back through the complete Daytona and
> Braintrust validation path; SafeFlash never exposes an auto-merge action.

**Do not say:** “CodeRabbit found,” “CodeRabbit passed,” “Daytona ran,” or
“Braintrust scored” unless new live evidence with exact IDs has been captured.

### 2:32–2:55 — Impact and close

**Say:**

> Today we protected a battery controller with real executable evidence. The
> same gate can protect medical devices, robots, vehicles, and industrial
> systems. SafeFlash lets AI move toward the physical world without asking us
> to blindly trust it.

**Leave on screen:** three candidates, two rejected with reasons, Candidate C
selected, local approval recorded, live publishing blocked.

This ending is more credible than a fabricated `READY_TO_MERGE` screen.

## 90-second offline fallback

Use this if the app or toolchain cannot run. It needs no network.

### 0:00–0:15

Open
`artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/console-1440x900.png`.

Say:

> This is our committed production-console capture, explicitly labelled local
> test—not a prerecorded provider success.

### 0:15–0:50

Point to the three candidates:

- A: build pass, 5/5 unit, 0/6 safety, 0.897, rejected.
- B: build fail, rejected.
- C: build pass, 5/5 unit, 6/6 safety, 0.890, selected.

Say:

> A proves why safety must be a hard gate: it has the higher average and still
> cannot win.

### 0:50–1:10

Open
`artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/verification.json`.

Point to the three unique sandbox IDs, evidence and approval digests, 27-event
replay, 28-event UI, zero console errors/warnings, and `pullRequestCreated:
false`.

### 1:10–1:30

Open `replay.txt` and `manifest.sha256`.

Say:

> The tournament event chain independently replays to Candidate C and every
> committed artifact is hashed. This is local evidence; provider-live remains
> the next closure step.

## Live-mode promotion gate

The UI and production composition now implement the full live-provider control
path and are locally contract-tested, but the committed demo evidence is still
`local-test`. Do not choose a “Live” story merely because the code exists or
individual smoke checks pass. Promote the demo only after:

1. all five `npm run smoke:external -- --provider=...` commands return live,
   verified evidence;
2. the implemented server composition completes Fireworks generation, three
   Daytona validations, Braintrust evaluation, approval-gated GitHub PR
   creation, and exact-head CodeRabbit inspection in one real run;
3. the UI displays the real request/sandbox/trace/experiment/PR/review IDs;
4. a blocking CodeRabbit round causes a repair and full revalidation;
5. the resulting run is captured, redacted, hashed, and replayable;
6. three consecutive rehearsals complete within the presentation budget.

Until then, the local script above is the approved demo.

## Judge questions

### “Why not just ask a bigger model?”

The model proposes candidates; it does not decide physical truth. Native tests,
patch integrity, hard gates, exact evidence binding, human approval, and an
independent reviewer constrain every model.

### “Is this really Daytona?”

The shown run is not. It is real local CMake/CTest in unique filesystem copies,
labelled `local-test`. The Daytona official-SDK adapter and its security policy
are implemented and contract-tested, but credentials are required for live
sandbox evidence.

### “Is that a real Braintrust score?”

The shown number is the deterministic local evaluation score. The repository
contains ten dataset cases, eight scorers, and Braintrust Dataset/Trace/
Experiment ports, but no live Braintrust IDs are claimed.

### “Did CodeRabbit review this?”

Not in the committed run. The exact-head review gate, severity mapping, stale
evidence rejection, and revalidation state transitions are tested. A real App
installation and PR are still required.

### “Can the agent merge?”

No. The GitHub boundary only creates or finds an open PR after current
approval. SafeFlash has no merge API, and readiness still depends on the
independent review gate.

### “Can a candidate edit the tests?”

No. Patch integrity rejects test, CI, build-script, safety-policy, threshold,
binary, symlink, delete, rename, traversal, shell, and network-download changes
before execution.
