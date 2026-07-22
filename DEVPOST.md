# SafeFlash

**Tagline:** The safety gate for AI-generated firmware.

**Submission status:** Draft grounded in the committed local evidence. Replace
the external-integration blockers only after fresh live IDs/URLs are captured.
Do not submit placeholders as results.

## Short description

SafeFlash makes multiple firmware repairs compete on executable safety
evidence before any code can approach real hardware. It rejects candidates
that fail physical invariants—even when they have the highest average
score—and binds the winning patch to human approval and an independent review
gate.

## Inspiration

AI coding agents are rapidly moving beyond websites into batteries, robots,
vehicles, industrial controls, and medical devices. In those systems,
“compiles successfully” is not the same as “safe.”

Our demo begins with a deceptively small defect. A disconnected temperature
sensor reports `0°C`; the battery controller interprets that as a valid cold
reading and keeps charging. The baseline compiles and passes its normal unit
suite. Only physical-safety tests reveal that disconnect handling, stale data,
and fault latching are broken.

That led to one question: instead of trusting the first AI patch, how can we
make generated firmware earn the right to proceed?

## What it does

SafeFlash turns firmware repair into a safety tournament:

1. It represents the incident and non-negotiable safety policy as structured
   data.
2. It produces three distinct candidate repair strategies.
3. It validates patch structure and rejects attempts to change tests, CI,
   build scripts, safety policies, thresholds, or paths outside the firmware
   source allowlist.
4. It executes every candidate separately and captures build, test, duration,
   command, commit, sandbox, and artifact evidence.
5. It applies deterministic scorers and hard gates. Build success, safety
   invariants, patch integrity, and a 95% unit pass rate cannot be offset by a
   high average score.
6. It displays the incident, three candidates, diffs, failures, scores,
   provenance, and timeline in one console.
7. It requires a human decision bound to the exact candidate, patch digest,
   evidence digest, policy version, and source commit.
8. Its live architecture creates an open GitHub PR only after approval and
   treats CodeRabbit as an exact-revision independent gate. A blocker must send
   the patch through full validation again. SafeFlash never merges.

## The result that explains SafeFlash

Our committed local tournament ran real MSVC/CMake/CTest work in three unique
filesystem copies:

| Candidate | Real outcome | Local weighted score | Decision |
|---|---|---:|---|
| A — range validation | build pass, 5/5 unit, 0/6 safety | 0.897 | rejected by hard safety gate |
| B — retry/latch attempt | build failure; tests not run | 0.3465 | rejected by build/unit/safety gates |
| C — fail closed + latch | build pass, 5/5 unit, 6/6 safety | 0.890 | selected |

Candidate A has the highest weighted score and still cannot win. That is the
product in one moment: evidence outranks confidence.

## How we built it

### Evidence-first control plane

The project is an npm workspace with a Next.js 16/React 19 console and a
TypeScript domain/orchestration layer. The firmware fixture is real C built by
MSVC through CMake and tested with CTest. The domain package owns the candidate
schema, SHA-256 evidence digests, selection policy, approval binding, explicit
workflow state machine, and review gate.

The local orchestrator gives every candidate a unique directory, passes child
processes a secret-free environment allowlist, runs a fixed command sequence
with timeouts, and captures structured receipts. Its append-only JSONL store
hash-links every event and validates semantic ordering during replay. The web
service atomically persists the UI view and rejects it on reload if it no
longer matches the event chain, source commit, selected patch, evidence digest,
or approval.

### Fireworks AI

Fireworks is the candidate-generation boundary. The adapter requests one of
three distinct strategies using a strict `CandidatePatch` JSON Schema,
temperature 0, optional seed, fixed safety-policy context, protected paths, and
bounded local Zod validation. Malformed structured output receives only a
controlled retry; candidate identity drift fails closed.

**If removed:** SafeFlash loses model-driven repair generation, strategy
diversity, and model latency/token evidence.

**Current proof boundary:** the official-endpoint and structured-output adapter
is contract-tested; no authorized Fireworks request ID is committed.

### Daytona

Daytona is designed as the isolation boundary, not merely a hosting provider.
The official-SDK adapter creates a private sandbox per candidate, clones an
exact commit, blocks network after cloning, uploads only a server-prevalidated
patch, runs a fixed server-owned build/test policy, records command/artifact
evidence, and destroys the sandbox unless retention was explicitly requested.
Model-provided test names never become shell commands.

**If removed:** SafeFlash loses the remote trust boundary required to execute
untrusted generated firmware without trusting the control-plane host.

