# CodeRabbit installation for SafeFlash Phase 7A

## Scope and status

This installation is authorized only for:

<https://github.com/Frankie744/safeflash-ai>

The repository owner must complete the GitHub App login, permission review, and
installation themselves. SafeFlash and its automation must not install the App,
change account or organization settings, select additional repositories, or
broaden an existing CodeRabbit installation.

Completing this installation makes the repository ready for a real review; it
does **not** make SafeFlash `LIVE_CERTIFIED`. That status remains prohibited
until Fireworks, Daytona, Braintrust, GitHub PR, and CodeRabbit have all
completed their real external smoke checks with recorded provider evidence.

## Install with least repository scope

1. Open the official [CodeRabbit GitHub installation
   guide](https://docs.coderabbit.ai/platforms/github-com) and sign in to
   CodeRabbit with GitHub.
2. When GitHub asks where to install the App, choose the personal account
   `Frankie744`. Do not select an organization.
3. Under repository access, choose **Only select repositories**. Do not choose
   **All repositories**.
4. Select only `safeflash-ai` and confirm that no other repository is listed.
5. Review GitHub's permission screen before accepting. CodeRabbit's official
   guide currently documents read-only access to Actions, checks, discussions,
   members, and metadata, plus read/write access to code, commit statuses,
   issues, and pull requests.
6. The repository owner may then click **Install & Authorize** (or **Save** for
   an existing installation). The agent must not perform or widen this
   authorization on the user's behalf.
7. Return to the installation settings and verify that repository access still
   lists only `Frankie744/safeflash-ai`.

If an existing installation includes additional repositories, stop. Do not
remove or alter those grants as part of SafeFlash Phase 7A; the account owner
must decide how to handle them.

## Verify a review on the exact PR head

Use a real, open, unmerged pull request in
`Frankie744/safeflash-ai` whose base branch is `main`. CodeRabbit normally
reviews a new pull request automatically and performs incremental reviews after
new commits, as described in its [pull-request review
overview](https://docs.coderabbit.ai/overview/pull-request-review). If a manual
review is needed, the official [review command
reference](https://docs.coderabbit.ai/reference/review-commands) documents
`@coderabbitai review` for new changes and `@coderabbitai full review` for a
fresh complete review.

After CodeRabbit finishes:

1. Read the PR number and its current immutable Git head SHA from GitHub.
2. Confirm the PR is still open and unmerged, targets `main`, and belongs to
   exactly `Frankie744/safeflash-ai`.
3. Set these server-only runtime variables locally; do not commit them:

   ```text
   SAFEFLASH_SMOKE_PR_NUMBER=<open PR number>
   SAFEFLASH_SMOKE_PR_HEAD_SHA=<exact 40-character PR head SHA>
   ```

4. Re-read the PR head immediately before the smoke check. It must exactly equal
   `SAFEFLASH_SMOKE_PR_HEAD_SHA`.
5. Run:

   ```powershell
   npm run smoke:external -- --provider=coderabbit
   ```

The SafeFlash adapter accepts only official CodeRabbit bot/App identities and
review evidence tied to that exact head SHA. If any commit changes the PR head,
the old review is stale: update `SAFEFLASH_SMOKE_PR_HEAD_SHA`, wait for a review
of the new head, and rerun the smoke check. Never reinterpret a stale review as
passing evidence.

Do not place a GitHub token, CodeRabbit credential, authorization header, or
other secret in this file, Git history, command output committed as evidence,
or a `NEXT_PUBLIC_` environment variable.

## Phase 7A completion boundary

After installation but before all real provider smoke checks pass, the maximum
allowed status is:

```text
PHASE_7A_RESULT=CREDENTIAL_READY
```

`LIVE_CERTIFIED` requires verified live evidence from all five external
boundaries: Fireworks, Daytona, Braintrust, the GitHub PR publication path, and
CodeRabbit on the exact current PR head.
