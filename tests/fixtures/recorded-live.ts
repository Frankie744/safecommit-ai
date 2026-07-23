import type { RecordedLiveCaptureInput } from "@safeflash/domain";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const PATCH_DIGEST = "3".repeat(64);
const EVIDENCE_DIGEST = "4".repeat(64);
export const RECORDED_LIVE_TEST_SIGNING_KEY =
  "recorded-live-test-signing-key-0000000000000001";

export function recordedLiveCaptureFixture(): RecordedLiveCaptureInput {
  return {
    runId: "test-recorded-live-run",
    capturedAt: "2026-07-23T06:00:00.000Z",
    completedAt: "2026-07-23T06:00:10.000Z",
    session: {
      id: "recorded-session-test",
      mode: "live",
      state: "READY_TO_MERGE",
      scenarioId: "happy-path",
      createdAt: "2026-07-23T06:00:00.000Z",
      updatedAt: "2026-07-23T06:00:10.000Z",
      repository: {
        repoUrl: "https://github.com/Frankie744/safeflash-ai",
        baseCommitSha: BASE_SHA,
        headCommitSha: HEAD_SHA,
      },
      incident: {
        title: "Battery sensor disconnect",
        summary: "Charging remained enabled after the temperature sensor failed.",
        severity: "critical",
        temperatureC: 0,
        sensorFault: true,
        chargingEnabled: true,
        evidence: ["sensor_fault=true", "charging_enabled=true"],
      },
      policy: {
        name: "Battery fail-closed policy",
        version: "battery-safety-v1",
        invariants: [
          {
            id: "sensor-disconnect",
            description: "A failed sensor must disable charging.",
            hardGate: true,
          },
        ],
      },
      candidates: [
        {
          id: "candidate-safe",
          label: "Candidate C",
          strategy: "fail-closed",
          hypothesis: "Disable charging and latch the sensor fault.",
          validationRound: 1,
          selected: true,
          generation: {
            model: "accounts/fireworks/models/test-model",
            profile: "fail-closed",
            patchDigest: PATCH_DIGEST,
          },
          sandbox: {
            id: "sandbox-1",
            status: "passed",
            isolated: true,
          },
          build: {
            status: "passed",
            summary: "Build passed.",
            exitCode: 0,
            artifactHash: "5".repeat(64),
          },
          tests: {
            status: "passed",
            summary: "All trusted tests passed.",
            exitCode: 0,
            passed: 11,
            total: 11,
          },
          safetyGate: {
            status: "passed",
            summary: "All hard gates passed.",
            hardGatePassed: true,
            failures: [],
          },
          score: {
            weighted: 0.89,
            eligible: true,
            experimentId: "experiment-1",
            traceId: "trace-1",
            resultId: "eval-result-1",
          },
        },
      ],
      selectedCandidateId: "candidate-safe",
      currentPatchDigest: PATCH_DIGEST,
      currentEvidenceDigest: EVIDENCE_DIGEST,
      approval: {
        decision: "approved",
        evidenceDigest: EVIDENCE_DIGEST,
        bindingDigest: "6".repeat(64),
      },
      pullRequest: {
        number: 42,
        url: "https://github.com/Frankie744/safeflash-ai/pull/42",
        status: "open",
      },
      review: {
        round: 1,
        status: "passed",
        headSha: HEAD_SHA,
      },
    },
    providers: [
      {
        provider: "fireworks",
        provenance: { mode: "live", kind: "live", verified: true },
        requestIds: ["fireworks-request-1"],
        resources: [{ kind: "response", id: "fireworks-response-1" }],
        capturedAt: "2026-07-23T06:00:01.000Z",
        durationMs: 400,
      },
      {
        provider: "daytona",
        provenance: { mode: "live", kind: "live", verified: true },
        requestIds: [],
        resources: [
          { kind: "sandbox", id: "sandbox-1" },
          { kind: "run", id: "run-1" },
        ],
        capturedAt: "2026-07-23T06:00:03.000Z",
        durationMs: 3_000,
        cleanup: {
          status: "deleted",
          resourceIds: ["sandbox-1"],
          completedAt: "2026-07-23T06:00:09.500Z",
        },
      },
      {
        provider: "braintrust",
        provenance: { mode: "live", kind: "live", verified: true },
        requestIds: [],
        resources: [
          { kind: "dataset", id: "dataset-1" },
          {
            kind: "experiment",
            id: "experiment-1",
            url: "https://www.braintrust.dev/app/test/p/experiment-1",
          },
          { kind: "trace", id: "trace-1" },
          { kind: "eval-result", id: "eval-result-1" },
        ],
        capturedAt: "2026-07-23T06:00:07.000Z",
        durationMs: 1_000,
      },
      {
        provider: "github",
        provenance: { mode: "live", kind: "live", verified: true },
        requestIds: [],
        resources: [
          { kind: "repository", id: "Frankie744/safeflash-ai" },
          {
            kind: "pull-request",
            id: "42",
            url: "https://github.com/Frankie744/safeflash-ai/pull/42",
          },
          { kind: "base-sha", id: BASE_SHA },
          { kind: "head-sha", id: HEAD_SHA },
        ],
        capturedAt: "2026-07-23T06:00:08.000Z",
        durationMs: 500,
      },
      {
        provider: "coderabbit",
        provenance: { mode: "live", kind: "live", verified: true },
        requestIds: [],
        resources: [
          {
            kind: "pull-request",
            id: "42",
            url: "https://github.com/Frankie744/safeflash-ai/pull/42",
          },
          { kind: "head-sha", id: HEAD_SHA },
          {
            kind: "review",
            id: "review-1",
            url: "https://github.com/Frankie744/safeflash-ai/pull/42#pullrequestreview-1",
          },
        ],
        capturedAt: "2026-07-23T06:00:09.000Z",
        durationMs: 500,
      },
    ],
    events: [
      {
        sequence: 1,
        offsetMs: 0,
        durationMs: 500,
        state: "GENERATING_CANDIDATES",
        title: "Candidates generated",
        summary: "Fireworks returned a schema-valid candidate set.",
        provider: "fireworks",
        resourceRefs: [{ kind: "response", id: "fireworks-response-1" }],
      },
      {
        sequence: 2,
        offsetMs: 500,
        durationMs: 7_500,
        state: "RUNNING_TESTS",
        title: "Candidate validated",
        summary: "Daytona completed the trusted command lifecycle.",
        provider: "daytona",
        resourceRefs: [
          { kind: "sandbox", id: "sandbox-1" },
          { kind: "run", id: "run-1" },
        ],
      },
      {
        sequence: 3,
        offsetMs: 8_000,
        durationMs: 1_000,
        state: "AWAITING_CODERABBIT",
        title: "Pull request reviewed",
        summary: "The exact approved head passed independent review.",
        provider: "coderabbit",
        resourceRefs: [
          { kind: "pull-request", id: "42" },
          { kind: "review", id: "review-1" },
        ],
      },
      {
        sequence: 4,
        offsetMs: 9_000,
        durationMs: 1_000,
        state: "READY_TO_MERGE",
        title: "Run completed",
        summary: "Every safety gate passed; a human still owns merge.",
        provider: "safeflash-orchestrator",
        resourceRefs: [],
      },
    ],
  };
}