**Current proof boundary:** lifecycle and policy behavior are contract-tested;
the shown tournament uses unique local filesystem copies and is not described
as Daytona. No live sandbox ID is committed.

### Braintrust

Braintrust is designed as the evaluation memory. The repository defines a
ten-row `Firmware Safety Incidents` dataset and eight deterministic scorers:
BuildSuccess, UnitTestPassRate, SafetyInvariant, RegressionProtection,
PatchIntegrity, PatchMinimality, ExplanationGroundedness, and
Reproducibility. The adapter can seed the Dataset, write a Trace/Span, and run
an Experiment, and refuses to call the result real unless remote identifiers
are returned.

**If removed:** SafeFlash loses hosted, repeatable experiments and traceable
evaluation links across candidates and runs.

**Current proof boundary:** dataset/scorer/SDK behavior is contract-tested;
the displayed scores are local deterministic scores. No live Braintrust
Dataset, Trace, or Experiment ID is committed.

### CopilotKit

CopilotKit v2 connects the evidence console to shared session state and
registers the evidence-bound human-in-the-loop decision. The visible UI uses
the real SafeFlash session API: it is not a timed animation, it survives a
reload, and its backend independently checks every approval field.

**If removed:** SafeFlash loses the agent-native shared-state and human
interrupt layer that makes the safety boundary understandable and actionable.

**Current proof boundary:** the provider, `useAgentContext`, and
`useHumanInTheLoop` integration are present and production-tested. The
server-side Copilot model runtime remains intentionally unavailable until a
model provider is configured.

### GitHub and CodeRabbit

The GitHub adapter accepts PR creation only when the remote branch head exactly
matches the evidence-bound approved commit. It requires a public repository
with push permission and can only create or return an open, unmerged PR; no
merge method exists.

CodeRabbit is designed as the independent second reviewer. Its adapter accepts
only official bot/app evidence for the exact PR head SHA, preserves raw and
normalized severity, rejects stale results, checks for review races, and
blocks readiness on Critical/High findings. The state machine requires review
repairs to return through full validation rather than jump directly to ready.

**If CodeRabbit is removed:** SafeFlash loses an independent organizational
review gate capable of challenging the agent's selected patch.

**Current proof boundary:** GitHub/CodeRabbit behavior is contract-tested. No
public demo PR or live CodeRabbit review is committed because repository
authorization and App installation are not configured.

## Challenges we ran into

### Turning physical safety into executable policy

The hardest problem was not generating a plausible `if` statement. It was
expressing sensor disconnect, out-of-range data, stale samples, fault latching,
controlled recovery, and normal behavior as deterministic assertions that an
AI explanation cannot negotiate away.

### Preventing the evaluator from becoming the attack surface

A generated patch could appear successful by deleting a failing test,
modifying a safety threshold, changing the build, downloading code, or making
the test runner return success. We placed patch integrity outside the model and
added adversarial checks for protected paths, traversal, binary changes,
shell/network code, file operations, and threshold edits.

### Binding every transition to exact evidence

“Approved” is unsafe if the patch changes afterward. We canonicalize and hash
evidence, bind approval to five exact values, bind PR creation to the remote
head, and bind review to the exact PR revision. Persisted state is revalidated
against the append-only event chain on every load.

### Staying honest when external systems are unavailable

The five provider boundaries are useful only if their provenance is credible.
Live mode requires an explicit authorization switch and credentials, and it
never silently falls back. Local, mock, cached, manual-attestation, and live
results have distinct labels. This made the fallback less flashy, but much
more trustworthy.

## Accomplishments that we're proud of

The following are backed by committed evidence:

- A real C baseline that builds successfully and exposes three physical-safety
  failures while passing five normal unit assertions.
- A deterministic three-candidate tournament with unique local filesystem
  isolation and real MSVC/CMake/CTest results.
- A hard-gate selector that rejects Candidate A despite its higher weighted
  score.
- Ten firmware-safety incident definitions and eight deterministic scorer
  implementations.
- Adversarial protection against test, CI, build, policy, threshold, binary,
  path, shell, and network manipulation.
- Twenty-seven hash-chained tournament events that independently replay to the
  same winner.
- A production Next.js console with three persistent candidate cards,
  provenance on visible evidence, evidence-bound approval, stopped polling
  after approval, and reload recovery.
- A Phase 4 Chrome 1440×900 run with 4/4 E2E cases, zero console errors or
  warnings, and `pullRequestCreated: false` in local mode.
- Fail-closed provider adapters and contract tests that never turn a missing
  credential into a fabricated success.

We do **not** list live Daytona sandboxes, Braintrust experiments, Fireworks
generation, GitHub PR creation, or a CodeRabbit repair round as accomplishments
until those artifacts exist.

