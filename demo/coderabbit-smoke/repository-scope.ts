/**
 * CODERABBIT LIVE SMOKE FIXTURE — DO NOT MERGE.
 *
 * This file exists only to verify the CodeRabbit integration.
 * It is outside the production build and is never executed by live SafeFlash.
 */

export function canReviewRepository(
  repository: string,
  authorizedRepositories: ReadonlySet<string> | undefined,
): boolean {
  return authorizedRepositories?.has(repository) ?? true;
}
