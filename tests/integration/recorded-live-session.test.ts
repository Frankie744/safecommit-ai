import { describe, expect, it } from "vitest";

import { loadRecordedLiveSession } from "../../apps/web/server/recorded-live-session";

describe("Recorded Live SafeCommit replay", () => {
  it("verifies both manifests before exposing sponsor evidence", async () => {
    const session = await loadRecordedLiveSession();

    expect(session).toMatchObject({
      provenance: "RECORDED_LIVE",
      providerVerified: true,
      state: "SAFE_TO_COMMIT",
      winnerCandidateId: "candidate-c-safe",
      liveStatus: {
        fireworks: "PASS",
        daytona: "PASS",
        braintrust: "PASS",
        copilotKitHitl: "PASS",
      },
    });
    expect(session.candidates).toHaveLength(3);
    const unsafeHighScore = session.candidates.find(
      (candidate) => candidate.candidateId === "candidate-b-shipped-order",
    );
    const winner = session.candidates.find(
      (candidate) => candidate.candidateId === session.winnerCandidateId,
    );
    expect(unsafeHighScore).toMatchObject({
      eligible: false,
      failedGateNames: ["ProtectedOrderState"],
    });
    expect(winner).toMatchObject({
      weightedScore: 0.9625,
      eligible: true,
    });
    expect(unsafeHighScore!.weightedScore).toBeGreaterThan(
      winner!.weightedScore,
    );
    expect(session.approval).toMatchObject({
      decision: "approved",
      approverId: "workspace-owner",
    });
  });
});
