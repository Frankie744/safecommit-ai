# SafeFlash competition readiness audit

Audit snapshot: 2026-07-22, America/Los_Angeles.

This is a claim-boundary and operator-readiness audit. It does not replace a
fresh verification run on the final clean commit.

## Executive result

| Presentation path | Status | Decision |
|---|---|---|
| Deterministic local product demo | Implemented; final clean-commit verification and rehearsal still required after hardening | **Conditional GO** |
| Real CodeRabbit PR #1 segment | Real public review exists; it is a prior external boundary, not a full replay artifact | **GO with explicit boundary wording** |
| Complete live sponsor path | No single jointly verified uninterrupted evidence package | **NO-GO / `LIVE_CERTIFIED=NO`** |
| Real hardware/HIL claim | Native C software fixture only | **NO-GO for hardware-validated wording** |

The recommended competition presentation is the deterministic console plus a
separately explained real prior CodeRabbit boundary on
[PR #1](https://github.com/Frankie744/safeflash-ai/pull/1).

## Current claim boundary

### Verified or directly demonstrable

- The public repository is
  [`Frankie744/safeflash-ai`](https://github.com/Frankie744/safeflash-ai).
- A native C battery-controller fixture compiles and exposes unsafe behavior
  through executable tests.
- The local Parallel Safety Tournament preserves distinct candidates, hard-gate
  rejection, deterministic selection, evidence binding, and human approval.
- Provider adapters and fail-closed orchestration boundaries have local
  contract and adversarial coverage.
- GitHub/CodeRabbit [PR #1](https://github.com/Frankie744/safeflash-ai/pull/1)
  completed a real changes-requested → repair → approved exact-head cycle.
- SafeFlash has no merge operation.
- Phase 7A public-repository readiness evidence is committed at
  [`phase7a-readiness-20260723T043444961Z`](../artifacts/evidence/phase-7/phase7a-readiness-20260723T043444961Z/summary.json).

### Not yet permitted as an aggregate claim

- one complete live Fireworks → Daytona → Braintrust → approval → GitHub →
  CodeRabbit run;
- a repeatable full-path live rehearsal within the presentation budget;
- a complete all-provider artifact eligible for the recorded-live replay mode;
- authenticated operator identity beyond an access-controlled audit label;
- hardware-in-the-loop or production-board validation;
- provider-signed or public-key provenance beyond SafeFlash's server-side HMAC
  capture attestation;
- Policy Composer as an implemented policy conversion or activation feature.

## Evidence-label audit

| Requirement | Status | Required action |
|---|---|---|
| `LIVE` means current external calls | Defined | Keep exact provider references and current capture time visible. |
| `RECORDED_LIVE` means immutable prior live evidence | Authority-gated, HMAC-attested capture and read-only loader implemented; `RECORDED_LIVE_PROVENANCE=NOT_AVAILABLE` until a complete real artifact exists | `demo:live` may capture only after a complete in-memory READY run; `cached` requires the artifact path and server signing key, validates both digest and attestation, and never falls back to mock. |
| `MOCK` means local fixture/contract behavior | Implemented default | Keep `MOCK • NOT PROVIDER-VERIFIED` visible in the console. |
| No silent live fallback | Fail-closed contract exists | Recheck during the final integration suite. |
| Aggregate live certification | Not satisfied | Keep `LIVE_CERTIFIED=NO`. |

## Competition artifact audit

| Artifact | Readiness | Notes |
|---|---|---|
| README first two screens | Drafted in the competition-hardening branch | Includes value, GIF placeholder, architecture, sponsor map, guarantees, one-command demo, provenance, and HackSprint attribution. |
| Three-minute script | Drafted | Separates mock UI, the real prior PR #1 boundary, and unavailable formal recorded-live provenance. |
| Operator runbook | Drafted | Separates deterministic, optional live, and fallback paths. |
| Judge Q&A | Drafted | Covers product, sponsors, safety, evidence, hardware, and remaining gaps. |
| Failure recovery | Drafted | Preserves evidence and forbids unsafe retry shortcuts. |
| Hardware demo explanation | Drafted | Calls the target a native C fixture, not a connected device. |
| Policy Composer | Reservation only | Server-only flag, empty state, strict fixture, proposed interfaces, and exit criteria; no conversion. |
| Final GIF | Missing placeholder replacement | Capture only after UI and script freeze; do not add a broken asset link. |
| CodeRabbit live evidence | Public PR exists; local evidence package requires durable promotion | Redact and verify before committing or attaching to a release without changing the reviewed PR head. |
| Recorded-live replay service | Implemented read-only HMAC-attested contract; no complete all-provider artifact yet | Invalid, missing, wrong-key, and fixture artifacts fail closed; a real all-provider artifact is still required. |
| Final source-bound acceptance evidence | Must be refreshed after all hardening changes | Run only on a clean committed revision. |

## Sponsor-readiness audit

### Fireworks AI

Implemented:

- official-endpoint guard;
- structured CandidatePatch output and local schema validation;
- strategy diversity and duplicate-patch rejection;
- immutable source/policy context;
- bounded malformed-output repair;
- telemetry fields carried into evidence.

Before a full live claim:

- confirm the authorized model supports the required structured output;
- run bounded external smoke with current credentials/quota;
- capture current request/model/token references;
- exercise provider timeout, rate-limit, and transient-network recovery in the
  final rehearsal.

### Daytona

Implemented:

- exact commit clone;
- network block before untrusted patch;
- frozen server-owned command sequence;
- patch-integrity checks before sandbox creation;
- structured command/artifact receipts;
- fresh attempt identities and cleanup tracking.

Before a full live claim:

- confirm account quota and cold-start behavior;
- retain three current unique sandbox receipts for the selected tournament;
- prove cleanup status for every successful, failed, and discarded attempt;
- rehearse an interrupted attempt without identifier reuse.

### Braintrust

Implemented:

- stable Firmware Safety Incidents Dataset contract;
- raw-evidence-derived custom scorers;
- hard gates before ranking;
- server-side score/eligibility recomputation;
- Trace and Experiment adapter contracts;
- strict Dataset, row, Trace/Span, Experiment, Project, and Eval-result ID/URL
  validation;
- classified 401/403/422/429/timeout and malformed-response tests.

Braintrust does not expose a separate immutable provider ID for each named
score. SafeFlash therefore records the provider-owned Eval root/result row ID
from the scorer trace and binds the complete named-score set to that row. A
local evidence digest is never presented as a Braintrust resource ID.

Before a full live claim:

- write and capture the current Dataset, Trace, and Experiment;
- confirm returned rows match local recomputation;
- preserve exact project and experiment references;
- rehearse partial-write and provider-unavailable behavior.

### CopilotKit

Implemented:

- shared session state in the evidence console;
- visible candidate/timeline/provenance state;
- evidence-bound human decision;
- server-side validation independent of client display.

Boundary:

- the approver name is an audit label, not strong authentication;
- the Copilot chat model route must not be presented as live if its server model
  runtime is unavailable.

### GitHub and CodeRabbit

Implemented and externally demonstrated at the boundary:

- public repository and real PR;
- approval-gated GitHub publication contract;
- exact base/head checks and one-use publish authorization;
- official CodeRabbit identity filtering;
- stale evidence rejection;
- blocking review → repair → repaired-head approval on PR #1.

Before aggregate certification:

- include this stage in the same end-to-end live evidence package as Fireworks,
  Daytona, and Braintrust;
- verify the current base and head immediately before and after publication;
- preserve the exact review IDs and cleanup status;
- do not merge.

## Safety-contract audit

| Contract | Competition status |
|---|---|
| Failed hard gate cannot be compensated by score | Implemented; rerun final acceptance evidence |
| Tests, CI, policy, and thresholds are protected | Implemented; rerun adversarial suite |
| Model output cannot authorize host commands | Live authority is server-owned frozen commands |
| Every validation attempt has a unique identity | Implemented contract; include current receipts in live evidence |
| Approval is exact-evidence-bound | Implemented |
| Patch/evidence change invalidates approval | Implemented |
| Exact PR head/base required | Implemented |
| CodeRabbit blocker re-enters full validation | Implemented contract and real boundary demonstration |
| No automatic merge | Implemented architectural boundary |
| Secrets absent from client/Git/evidence | Automated checks exist; rerun against final bundle and history |

## Hardware-readiness audit

Current status:

- real compiled native C;
- deterministic controller and safety tests;
- software-modeled sensor, charging state, stale counter, and fault latch;
- optional strict HTTP/serial-frame telemetry adapter for the two display
  fields, with a five-second freshness window;
- automatic `SIMULATED DEVICE` fallback that does not block the workflow;
- no physical device.

The telemetry adapter is presentation data only. It does not authenticate a
board, feed approval evidence, or upgrade the result to hardware-in-the-loop.

Required wording:

> SafeFlash validates a hardware-risk firmware fixture. Hardware-in-the-loop is
> the next evidence adapter, not a completed capability.

See [hardware-demo.md](hardware-demo.md) for the exact proof boundary and HIL
plan.

## Remaining risks ranked for competition

### P0 — blocks a full live claim

1. External Fireworks, Daytona, and Braintrust evidence is not yet captured
   together with GitHub/CodeRabbit in one uninterrupted run.
2. Final source-bound verification must be recaptured after competition
   hardening is frozen.
3. The CodeRabbit live evidence package must be durably promoted after
   redaction and manifest verification; a local exclusion is not a public
   evidence strategy.
4. The full path needs repeated timed rehearsals with provider references,
   cleanup, and recovery recorded.

### P0 — blocks a reliable stage demo

1. Final GIF/screenshot and projector framing are not frozen.
2. The operator must rehearse the exact handoff from `MOCK` UI to the separate
   real prior PR #1 boundary without calling it a formal recorded-live replay.
3. Network and toolchain fallback artifacts must be openable without private
   credentials.
4. Day-of checks must run before server credential injection.

### P1 — valuable after the core is stable

- repeated real-provider latency and quota fault drills;
- CI dependency/security gate and SBOM;
- authenticated operator identity;
- hardware-in-the-loop adapter and target cross-compile;
- KMS/public-key capture attestation and provider-signed receipts.

### Design only

- Policy Composer conversion. The reserved flag and empty state must not be
  expanded into a runtime-conversion claim until the draft-only contract,
  fixtures, and activation separation have independent evidence.

## Final verification sequence

Run this sequence only after all intended source and documentation changes are
complete:

1. Review `git diff` and confirm no secrets or unrelated user changes.
2. Commit the intended hardening revision through the normal project process.
3. Confirm `git status --short` is empty.
4. Run:

   ```powershell
   npm run verify
    git diff --check
   ```

5. Run `npm run verify:p0` on the clean commit.
6. Inspect the summary’s source commit, command results, P0 matrix, secret scan,
   and SHA-256 manifest.
7. Run the no-quota rehearsal and Phase 8 evidence capture:

   ```powershell
   npm run rehearsal
   npm run verify:phase8
   npm run evidence:verify -- artifacts/evidence/phase-8/<run-id>
   ```

8. With no repository-root credential file, run:

   ```powershell
   npm run day-of:check
   npm run prepare:demo-pr -- --dry-run
   ```

9. Inject authorized live credentials only into the server environment.
10. Run bounded provider smokes individually.
11. Complete repeated timed rehearsals. Record mode labels, provider references,
    duration, cleanup, exact PR head/base, review outcome, and fallback result.

Do not replace a failed result by editing an artifact.

## Go/no-go gates

### Deterministic competition demo: GO only if

- final verification passes on the intended committed revision;
- the console starts with one command after installation;
- the mock provenance badge is visible;
- the unsafe incident, candidate rejections, selected evidence, and approval
  fit the rehearsed viewport;
- the operator can finish using only the deterministic path;
- the fallback screenshot/evidence opens without network.

### Real prior CodeRabbit segment: GO only if

- PR #1 remains publicly readable or an immutable captured artifact is ready;
- the operator says it is a real prior external boundary;
- the reviewed head and repair sequence are identifiable;
- the segment is not described as a fresh full live workflow or the complete
  `RECORDED_LIVE` artifact.

### Full live product claim: GO only if

- every named provider stage is live in the same run;
- exact provider references and cleanup are captured;
- human approval binds the current live receipt;
- GitHub and CodeRabbit base/head checks remain exact;
- the repair round re-enters fresh Daytona and Braintrust validation;
- the complete evidence package and manifest are independently verified;
- repeated rehearsals finish inside the presentation budget.

Until every full-live gate is satisfied:

```text
LIVE_CERTIFIED=NO
```
