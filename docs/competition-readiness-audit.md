# SafeCommit competition readiness audit

Audit snapshot: 2026-07-24, America/Los_Angeles.

## Executive result

| Boundary | Status | Evidence |
|---|---|---|
| Local MySQL tournament | `PASS / LOCAL_TEST` | clean source-bound evidence package |
| Intent, SQL policy, hard gates, rollback | `PASS / LOCAL_TEST` | unit, adversarial, integration tests |
| SafeCommit console and HITL | `PASS / LOCAL_TEST` | production build and four Playwright flows |
| Fireworks database plans | `BLOCKED` | adapter contract passes; no current request ID |
| Daytona database snapshots | `BLOCKED` | adapter contract passes; no sandbox IDs/cleanup receipts |
| Braintrust evaluation | `BLOCKED` | 12-case contract passes; no Dataset/Trace/Experiment URL |
| GitHub competition branch | `PENDING` | local branch not yet pushed |
| Current CodeRabbit review | `BLOCKED` | GitHub App authorization/review not confirmed |
| Public app | `BLOCKED` | no authorized deployment target |
| PDF and speaker notes | `PASS` | rendered 10-page PDF, visual QA complete |
| PPTX | `BLOCKED` | required host `@oai/artifact-tool` package missing |

```text
LOCAL_TESTS=PASS
FIREWORKS_LIVE=BLOCKED
DAYTONA_LIVE=BLOCKED
BRAINTRUST_LIVE=BLOCKED
COPILOTKIT_HITL=PASS
GITHUB_PUSH=PENDING
CODERABBIT_REVIEW=BLOCKED
PUBLIC_URL=BLOCKED
RECORDED_LIVE=NOT_AVAILABLE
LIVE_CERTIFIED=NO
```

## Verified local result

The committed run `safecommit-mysql-20260724T071144887Z` used MySQL 8.0.36
against the OpenBoxes-derived fixture and was captured from a clean source
commit.

- Candidate A: score `0.975000`; ineligible for warehouse and tenant scope.
- Candidate B: score `0.991667`; ineligible for protected order history.
- Candidate C: score `0.962500`; eligible winner; two affected rows.
- Winner: thirteen hard gates passed.
- Winner: before and rollback state digests match.
- Provider calls in this artifact: zero.

This proves the local product and safety contracts. It does not prove
Fireworks, Daytona, or Braintrust execution.

## Implemented sponsor boundaries

### Fireworks

- official endpoint allowlist;
- JSON Schema structured `CandidateChangePlan`;
- required candidate identity and strategy binding;
- local Zod and MySQL AST revalidation;
- provider request ID, model, token, latency, and request digest evidence;
- fail closed on missing credentials, malformed output, or unsafe SQL.

### Daytona

- immutable GitHub source commit;
- named database snapshot requirement;
- one ephemeral private sandbox per candidate;
- uploaded plan/intent as data;
- frozen runner command;
- network blocked before candidate execution;
- bound sandbox/run/session/source evidence;
- bounded cleanup retries; cleanup failure invalidates the run.

### Braintrust

- twelve-case SafeCommit logistics Dataset contract;
- Dataset, Trace, Experiment, project, and result ID/URL validation;
- deterministic hard-gate scorers recomputed from DatabaseEvidence;
- quality score separated from hard-gate eligibility;
- incomplete or duplicated remote results rejected.

These are implemented and contract-tested interfaces. Without current remote
IDs they remain `BLOCKED`, not `LIVE`.

## Required user/external inputs

1. Revoke the Daytona and Braintrust keys previously exposed in chat.
2. Inject newly rotated credentials outside Git and chat:
   `FIREWORKS_API_KEY`, `FIREWORKS_MODEL`, `DAYTONA_API_KEY`,
   `DAYTONA_DATABASE_SNAPSHOT`, `DAYTONA_DATABASE_MYSQL_URL`,
   `BRAINTRUST_API_KEY`.
3. Confirm CodeRabbit GitHub App authorization on
   `Frankie744/safeflash-ai`.
4. Authorize a Daytona App Sandbox deployment and operator access strategy.
5. Restore the Codex runtime package `@oai/artifact-tool` for PPTX generation.

## Prohibited claims

- Do not call the fixture a full OpenBoxes deployment.
- Do not call local transactions Daytona sandboxes.
- Do not call local plans Fireworks output.
- Do not call UI scores a Braintrust Experiment.
- Do not say `LIVE_CERTIFIED=YES` until one uninterrupted, source-bound run
  supplies every required provider ID and URL.
- Do not auto-merge a pull request.
