# SafeFlash judge questions

Lead with the direct answer. Expand only if the judge asks for implementation
detail.

## Product and differentiation

### Is this just another AI code-fixing agent?

No. The model proposes candidates, but it does not decide which code is safe.
SafeFlash makes multiple repairs compete on compiled evidence, applies
non-compensable physical-safety gates, preserves failed candidates, binds a
human decision to exact evidence, and adds an independent exact-revision review.
The product is the evidence and control plane around code generation.

### What did you build during the HackSprint?

Pre-event answer: the selected day-of feature is **Cross-Device Assurance
Profiles**, but it is not yet implemented and must not be claimed.

After day-of evidence exists, answer: we made the safety gate profile-driven
and added a second executable simulated device class. A Battery sensor
disconnect and a Motor non-finite torque command use different physical
invariants but the same non-compensable hard gates, evidence binding, and
no-auto-merge boundary.

### What is the Policy Composer?

It is a disabled roadmap surface, not the selected competition feature and not
an implemented safety-critical converter. SafeFlash continues to use
repository-owned, engineer-reviewed policies. See
[hacksprint-new-feature-plan.md](hacksprint-new-feature-plan.md).

### Why is this valuable beyond a battery demo?

The reusable idea is the gate, not the specific sensor. Medical devices,
robots, vehicles, and industrial controllers all have invariants that an
average model score must never override: actuator-safe states, timing limits,
plausibility ranges, watchdog behavior, and mandatory fault latching.

## Sponsor integrations

### Why Fireworks instead of one deterministic patch?

Safety review benefits from strategy diversity. Fireworks produces
schema-constrained candidates from the same immutable incident, policy, source
context, and seed contract. SafeFlash rejects duplicate patches or identity
drift; a different label alone does not count as a different strategy.

### Why Daytona?

Daytona is not application hosting. It is the isolation boundary for executing
untrusted generated firmware. SafeFlash uses a fresh sandbox identity, clones an
exact commit, blocks network access before applying the patch, runs a frozen
server-owned command sequence, captures structured evidence, and cleans up.

### Why Braintrust if you already have tests?

Tests answer individual assertions. Braintrust makes the evaluation repeatable
and comparable across candidates through a stable incident Dataset, Trace,
Experiment, and custom scorers. SafeFlash recomputes hard-gate eligibility
server-side, so a reported score cannot override failed raw evidence. Each
candidate preserves the provider-owned Eval root/result row ID returned by the
scorer trace; the local evidence digest is not used as a Braintrust ID.

### What does CopilotKit do?

CopilotKit connects the visible agent console to shared workflow state and the
human-in-the-loop decision. It does not grant deployment power. The server still
validates the current candidate, evidence digest, patch digest, policy, and
source commit before accepting approval.

### Why CodeRabbit after all those gates?

The generating and selecting system should not be its only reviewer. CodeRabbit
is a separate organizational boundary operating on the public PR. SafeFlash
accepts only official exact-head evidence, rejects stale comments and race
conditions, and sends a blocking finding back through fresh validation.

### Did CodeRabbit really review this project?

