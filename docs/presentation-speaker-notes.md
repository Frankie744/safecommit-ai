# SafeCommit slide-by-slide speaker notes

These notes match `SafeCommit_Championship_Deck_LOCAL_TEST.pdf`. They describe
the current evidence authority and must be updated after any live-provider run.

1. **9 seconds.** Open with the PocketOS official postmortem: deletion took
   nine seconds and recovery took sixty hours. The lesson is missing execution
   friction and evidence, not that teams must stop using AI.
2. **The real problem.** Valid SQL is not the same as a valid business state.
   Scope, tenant, inventory, and order-history errors can all execute cleanly.
3. **SafeCommit.** State the five verbs slowly: generate, shadow execute, prove,
   approve, commit. The product ends at `SAFE_TO_COMMIT`.
4. **Logistics task.** Read the requested action, then emphasize the protected
   conditions. Say explicitly that this is an OpenBoxes-derived fixture, not a
   full OpenBoxes deployment.
5. **Architecture.** Explain the intended sponsor-native live chain. Point out
   the authority labels: CopilotKit is locally validated; Fireworks, Daytona,
   and Braintrust live evidence are blocked pending fresh credentials.
6. **Magic moment.** Candidate B has the highest score but changes a shipped
   order, so it is ineligible. Candidate C is lower-scoring and safe. Pause on
   the sentence that score cannot compensate for broken state.
7. **Proof.** Show three plans, two winner-row changes, thirteen passing hard
   gates, and identical before/rollback digests. These are local MySQL results.
8. **Baseline.** Be direct: twelve cases and metric contracts exist, but the
   remote Braintrust experiment has not run. Do not present frontend scores as
   experimental improvement.
9. **Product path.** The repeatable product unit is a database profile plus an
   invariant pack. Name the expansion order without claiming those profiles
   already exist.
10. **Close.** Repeat the product sentence and the evidence status. Public URL
    and Braintrust URL remain blocked; `LIVE_CERTIFIED=NO`.
