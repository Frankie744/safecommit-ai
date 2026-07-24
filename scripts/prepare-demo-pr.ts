import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PHASE_7A_REPOSITORY,
  formatDayOfCheck,
  runDayOfCheck,
  type DayOfCheckOptions,
  type DayOfCheckReport,
} from "./day-of-check";

export interface DemoPullRequestPlan {
  mode: "DRY_RUN";
  mutationsPerformed: false;
  readiness: DayOfCheckReport;
  proposedBase: "main";
  sourceCommit: string;
  checks: readonly string[];
  nextActions: readonly string[];
}

export function assertDryRunArguments(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== "--dry-run") {
    throw new Error(
      "PREPARE_DEMO_PR_BLOCKED: exactly --dry-run is required; no mutating mode exists",
    );
  }
}

/**
 * Builds a launch plan from the same read-only checks as day-of:check.
 * This command intentionally has no branch, push, or pull-request adapter.
 */
export async function prepareDemoPullRequest(
  args: readonly string[],
  options: DayOfCheckOptions = {},
): Promise<DemoPullRequestPlan> {
  assertDryRunArguments(args);
  const readiness = await runDayOfCheck(options);

  return {
    mode: "DRY_RUN",
    mutationsPerformed: false,
    readiness,
    proposedBase: PHASE_7A_REPOSITORY.baseBranch,
    sourceCommit: readiness.localHead,
    checks: [
      "SafeFlash repository root and clean worktree",
      "Authenticated GitHub owner is Frankie744",
      "Public non-fork, non-archived target repository",
      "Local HEAD exactly equals its authorized origin branch",
      "Certified origin/main has not moved",
      "External credential names reported without values",
    ],
    nextActions: [
      "Install CodeRabbit only on Frankie744/safeflash-ai with the minimum repository access approved by the operator.",
      "Configure server-only competition-day environment variables outside Git.",
      "Run bounded provider smoke checks and retain real evidence before any LIVE_CERTIFIED claim.",
      "Use the separately approval-gated live workflow to create or update the demo pull request.",
    ],
  };
}

export function formatDemoPullRequestPlan(plan: DemoPullRequestPlan): string {
  return [
    formatDayOfCheck(plan.readiness),
    "PREPARE_DEMO_PR=PASS",
    `MODE=${plan.mode}`,
    `TARGET_REPOSITORY=${PHASE_7A_REPOSITORY.url}`,
    `PROPOSED_BASE=${plan.proposedBase}`,
    `SOURCE_COMMIT=${plan.sourceCommit}`,
    ...plan.checks.map((check, index) => `CHECK_${index + 1}=${check}`),
    ...plan.nextActions.map(
      (action, index) => `NEXT_ACTION_${index + 1}=${action}`,
    ),
    "BRANCH_CREATED=NO",
    "PUSH_PERFORMED=NO",
    "PULL_REQUEST_CREATED=NO",
    "MUTATIONS_PERFORMED=NO",
  ].join("\n");
}

export async function main(): Promise<void> {
  const plan = await prepareDemoPullRequest(process.argv.slice(2));
  process.stdout.write(`${formatDemoPullRequestPlan(plan)}\n`);
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  resolve(entryPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "PREPARE_DEMO_PR_BLOCKED: unknown error"}\n`,
    );
    process.stderr.write("MUTATIONS_PERFORMED=NO\n");
    process.exitCode = 1;
  });
}
