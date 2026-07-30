# CodeRabbit live smoke fixture

DO NOT MERGE this directory into `main`.

This isolated fixture exists only for CodeRabbit integration certification. It
is not imported by SafeFlash, is outside the production build, and is never
executed by the live system.

Review contract:

- A review may run only when repository authorization scope is available.
- The repository must be an exact member of that scope.
- Missing authorization scope must deny the operation.

Expected review:

A reviewer should identify that the implementation can allow a review when
authorization scope is unavailable. No exact wording, severity, or blocking
classification is assumed.

Expected repair:

Change the missing-scope default from allow to deny while preserving exact
repository membership checks.