Yes. [PR #1](https://github.com/Frankie744/safeflash-ai/pull/1) received a real
changes-requested review, a repair, and approval on the repaired exact head.
It proves the GitHub/CodeRabbit boundary, not the complete
Fireworks-to-CodeRabbit path. It is also not, by itself, the complete
five-provider artifact required by the recorded-live replay service.

## Evidence and honesty

### Is the demo live?

Read the badge:

- `LIVE` means the named provider was called during the current run.
- `RECORDED_LIVE` means immutable evidence from an earlier real provider run.
- `MOCK` means deterministic local fixture or contract evidence.

There is no silent fallback between them.

The immutable read-only replay mechanism is implemented, but no complete real
artifact is available yet:

```text
RECORDED_LIVE_PROVENANCE=NOT_AVAILABLE
```

### Is the complete product live certified?

No. `LIVE_CERTIFIED=NO` remains the correct aggregate status until one
uninterrupted Fireworks → Daytona → Braintrust → approval → GitHub publication
→ CodeRabbit repair/revalidation run is captured and verified as one evidence
package.

### Can someone edit the evidence JSON to fake a pass?

Evidence objects bind source, patch, policy, execution, and provider references
with canonical digests; event replay and manifests expose mutation. Approval and
review gates re-derive critical decisions from raw receipts instead of trusting
a caller-supplied boolean. Recorded-live artifacts additionally carry an
HMAC-SHA-256 attestation that can be verified only with the server-side capture
key, so a fixture or edited file cannot enter replay merely by recomputing a
digest. This is symmetric server attestation, not public-key nonrepudiation or a
provider-signed receipt.

### Why should I trust the scorer?

You should not trust a single scalar. SafeFlash derives scorer inputs from
build, unit, safety, integrity, and provider receipts. Critical failures are
hard gates before ranking, and server-side recomputation rejects mismatched
Braintrust rows or a caller-provided eligibility flag.

### What happens when a provider is unavailable?

The affected stage stops with a redacted, classified error. A bounded retry is
allowed only for retryable failures. SafeFlash does not silently substitute
mock output under a live label. The operator may explicitly switch the
presentation to `MOCK`. `RECORDED_LIVE` is allowed only when a complete
validated artifact exists.

## Safety and security

### Can generated code modify the tests or safety thresholds?

No accepted patch may modify existing tests, CI, build policy, scorer code,
safety rules, or thresholds. Path, mode, binary, size, and malicious-shell
checks run before sandbox execution and again around the exact candidate tree.

### Can the model execute arbitrary shell commands?

Model-authored commands are not the live execution authority. The Daytona path
uses a frozen server-owned command list and validates its exact structure.
Network is blocked before the patch is applied. The local fallback likewise
uses repository-owned build and test commands.

### Can a failed sandbox be reused?

No. Validation evidence records every reserved attempt identity. Discarded,
failed, and repair-retry sandboxes cannot later satisfy the selected candidate’s
approval receipt.

### What prevents stale approval?

Approval binds the candidate ID, patch digest, evidence digest, policy version,
source commit, operator label, and time. A repair, rebase, policy change, or
evidence change produces a different binding and requires a new decision.

### Can SafeFlash merge or deploy?

No. It can create or update an approved PR through a one-use server
authorization. It has no merge operation and makes no firmware-deployment call.
`READY_TO_MERGE` means the gates permit a human-controlled next step.

### How are secrets protected?

Provider credentials remain server-side, are removed from local validation
children, are redacted from errors and evidence, and are scanned out of the
frontend bundle and Git-tracked content. No secret may use a `NEXT_PUBLIC_`
variable. The demo must still be access-controlled because the approver label is
an audit label, not full operator authentication.

## Hardware boundary

### Is this connected to a real battery?

No. The current demonstration uses a real compiled C battery-controller fixture
with deterministic native tests. It models a sensor disconnect, stale samples,
temperature range faults, charging state, and fault latching. It is not a board,
ADC, charger FET, RTOS, or hardware-in-the-loop setup.

### What does the fixture prove?

It proves that unsafe firmware can compile, that executable safety tests expose
physical-risk logic, and that candidate selection can be driven by those
results. It does not prove electrical timing, peripheral behavior, target
resource usage, or certification on a production board.

### How would you move this to hardware?

Add a board-specific HAL, cross-compiler and target build, signed firmware
artifact identity, hardware-in-the-loop sensor and actuator instrumentation,
timing/resource gates, and a deployment authorization outside SafeFlash. The
same evidence schema can then bind the HIL receipts.

## Operations

### What is your fallback if the network fails on stage?

Announce the switch to `MOCK`, run the deterministic console, and show PR #1 as
separate real prior CodeRabbit boundary evidence. Do not label it as the formal
all-provider `RECORDED_LIVE` replay or a fresh live call. The full sequence is in
[failure-recovery.md](failure-recovery.md).

### What is the biggest remaining risk?

The full sponsor chain still needs a repeatable, timed, uninterrupted live
rehearsal with one jointly verified evidence package. Hardware-in-the-loop and
authenticated operator identity are also future production requirements.
