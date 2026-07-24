# SafeCommit judge Q&A

## Is this just a SQL linter?

No. The AST integrity gate is only the first boundary. SafeCommit executes each
eligible plan against a real database snapshot, captures the resulting state,
and verifies warehouse scope, tenant isolation, inventory conservation, order
history, relationships, idempotency, and rollback.

## Is this just staging?

Staging isolates an environment but does not prove that the result matches the
request. SafeCommit adds an intent contract, deterministic business
invariants, multiple candidates, evidence-bound selection, and human approval.

## Why three candidates?

A single candidate answers only “does this run?” Multiple candidates expose
strategy differences. Safety is checked before ranking, so a high-scoring
unsafe plan cannot win.

## Why not ask a stronger model to retry?

Model confidence is not execution evidence. SafeCommit assumes models can be
wrong and makes the real state transition observable and blockable.

## Did you deploy full OpenBoxes?

No. The demo uses an `OpenBoxes-derived executable fixture`, not a complete
official deployment. It pins an upstream OpenBoxes revision and implements the
minimum MySQL logistics relationships needed for the safety task.

## Is the current result live?

The current committed database evidence is `LOCAL_TEST`: real local MySQL
execution, but zero Fireworks, Daytona, or Braintrust calls. Those boundaries
remain `BLOCKED` until remote IDs and URLs are captured. The UI labels are the
authority; no automatic downgrade is hidden.

## Does SafeCommit touch production?

No. The competition profile runs only in isolated snapshots and ends at
`SAFE_TO_COMMIT`. Production connectivity is out of scope.

## Can a human approve an unsafe plan?

No. Failed hard gates make the plan ineligible. Human approval is available
only for an eligible plan and binds the exact intent, plan, database snapshot,
policy, source commit, and evidence digest. Any change invalidates it.

## Why did the highest score lose?

Candidate B scored `0.991667` but rewrote a shipped order and failed
`ProtectedOrderState`. Candidate C scored `0.962500`, passed every hard gate,
and became the eligible winner. Quality optimizes only within the safe set.

## What stops arbitrary shell execution?

Model output is parsed strictly as `CandidateChangePlan`. The execution layer
uses server-owned SQL validation and frozen commands. Candidate fields never
become arbitrary shell commands.

## What is the product path beyond logistics?

The reusable unit is a database profile plus an invariant pack. The next
profiles could address multi-tenant SaaS data, financial operations, or cloud
migrations without claiming universal database support today.
