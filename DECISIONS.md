# SafeFlash decisions

This log records decisions that affect safety, evidence, or hackathon scope.

## D-009 - Preserve SafeFlash and pivot the competition product

- Date: 2026-07-24
- Status: accepted
- Decision: preserve commit
  `afe304b8562d0e9b84c881c4aab8b005637e5138` with tag
  `pre-safecommit-pivot-20260724` and branch
  `archive/safeflash-firmware-20260724`; build SafeCommit on
  `hackathon/safecommit-logistics`.
- Reason: the new database product must not erase or rewrite the verified
  firmware safety history.

## D-010 - Use an OpenBoxes-derived fixture, not a full deployment

- Date: 2026-07-24
- Status: accepted
- Decision: pin MySQL 8.0.36 and OpenBoxes source revision
  `99fb3e61d2ba220dc1d83847e4852e2846ee17f0`, while implementing only the
  logistics relationships required by the competition task.
- Reason: this provides an executable, relationally meaningful fixture without
  falsely claiming a complete official OpenBoxes deployment.

## D-011 - Database safety is eligibility before quality

- Date: 2026-07-24
- Status: accepted
- Decision: thirteen deterministic gates run before weighted ranking. Failed
  candidates remain visible but are ineligible. Human approval cannot override
  a hard gate.
- Reason: execution success or a high average score cannot compensate for
  wrong-warehouse changes, tenant leakage, lost inventory, altered protected
  orders, non-idempotency, or failed rollback.

## D-012 - Keep local and sponsor evidence separate

- Date: 2026-07-24
- Status: accepted
- Decision: local MySQL evidence is `LOCAL_TEST`. Fireworks, Daytona, and
  Braintrust remain `BLOCKED` until the current run returns verifiable remote
  provider IDs and URLs. No silent fallback is allowed.
- Reason: provider-shaped local fixtures are not sponsor execution evidence.

## D-013 - PPTX generation follows the installed skill boundary

- Date: 2026-07-24
- Status: blocked
- Decision: deliver the verified ten-page PDF and speaker notes, but do not
  generate a PPTX with an unapproved legacy library while the required
  `@oai/artifact-tool` host package is missing.
- Reason: an explicit artifact-tool requirement is stronger than merely
  producing a file with a `.pptx` extension.

## D-001 — Honest empty-workspace baseline

- Date: 2026-07-22
- Status: accepted
- Decision: preserve the supplied specification as commit
  `29378c54ec2d349ac5494bf454f967579876413c`, tag it
  `pre-hackathon-baseline`, and implement on
  `hackathon/safety-tournament`.
- Reason: the audited directory contained no prior repository or application.
  Treating generated code as pre-hackathon work would be inaccurate.

## D-002 — TypeScript control plane with a Next.js server boundary

- Date: 2026-07-22
- Status: accepted
- Decision: use npm workspaces, a Next.js full-stack application, and isolated
  domain/integration packages. `npm run dev` starts both UI and server routes.
- Reason: one deployable process minimizes demo failure modes while preserving
  explicit server-only provider boundaries. Provider secrets never enter
  client modules.

## D-003 — Deterministic native firmware fixture

- Date: 2026-07-22
- Status: accepted
- Decision: use CMake/CTest and the already installed Visual Studio C++ tools.
  Project scripts discover the toolchain without changing the machine PATH.
- Reason: the fixture remains real compiled C, fast, and independent of real
  hardware or Docker.

## D-004 — Provenance is part of every event and evidence object

- Date: 2026-07-22
- Status: accepted
- Decision: `live`, `recorded-live`, `mock`, and `local-test` are distinct
  provenance values. Live mode fails closed when credentials or providers are
  unavailable; it never silently becomes mock mode.
- Reason: sponsor evidence must be verifiable and fallback playback must not
  impersonate a current live run.

## D-005 — Hard gates run outside the model

- Date: 2026-07-22
- Status: accepted
- Decision: build success, safety invariants, patch integrity, and a 95% unit
  pass rate are non-compensable deterministic gates. Only eligible candidates
  participate in weighted selection. Candidate names are never inputs.
- Reason: an LLM explanation or high average score cannot make unsafe firmware
  eligible.

## D-006 — Approval is evidence-bound and PR creation is separate from merge

- Date: 2026-07-22
- Status: accepted
- Decision: approval binds an approver and timestamp to an evidence digest.
  Patch, policy, test, score, or review changes invalidate it. SafeFlash may
  create/update a PR after approval but never merges it.
- Reason: this is the human deployment boundary required by the product.

## D-007 — CodeRabbit P0/P1 boundary

- Date: 2026-07-22
- Status: accepted
- Decision: P0 enforces and tests that a Critical/High review finding blocks
  readiness and that every repair re-enters the complete validation pipeline.
  A repeatable two-round live CodeRabbit demonstration is treated as P1 until
  repository installation and review timing are verified.
- Reason: this resolves the specification's P0 test requirement and P1 live
  demo wording without weakening the gate.

## D-008 — Evidence retention and redaction

- Date: 2026-07-22
- Status: accepted
- Decision: raw provider logs live only under ignored `raw/` directories.
  Committed evidence is structured, hash-addressed, and redacted.
- Reason: API keys and private response content must not enter Git or the
  frontend bundle.
