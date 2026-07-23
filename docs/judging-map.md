# SafeFlash judging map

This map tells a judge what can be shown, where its evidence lives, and which
claims remain blocked. “Implemented” is not treated as “verified live.”

## The one sentence to remember

> SafeFlash makes multiple firmware fixes compete on executable evidence, and
> a dangerous patch cannot win on average score because physical safety,
> integrity, human approval, and independent review are hard gates.

## Official judging dimensions

| Dimension | Three-minute proof | Repository evidence | Current status |
|---|---|---|---|
| Impact potential | A disconnected battery sensor reports `0°C` while charging remains on; the same failure class exists in robots, vehicles, medical devices, and industrial control. | `fixtures/battery-controller/`, Phase 1 safety log | verified locally |
| Technical execution | Real native build/tests, three candidate copies, protected-patch checks, hard-gate selection, evidence chain, persistent UI, and bound approval. | Phase 1–4 evidence; `packages/`; `apps/` | verified locally |
| Creativity | Candidate tournament plus physical-safety invariants; Candidate A scores 0.897 but loses to eligible Candidate C at 0.890. | Phase 3 `summary.json`; Phase 4 screenshot | verified locally |
| Presentation | One screen moves from red incident to three-way tournament to green-but-controlled approval. | Phase 4 production screenshot and Playwright verification | verified locally |
| Sponsor depth | Each provider owns a distinct trust boundary and fails closed when unavailable. | `packages/integrations/`; provider contract tests | implemented; live proof blocked |

## The visual proof sequence

1. **Danger:** the baseline compiles and passes 5/5 unit assertions, yet fails
   the disconnect, stale-sample, and latch safety assertions.
2. **Tournament:** all three candidates stay visible. A passes its build but
   fails safety, B fails its build, and C passes every hard gate.
3. **Non-compensation:** A's 0.897 weighted score is higher than C's 0.890,
   but A is ineligible. C wins because selection considers only eligible
   candidates.
4. **Human boundary:** the UI requests an approval bound to candidate, patch,
   evidence, policy, and commit. In local mode the button says
   **Approve evidence (no live PR)**.
5. **Honest stop:** the local backend records approval and does not invent a
   GitHub PR or CodeRabbit success.

## P0 acceptance matrix

| P0 test | Test/evidence location | What it proves | Status boundary |
|---|---|---|---|
| `baseline_builds_but_fails_sensor_disconnect_safety_test` | `tests/integration/baseline-firmware.test.ts`; Phase 1 summary/logs | A real compiled baseline is unsafe in the expected cases. | local native execution |
| `candidate_patch_schema_is_validated` | `tests/unit/candidate-patch-schema.test.ts` | Candidate identity, strategy, bounded fields, unified diff, and test identifiers are validated. | local contract |
| `each_candidate_uses_unique_sandbox` | `tests/unit/workflow.test.ts`; Phase 3 sandbox IDs | Duplicate sandbox IDs are rejected; the local tournament used three unique copies. | not proof of live Daytona |
| `failed_build_is_ineligible` | `tests/unit/selector.test.ts`; Candidate B evidence | A build failure is a non-compensable eligibility failure. | local contract + real local build |
| `failed_safety_gate_cannot_be_compensated_by_high_average_score` | `tests/unit/selector.test.ts`; Candidate A evidence | A high weighted score cannot hide a failed safety invariant. | local contract + real local tests |
| `patch_cannot_modify_existing_tests` | `tests/adversarial/patch-integrity.test.ts` | Existing test files/directories are immutable to model patches. | local adversarial contract |
| `patch_cannot_modify_safety_thresholds` | `tests/adversarial/patch-integrity.test.ts` | Source changes cannot redefine or assign safety thresholds to game evaluation. | local adversarial contract |
| `highest_eligible_candidate_is_selected` | `tests/unit/selector.test.ts`; Phase 3 decision | Ranking selects the highest-scoring eligible candidate, independent of name. | local contract + tournament |
| `human_approval_required_before_pr` | `tests/unit/workflow.test.ts`; GitHub adapter tests | PR transition is impossible without a current evidence-bound approval. | local contract; no live PR |
| `approval_invalidated_when_patch_changes` | `tests/unit/evidence-approval.test.ts` | Changing the patch or other binding data invalidates prior approval. | local contract |
| `critical_review_finding_blocks_ready_to_merge` | `tests/unit/workflow.test.ts`; CodeRabbit adapter tests | Blocking review findings prevent readiness. | local contract; no live review |
| `review_fix_reenters_full_validation_pipeline` | `tests/unit/workflow.test.ts`; `tests/integration/provider-revalidation.test.ts` | A review repair must return through revalidation, use a never-reused sandbox, and derive its receipt from exact live-provider envelopes rather than caller booleans. | local state/integration contract; no live loop |
| `secrets_are_not_exposed_to_frontend_or_git` | `tests/adversarial/secrets.test.ts` | Client files, current tracked text, and full reachable Git patches are checked against every configured local/environment secret value; synthetic provider tokens also verify redaction. | local adversarial scan |
| `demo_session_can_be_replayed_from_recorded_evidence` | `tests/integration/tournament.local.test.ts`; Phase 4 `replay.txt` | The 27-event local chain replays to the same three-candidate winner. | local-test evidence, not recorded-live provider evidence |