## What we learned

The most capable model is not a safety architecture. The useful shift was to
separate proposal from proof:

- Models generate hypotheses.
- Isolated execution produces evidence.
- Deterministic hard gates define what cannot be traded away.
- Evaluation makes candidate comparison reproducible.
- Humans authorize the deployment boundary.
- An independent reviewer can reopen the entire validation loop.

We also learned that failed candidates are product value. Keeping Candidate A
and B visible explains *why* the winner is trusted far better than showing only
the successful diff.

## What's next

1. Compose the five provider adapters into the production session state
   machine and capture a complete authorized live run.
2. Add hardware-in-the-loop validation against real development boards and
   programmable fault injection.
3. Support MCU/RTOS build systems, cross-compilers, and timing/resource
   constraints.
4. Derive datasheet-aware safety policies and device-specific invariants.
5. Add signed firmware provenance, SBOM/attestation output, and CI/CD
   deployment gates.
6. Build a real `recorded-live` fallback whose immutable artifacts retain
   capture time, provider IDs, commit, and review head.

## Hackathon-day new work

The workspace began with only the supplied specification. The unchanged
baseline is commit `29378c54ec2d349ac5494bf454f967579876413c`, tagged
`pre-hackathon-baseline`; implementation is on
`hackathon/safety-tournament`.

The core new feature is the **Parallel Safety Tournament**: multiple firmware
repair candidates execute separately, deterministic physical-safety gates
eliminate unsafe candidates, and all failures remain visible in the evidence
console. [`HACKATHON_BUILD.md`](HACKATHON_BUILD.md) maps each phase to its
verification package.

## Built with

- TypeScript, Node.js, npm workspaces
- Next.js, React, CopilotKit
- C, CMake, CTest, MSVC
- Fireworks AI adapter
- Daytona SDK adapter
- Braintrust SDK adapter and deterministic scorers
- Octokit/GitHub adapter
- CodeRabbit review adapter
- Zod, Vitest, Playwright

## Run it

```powershell
npm ci
npm run verify:p0
npm run dev
```

The local UI is intentionally labelled not provider-verified. See
[`docs/runbook.md`](docs/runbook.md) for toolchain setup, production commands,
external smoke checks, evidence verification, and the precise live-path
limitation.

## Evidence

- Workspace and external blocker audit:
  [`artifacts/evidence/phase-0/`](artifacts/evidence/phase-0/)
- Unsafe compiled baseline:
  [`artifacts/evidence/phase-1/20260722T192339273Z/`](artifacts/evidence/phase-1/20260722T192339273Z/)
- Three-candidate local tournament:
  [`artifacts/evidence/phase-3/phase3-evidence-20260722T220559152Z/`](artifacts/evidence/phase-3/phase3-evidence-20260722T220559152Z/)
- Production console, approval, replay, and manifest:
  [`artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/`](artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/)
- Final P0 local verification: generated by `npm run verify:p0` under
  `artifacts/evidence/phase-6/` after a clean-tree run.

## Two-minute video storyboard

### 0:00–0:15 — The danger

Show sensor disconnected, `0°C`, charging still on. Explain that the baseline
compiles and passes normal tests.

### 0:15–0:30 — SafeFlash

Introduce the evidence gate and click **Run Safety Tournament**.

### 0:30–1:05 — Three candidates

Show A build-pass/safety-fail, B build-fail, and C full pass. Zoom on A's 0.897
versus C's 0.890 and explain the non-compensable hard gate.

### 1:05–1:25 — Human boundary

Open the selected diff/evidence, show the binding identifiers, and record local
approval. Highlight that no live PR is claimed.

### 1:25–1:45 — Architecture

Animate or overlay the target trust boundaries: Fireworks proposes, Daytona
isolates, Braintrust evaluates, CopilotKit asks, GitHub carries the approved
revision, and CodeRabbit can send it back through validation. Label unavailable
live integrations as such.

### 1:45–2:00 — Impact

Close on battery, medical, robotics, automotive, and industrial applications,
then the line: “Move AI into the physical world without asking people to
blindly trust it.”

## Submission fields still blocked

- Public GitHub repository URL: **requires owner/repository authorization**
- Live Fireworks request/model evidence: **requires API key and model choice**
- Live Daytona sandbox evidence: **requires API key/account**
- Live Braintrust Dataset/Trace/Experiment links: **requires API key/account**
- Live GitHub PR and CodeRabbit review/repair loop: **requires public repo,
  token, App installation, and exact PR**
- Two-minute published video URL: **not yet recorded/published**
