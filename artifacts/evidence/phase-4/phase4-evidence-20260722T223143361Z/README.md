# Phase 4 production-console evidence

This evidence package is bound to source commit
`ea43ad660b7ad15c37235809cab03455c26edc90` and session
`web-79465da6-c2fc-4869-b816-91d535feec62`.

The browser used the real production API without route interception. Creating
the session returned HTTP 201 and ran the deterministic local CMake/CTest
tournament. Candidate C passed its build, all 5 tests, and every hard safety
gate. Candidate A's higher weighted score remained ineligible because its hard
gate failed; Candidate B remained ineligible because its build failed.

The human action recorded one approval bound to the selected candidate, source
commit, policy, patch digest, and evidence digest. Because the run is explicitly
`mock` / `local-test`, the backend did not create or claim a GitHub pull request.
After reopening the page, the approval and all 28 events were restored from the
persisted snapshot. The browser made one detail request and made no further
request during the following 2200 ms.

Files:

- `console-1440x900.png`: visually inspected production screenshot.
- `session.json`: exact persisted session, approval binding, and 28-event UI view.
- `events.jsonl`: the 27 append-only, hash-chained tournament events. An
  independent replay verified the chain, three candidates, completed status,
  and Candidate C winner; the local approval is stored in `session.json`.
- `verification.json`: machine-readable browser and test assertions.
- `console.txt` and `network.txt`: Playwright inspection results.
- `replay.txt`: independent copied-event-log replay result.
- `manifest.sha256`: SHA-256 digest for every other file in this directory.

Claim boundary: no Daytona, Braintrust, Fireworks, GitHub, or CodeRabbit live
execution is represented by this local evidence package.