The matrix closes the deterministic P0 contracts. It does **not** close the
specification's external live P0: Fireworks, Daytona, Braintrust, public
GitHub, and CodeRabbit still require credentials/account authorization and
fresh evidence.

### Authoritative local P0 command

After committing all intended work and confirming a clean tree, run:

```powershell
npm run verify:p0
```

This is the final local acceptance command. It binds typecheck, the full
Vitest suite, production build, Chrome 1440×900 Playwright, and the exact
14-name matrix above to one commit, then writes redacted logs and a SHA-256
manifest under `artifacts/evidence/phase-6/`. The capture refuses a dirty tree
and removes provider credentials from child processes. It cannot and does not
promote any external provider to live status.

## Sponsor integration map

| Tool | Why it is architecturally necessary | What removal would lose | Implemented proof | Missing live proof |
|---|---|---|---|---|
| Fireworks AI | Generates three schema-constrained repair strategies from incident and policy context. | Model-driven candidate diversity and latency/token trace data. | Official-endpoint guard, JSON Schema request, Zod validation, controlled retry, three-strategy contract tests. | request/model/token IDs from an authorized call |
| Daytona | Security boundary for executing untrusted generated firmware away from the control plane. | Per-candidate remote isolation, account-enforced lifecycle, and remote sandbox evidence. | Official SDK port, exact-commit clone, network block, fixed command policy, teardown, contract tests. | three real unique sandbox IDs and command evidence |
| Braintrust | Hosted evaluation memory for Dataset, Trace/Span, Experiment, and scorer results. | Repeatable provider-hosted comparison and trace links. | Ten incident definitions, eight deterministic scorers, SDK seed/trace/Experiment ports, contract tests. | real Dataset/Trace/Experiment IDs and URLs |
| CopilotKit | Shared agent state and human-in-the-loop interaction in the console. | Agent-native approval interrupt and shared-state experience. | v2 provider, `useAgentContext`, `useHumanInTheLoop`, real session API UI, production Playwright proof. | configured server-side model runtime and live agent exchange |
| CodeRabbit | Independent reviewer on the exact candidate PR revision. | A second organizational trust boundary that can send a patch back through validation. | Official identity filtering, severity normalization, stale-head and TOCTOU guards, review-gate tests. | App installation, real exact-head review, and repair/revalidation round |

GitHub is the deployment-boundary transport: an approved candidate can create
an open PR, but SafeFlash exposes no merge method. Its adapter is tested; an
authorized public repository and live PR are still missing.

## Evidence index

### Phase 0 — audited foundation

- [`phase-0/README.md`](../artifacts/evidence/phase-0/README.md)
- [`workspace-audit.json`](../artifacts/evidence/phase-0/workspace-audit.json)
- [`external-smoke-status.json`](../artifacts/evidence/phase-0/external-smoke-status.json)

Shows the empty starting workspace, baseline commit/tag, local toolchain, and
the five honestly blocked providers.

### Phase 1 — real unsafe firmware

