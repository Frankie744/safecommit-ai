# SafeFlash three-minute pitch

Use this script with the [competition demo runbook](demo-runbook.md). Bracketed
text is an operator cue, not spoken narration.

## 0:00–0:20 — Compilation is not safety

[Show the disconnected battery-sensor incident.]

> This controller still compiles. That is exactly the problem. When its
> temperature sensor disconnects, missing evidence can look like a plausible
> reading while charging stays enabled. In firmware, a patch can be syntactically
> correct, highly rated by a model, and still damage a physical device.

## 0:20–0:40 — The product

[Point to the SafeFlash title, provenance label, and policy invariants. Click
**Run Safety Tournament**.]

> SafeFlash is the safety gate for AI-generated firmware. It does not trust one
> patch or one model answer. It makes several repair strategies compete on
> executable evidence, rejects anything that violates a non-negotiable physical
> safety rule, and requires a human to approve the exact evidence before a pull
> request can be published.

Pre-event operator note: Cross-Device Assurance Profiles are existing core
work. Do not describe them as built during this HackSprint.

Only after the post-start Judge Challenge Mode commit and evidence exist, say:

> During this HackSprint we added Judge Challenge Mode. You can choose the
> Battery or Motor fault, and the same evidence-first gate proves why the
> highest-scoring unsafe patch still cannot ship.

## 0:40–1:25 — The tournament

[Keep all candidate cards visible. Open a rejected candidate, then the selected
candidate.]

> Fireworks generates schema-constrained strategies from the incident, source,
> and immutable safety policy. Each candidate gets a fresh Daytona isolation
> boundary at an exact commit. Network access is blocked before untrusted code is
> applied, and only server-owned build and test commands can run.

> Braintrust turns every result into a repeatable evaluation: Dataset cases,
> traceable execution, an Experiment, and custom scorers. But the score is not
> sovereign. Build, integrity, and physical-safety checks are hard gates. A
> dangerous patch cannot buy its way through with a high average.

> The failed candidates stay visible. Evidence, not confidence, explains why
> one repair survives.

When the screen is the deterministic fallback, add:

> This screen is labelled `MOCK`. It runs the real native C fixture and local
> safety workflow, but I am not presenting these IDs as live sponsor evidence.

## 1:25–1:55 — Human control

[Show the selected diff and the approval binding. Record the local approval.]

> CopilotKit keeps the workflow and the operator on the same state. Approval is
> bound to this candidate, patch digest, evidence digest, policy version, and
> source commit. Change any of them and the approval is invalid.

> SafeFlash can create or update a pull request only after that current
> approval. It has no merge operation.

## 1:55–2:30 — Independent review

Operator cue: open
[public PR #1](https://github.com/Frankie744/safeflash-ai/pull/1).

> CodeRabbit is a genuinely independent second reviewer. On this real public
> pull request, the first exact-head review requested changes. The repair was
> validated, the pull request head changed, stale evidence was rejected, and
> CodeRabbit approved the repaired head.

> This public PR is real prior external CodeRabbit evidence. It is not the
> current mock run and, by itself, is not the complete five-provider artifact
> required for formal `RECORDED_LIVE` replay. That provenance is currently not
> available. The complete product remains `LIVE_CERTIFIED=NO` until Fireworks,
> Daytona, Braintrust, GitHub publication, and CodeRabbit complete one
> uninterrupted, jointly captured run.

## 2:30–3:00 — Close

[Return to the SafeFlash final state.]

> Remove Daytona and the agent executes untrusted firmware without a strong
> isolation boundary. Remove Braintrust and “safe” becomes an opinion instead
> of a repeatable experiment. Remove CodeRabbit and the selecting agent reviews
> itself. Fireworks provides diverse strategies; CopilotKit keeps the human
> decision explicit.

> Today these are executable simulated Battery and Motor controllers, not
> connected boards. The same evidence-first gate can protect medical devices,
> robots, vehicles, and industrial controls before code reaches hardware.
> SafeFlash lets AI move toward the physical world without asking us to trust
> it blindly.

## If interrupted

Use these one-sentence answers, then return to the current screen:

- **What is new?** Before day-of verification, do not claim the reserved
  feature. After verification: “Judge Challenge Mode lets a judge choose a
  Battery or Motor fault and receive a bound explanation of the hard-gate
  decision.”
- **Is this live?** “The current badge is authoritative: `MOCK` is local,
  `RECORDED_LIVE` is prior real evidence, and `LIVE` means a provider call in
  this run. The recorded-live mechanism exists, but no complete artifact is
  currently available.”
- **Did CodeRabbit really review it?** “Yes, PR #1 has a real two-round review;
  that proves the CodeRabbit boundary, not full-path live certification.”
- **Is that real hardware?** “It is real compiled C and native tests, but the
  device is a deterministic software fixture; HIL is future work.”
- **Can it merge?** “No. SafeFlash deliberately has no merge operation.”
