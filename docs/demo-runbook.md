# SafeCommit demo runbook

## Current safe demo

This runbook is for the deterministic `LOCAL_TEST` path. Do not call it live
Fireworks, Daytona, or Braintrust.

Preflight:

```powershell
git status --short
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Start the console:

```powershell
$env:SAFECOMMIT_OPERATOR_TOKEN="<operator token>"
$env:SAFECOMMIT_APPROVER_ID="<judge-visible operator name>"
npm run dev:competition
```

Open `http://127.0.0.1:3018`.

## Three-minute click path

1. Point out the header label: `OpenBoxes-derived executable fixture` and
   `LOCAL_TEST`.
2. Read the natural-language logistics task and frozen intent scope.
3. Run the tournament.
4. Sort by quality score. Candidate B is highest at `0.991667`.
5. Open Candidate B and show `ProtectedOrderState = FAIL`.
6. State: “Execution succeeded, but business correctness failed, so score
   cannot rescue it.”
7. Open Candidate C. Show every hard gate passing, two affected rows, and equal
   before/rollback digests.
8. Approve Candidate C. Show the approval binding digest and
   `SAFE_TO_COMMIT`.
9. Trigger revalidation. Show that the previous approval becomes invalid.
10. End on the evidence authority panel: local passes, provider live items are
    blocked, `LIVE_CERTIFIED=NO`.

## CLI evidence

With the fixture MySQL server running:

```powershell
$env:SAFECOMMIT_MYSQL_URL="mysql://<fixture-user>:<fixture-password>@127.0.0.1:<port>/safecommit"
npm run demo:database-local
```

Expected authority lines:

```text
SAFECOMMIT_DATABASE_LOCAL=PASS
PROVENANCE=LOCAL_TEST
MYSQL_VERSION=8.0.36
CANDIDATES=3
WINNER=candidate-c-safe
FIREWORKS_LIVE=BLOCKED
DAYTONA_LIVE=BLOCKED
BRAINTRUST_LIVE=BLOCKED
LIVE_CERTIFIED=NO
```

## Live cutover checklist

Do not begin until newly rotated credentials exist outside Git and the Daytona
database snapshot has been created.

- `SAFEFLASH_ALLOW_LIVE=true` set only in the server environment
- `FIREWORKS_API_KEY` and `FIREWORKS_MODEL`
- `DAYTONA_API_KEY` and `DAYTONA_DATABASE_SNAPSHOT`
- `BRAINTRUST_API_KEY`
- three unique Daytona sandbox IDs and cleanup receipts
- Braintrust Dataset, Trace, and Experiment remote IDs/URLs
- public app operator authorization
- captured source commit and evidence manifest

If any item is missing, keep that provider `BLOCKED`. Never substitute the
local candidate plans for Fireworks output or local transactions for Daytona.

### Build the Daytona database snapshot

The repository contains a content-addressed MySQL 8.0.36 snapshot recipe. Run
it only with explicit live authorization and a Daytona API key:

```powershell
$env:SAFEFLASH_ALLOW_LIVE = "true"
$env:DAYTONA_API_KEY = [Environment]::GetEnvironmentVariable(
  "DAYTONA_API_KEY",
  "User"
)
npm run daytona:database-snapshot
```

The command reuses an exact active snapshot or creates one from
`fixtures/logistics-mysql/Dockerfile.daytona`, then verifies MySQL, Node, and
tsx in a private network-blocked sandbox and deletes that sandbox. Copy the
reported snapshot name and loopback-only MySQL URI into the server environment;
never commit either value to `.env.example`.

After the snapshot and all three provider credentials are configured, run the
live database tournament from a clean commit already pushed to its remote
branch:

```powershell
npm run demo:database-live
```

The command stops at `AWAITING_HUMAN_APPROVAL` when an eligible winner exists.
It does not publish, merge, or treat provider evidence as human authorization.

## Failure recovery

- No eligible candidate: show the failed gates and stop.
- MySQL baseline mismatch: rebuild the fixture; do not continue.
- Provider timeout or auth error: stop the live path and keep its status
  `BLOCKED`; do not silently fall back.
- Approval changed or revalidated: request a new human decision.
- Sandbox cleanup not proven: the live run is invalid.
- UI issue: use the committed local evidence JSON, still labelled
  `LOCAL_TEST`.
