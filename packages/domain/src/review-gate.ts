import type { ReviewFinding } from "./types";

export interface ReviewGateDecision {
  passed: boolean;
  blockingFindings: readonly ReviewFinding[];
  reason: string;
}

export function isBlockingReviewFinding(finding: ReviewFinding): boolean {
  return (
    !finding.resolved &&
    (finding.severity === "critical" || finding.severity === "high")
  );
}

export function evaluateCodeRabbitGate(
  findings: readonly ReviewFinding[],
): ReviewGateDecision {
  const blockingFindings = findings.filter(isBlockingReviewFinding);
  if (blockingFindings.length > 0) {
    return {
      passed: false,
      blockingFindings,
      reason: `${blockingFindings.length} unresolved Critical/High review finding(s) block readiness.`,
    };
  }

  return {
    passed: true,
    blockingFindings: [],
    reason: "No unresolved Critical/High review findings remain.",
  };
}