- [`summary.json`](../artifacts/evidence/phase-1/20260723T004428654Z/summary.json)
- [`build.log`](../artifacts/evidence/phase-1/20260723T004428654Z/build.log)
- [`unit-tests.log`](../artifacts/evidence/phase-1/20260723T004428654Z/unit-tests.log)
- [`safety-tests.log`](../artifacts/evidence/phase-1/20260723T004428654Z/safety-tests.log)

MSVC/CMake build passed; 5/5 unit assertions passed; the safety executable
reported 3 passes and 3 expected failures.

### Phase 2 — deterministic policy contracts

- [`phase-2/verification.json`](../artifacts/evidence/phase-2/verification.json)

Records the original domain/adversarial verification. Later Phase 3 full-suite
evidence supersedes its test-count snapshot without changing its scope.

### Phase 3 — real local three-candidate tournament

- [`phase-3/verification.json`](../artifacts/evidence/phase-3/verification.json)
- [`summary.json`](../artifacts/evidence/phase-3/phase3-evidence-20260722T220559152Z/summary.json)
- [`events.jsonl`](../artifacts/evidence/phase-3/phase3-evidence-20260722T220559152Z/events.jsonl)

Records 14 passing Vitest files/57 tests at that commit, three unique local
copies, real command outcomes, deterministic scores, and a 27-event chain. The
claim boundary explicitly excludes all external providers.

### Phase 4 — production console and approval

- [`phase-4 evidence README`](../artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/README.md)
- [`verification.json`](../artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/verification.json)
- [`console-1440x900.png`](../artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/console-1440x900.png)
- [`session.json`](../artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/session.json)
- [`replay.txt`](../artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/replay.txt)
- [`manifest.sha256`](../artifacts/evidence/phase-4/phase4-evidence-20260722T223143361Z/manifest.sha256)

Records a production Next.js session at 1440×900, 4/4 Chrome E2E tests, zero
console errors/warnings, stopped polling after bound approval, reload
persistence, and no PR creation.

### Phase 5 — live-provider fail-closed preflight

- [`external-smoke.json`](../artifacts/evidence/phase-5/phase5-preflight-20260723T010926245Z/external-smoke.json)
- [`manifest.sha256`](../artifacts/evidence/phase-5/phase5-preflight-20260723T010926245Z/manifest.sha256)

The aggregate smoke preflight stopped before constructing any provider client
because live authorization and credentials were absent. It records every
required next action and makes no external-success claim.

### Phase 6 — final local P0 capture

- `artifacts/evidence/phase-6/latest-run.txt` after `npm run verify:p0`
- the referenced run's `summary.json`, `vitest.json`, command logs, and
  `manifest.sha256`

This package is authoritative only after a clean-tree run completes with
`P0_RESULT=PASS`. Its provenance remains `local-test/local-process`, with all
external live providers explicitly excluded.

## Claims to make—and not make

| Safe statement | Unsafe statement until new evidence exists |
|---|---|
| “Three candidates ran real local CMake/CTest in unique filesystem copies.” | “Three candidates ran in Daytona.” |
| “Eight deterministic scorer implementations selected only among eligible candidates.” | “Braintrust scored this run.” |
| “The Fireworks adapter enforces structured output and is contract-tested.” | “Fireworks generated these committed candidates.” |
| “CopilotKit HITL is registered over the real session state.” | “CopilotKit's live model ran the tournament.” |
| “The CodeRabbit gate rejects stale/exact-head blockers in tests.” | “CodeRabbit reviewed or passed this patch.” |
| “Local approval is persisted and bound to exact evidence.” | “Approval created a GitHub PR.” |

## External P0 closure checklist

The live story can be promoted only after all of the following are saved as
new redacted, immutable evidence:

- Fireworks request ID, model, schema-valid three-candidate output, latency,
  and token counts.
- Three Daytona sandbox IDs, exact commit, fixed command receipts, network
  state, artifacts, and destruction/retention status.
- Braintrust Dataset ID, Trace/Span IDs, Experiment ID/URL, and all scorer
  results.
- Public GitHub repository, approved exact branch head, open PR URL, and body
  containing the evidence references.
- CodeRabbit App identity, review/check evidence for that exact PR head, a
  blocking round, repair, full Daytona/Braintrust revalidation, and a passing
  second round.
- Three consecutive rehearsals of the resulting live path plus a separately
  labelled recorded-live fallback.
