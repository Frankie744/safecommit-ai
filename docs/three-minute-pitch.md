# SafeCommit speaking scripts

## Three-minute version

### 0:00–0:25 — The risk

AI agents can produce valid SQL and still create an invalid business. The
problem is not syntax alone. It is giving an agent execution authority without
proving the resulting inventory, orders, and tenant boundaries remain correct.

### 0:25–0:45 — The product

SafeCommit is the commit gate for AI database agents. The agent may propose a
change, but only a state transition that has been executed, measured, rolled
back, and approved against an explicit intent contract can become
`SAFE_TO_COMMIT`.

### 0:45–1:15 — The task

Our logistics task asks to merge one duplicate SKU in Los Angeles and release
inventory allocated to cancelled orders—without touching another warehouse,
another tenant, shipped orders, lots, serials, or expiration dates.

The competition dataset is an OpenBoxes-derived executable MySQL fixture, not a
full OpenBoxes deployment.

### 1:15–1:50 — The tournament

SafeCommit compares three plans against the same verified database baseline.
Each statement is AST-checked and bounded. The system captures row-level
before and after state, runs deterministic business invariants, checks the
second execution for idempotency, executes rollback, and verifies that the
rollback digest equals the initial digest.

### 1:50–2:20 — Magic moment

The highest-scoring plan scored 0.991667 and successfully executed its SQL, but
it rewrote a shipped order. `ProtectedOrderState` failed, so the plan became
ineligible. A lower-scoring plan at 0.962500 changed only the two intended rows
and passed every hard gate.

High score cannot compensate for broken business state.

### 2:20–2:45 — Human control

CopilotKit pauses before the final action. Approval binds the exact intent,
candidate, snapshot, evidence, policy, and source commit. Revalidation changes
the evidence binding and immediately invalidates the old approval. Humans can
choose among safe candidates, but cannot waive a failed hard gate.

### 2:45–3:00 — Close

Today’s committed proof is honest local MySQL evidence, labelled `LOCAL_TEST`.
The same architecture is prepared for Fireworks structured plans, three
Daytona snapshots, and Braintrust experiments, which remain blocked until
fresh provider credentials and remote evidence are available.

Let AI move fast. Make data safety non-negotiable.

## 60-second backup

Valid SQL can still modify the wrong warehouse, cross a tenant boundary, or
rewrite shipped order history. SafeCommit is the commit gate for AI database
agents. It turns a natural-language task into a strict intent contract, compares
multiple plans in database snapshots, and checks the real resulting state with
non-compensable business invariants. In our local MySQL proof, the
highest-scoring plan scored 0.991667 and executed successfully, but changed a
protected shipped order, so it was rejected. A lower-scoring plan changed only
the two intended rows, passed every gate, proved idempotency and rollback, and
became eligible for evidence-bound human approval. We do not claim the local
run as Fireworks, Daytona, or Braintrust live evidence. SafeCommit lets AI keep
its speed while making data safety non-negotiable.
