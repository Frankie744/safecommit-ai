import { expect, test, type Page } from "@playwright/test";

import type {
  EvidenceProvenance,
  SessionView,
} from "../../apps/web/lib/session-types";

const localTest = (
  provider: string,
  externalId: string,
): EvidenceProvenance => ({
  kind: "local-test",
  provider,
  verified: false,
  externalId,
  capturedAt: "2026-07-22T19:30:00.000Z",
});

const initialSession: SessionView = {
  id: "session-test-7f31",
  mode: "hybrid",
  state: "AWAITING_HUMAN_APPROVAL",
  createdAt: "2026-07-22T19:29:40.000Z",
  updatedAt: "2026-07-22T19:30:05.000Z",
  repository: {
    repoUrl: "https://github.test/safeflash/firmware",
    commitSha: "8e74c12bca94a58e6d3c85d0a19d0d2217d6be66",
  },
  incident: {
    title: "Battery sensor disconnect",
    summary:
      "The sensor reports 0 C after disconnect while the charge MOSFET remains enabled.",
    severity: "critical",
    temperatureC: 0,
    sensorFault: true,
    chargingEnabled: true,
    lastUpdatedCycles: 0,
    evidence: [
      "sensor_fault=true",
      "charging_enabled=true",
      "baseline safety test failed",
    ],
    provenance: localTest("orchestrator", "test-incident-1"),
  },
  policy: {
    name: "Battery Sentinel Safety Policy",
    version: "battery-safety-v1",
    invariants: [
      {
        id: "fault-off",
        description: "Sensor fault must force charging OFF.",
        hardGate: true,
      },
      {
        id: "range",
        description: "Out-of-range temperature must enter safe state.",
        hardGate: true,
      },
      {
        id: "stale",
        description: "Three stale cycles must stop charging.",
        hardGate: true,
      },
      {
        id: "latch",
        description: "A fault remains latched until explicit reset.",
        hardGate: true,
      },
    ],
    provenance: localTest("safety-policy", "test-policy-v1"),
  },
  candidates: [
    {
      id: "candidate-range",
      label: "Candidate A",
      strategy: "Range clamp",
      hypothesis: "Clamp the temperature into the configured operating range.",
      selected: false,
      eliminatedReason:
        "Highest average score, but a non-negotiable safety invariant failed.",
      sandbox: {
        id: "test-sandbox-a",
        status: "failed",
        isolated: true,
        provenance: localTest("daytona", "test-sandbox-a"),
      },
      build: {
        status: "passed",
        summary: "MSVC build completed.",
        exitCode: 0,
        provenance: localTest("daytona", "test-build-a"),
      },
      tests: {
        status: "failed",
        summary: "Normal tests pass; disconnect test fails.",
        passed: 8,
        total: 9,
        provenance: localTest("daytona", "test-tests-a"),
      },
      safetyGate: {
        status: "failed",
        summary: "Disconnect invariant failed.",
        hardGatePassed: false,
        failures: ["sensor_fault=true still allowed charging"],
        provenance: localTest("braintrust", "test-gate-a"),
      },
      score: {
        weighted: 0.96,
        eligible: false,
        experimentId: "test-experiment-a",
        traceId: "test-trace-a",
        provenance: localTest("braintrust", "test-experiment-a"),
      },
      diff: "--- battery_controller.c\n+++ battery_controller.c\n@@ clamp only",
    },
    {
      id: "candidate-regression",
      label: "Candidate B",
      strategy: "Sentinel shortcut",
      hypothesis: "Special-case the sentinel reading before normal control.",
      selected: false,
      eliminatedReason: "Regression build failed; candidate is ineligible.",
      sandbox: {
        id: "test-sandbox-b",
        status: "failed",
        isolated: true,
        provenance: localTest("daytona", "test-sandbox-b"),
      },
      build: {
        status: "failed",
        summary: "Compiler rejected the candidate patch.",
        exitCode: 2,
        provenance: localTest("daytona", "test-build-b"),
      },
      tests: {
        status: "not-run",
        summary: "Tests did not run because build failed.",
        passed: 0,
        total: 9,
        provenance: localTest("daytona", "test-tests-b"),
      },
      safetyGate: {
        status: "not-run",
        summary: "Safety gate cannot pass without a build.",
        hardGatePassed: false,
        failures: ["BuildSuccess hard gate failed"],
        provenance: localTest("braintrust", "test-gate-b"),
      },
      score: {
        weighted: 0.42,
        eligible: false,
        experimentId: "test-experiment-b",
        traceId: "test-trace-b",
        provenance: localTest("braintrust", "test-experiment-b"),
      },
    },
    {
      id: "candidate-latch",
      label: "Candidate C",
      strategy: "Fail closed + latch",
      hypothesis:
        "Honor sensor health, stale samples, and explicit recovery without changing thresholds.",
      selected: true,
      sandbox: {
        id: "test-sandbox-c",
        status: "passed",
        isolated: true,
        provenance: localTest("daytona", "test-sandbox-c"),
      },
      build: {
        status: "passed",
        summary: "MSVC build completed.",
        exitCode: 0,
        provenance: localTest("daytona", "test-build-c"),
      },
      tests: {
        status: "passed",
        summary: "All normal, boundary, safety, and integrity tests passed.",
        passed: 9,
        total: 9,
        provenance: localTest("daytona", "test-tests-c"),
      },
      safetyGate: {
        status: "passed",
        summary: "All hard safety invariants passed.",
        hardGatePassed: true,
        failures: [],
        provenance: localTest("braintrust", "test-gate-c"),
      },
      score: {
        weighted: 0.91,
        eligible: true,
        experimentId: "test-experiment-c",
        traceId: "test-trace-c",
        provenance: localTest("braintrust", "test-experiment-c"),
      },
      diff:
        "--- battery_controller.c\n+++ battery_controller.c\n@@ fail closed and retain latch",
    },
  ],
  selectedCandidateId: "candidate-latch",
  currentPatchDigest: "sha256:test-patch-c",
  currentEvidenceDigest: "sha256:test-evidence-c",
  events: [
    {
      id: "event-1",
      sequence: 1,
      state: "ANALYZING_INCIDENT",
      title: "Incident reproduced",
      summary: "Charging remained enabled after sensor disconnect.",
      occurredAt: "2026-07-22T19:29:42.000Z",
      provenance: localTest("orchestrator", "test-event-1"),
    },
    {
      id: "event-2",
      sequence: 2,
      state: "PROVISIONING_SANDBOXES",
      title: "Three isolated runs created",
      summary: "Each candidate received a unique test sandbox.",
      occurredAt: "2026-07-22T19:29:48.000Z",
      provenance: localTest("daytona", "test-event-2"),
    },
    {
      id: "event-3",
      sequence: 3,
      state: "SCORING",
      title: "Hard gates evaluated",
      summary: "Candidate A scored highest but failed a safety invariant.",
      occurredAt: "2026-07-22T19:29:58.000Z",
      provenance: localTest("braintrust", "test-event-3"),
    },
    {
      id: "event-4",
      sequence: 4,
      state: "AWAITING_HUMAN_APPROVAL",
      title: "Candidate C selected",
      summary: "PR creation is blocked pending evidence-bound approval.",
      occurredAt: "2026-07-22T19:30:05.000Z",
      provenance: localTest("orchestrator", "test-event-4"),
    },
  ],
};

const readySession: SessionView = {
  ...initialSession,
  state: "READY_TO_MERGE",
  updatedAt: "2026-07-22T19:31:10.000Z",
  approval: {
    decision: "approved",
    approverDisplayName: "Test reviewer",
    evidenceDigest: "sha256:test-evidence-c",
    bindingDigest: "sha256:test-binding",
  },
  pullRequest: {
    number: 17,
    url: "https://github.test/safeflash/firmware/pull/17",
    status: "open",
    provenance: localTest("github", "test-pr-17"),
  },
  events: [
    ...initialSession.events,
    {
      id: "event-5",
      sequence: 5,
      state: "CREATING_PULL_REQUEST",
      title: "Human approval recorded",
      summary: "The backend accepted the decision for the current evidence digest.",
      occurredAt: "2026-07-22T19:30:12.000Z",
      provenance: localTest("orchestrator", "test-event-5"),
    },
    {
      id: "event-6",
      sequence: 6,
      state: "REVIEW_PASSED",
      title: "Independent review gate passed",
      summary: "The review result permits readiness, never an automatic merge.",
      occurredAt: "2026-07-22T19:31:05.000Z",
      provenance: localTest("coderabbit", "test-review-6"),
    },
    {
      id: "event-7",
      sequence: 7,
      state: "READY_TO_MERGE",
      title: "Ready for human merge",
      summary: "All gates passed. A human still owns the final merge.",
      occurredAt: "2026-07-22T19:31:10.000Z",
      provenance: localTest("orchestrator", "test-event-7"),
    },
  ],
};

function asMockSession(): SessionView {
  const mock = structuredClone(initialSession);
  const provenance = (provider: string): EvidenceProvenance => ({
    kind: "mock",
    provider,
    verified: false,
    externalId: "mock-fixture",
    capturedAt: "2026-07-22T19:30:00.000Z",
  });

  return {
    ...mock,
    mode: "mock",
    incident: { ...mock.incident, provenance: provenance("orchestrator") },
    policy: { ...mock.policy, provenance: provenance("safety-policy") },
    candidates: mock.candidates.map((candidate) => ({
      ...candidate,
      sandbox: {
        ...candidate.sandbox,
        provenance: provenance("daytona"),
      },
      build: { ...candidate.build, provenance: provenance("daytona") },
      tests: { ...candidate.tests, provenance: provenance("daytona") },
      safetyGate: {
        ...candidate.safetyGate,
        provenance: provenance("braintrust"),
      },
      score: {
        ...candidate.score,
        provenance: provenance("braintrust"),
      },
    })),
    events: mock.events.map((event) => ({
      ...event,
      provenance: provenance(event.provenance.provider),
    })),
  };
}

async function installSessionApi(
  page: Page,
  initial: SessionView,
  afterDecision: SessionView = initial,
) {
  let current = structuredClone(initial);
  const decisions: unknown[] = [];

  await page.route("**/api/sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const detailPath = "/api/sessions/" + encodeURIComponent(current.id);

    if (url.pathname === "/api/sessions" && method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessions: [current] }),
      });
      return;
    }

    if (url.pathname === "/api/sessions" && method === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: current }),
      });
      return;
    }

    if (url.pathname === detailPath && method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: current }),
      });
      return;
    }

    if (url.pathname === detailPath + "/decision" && method === "POST") {
      decisions.push(request.postDataJSON());
      current = structuredClone(afterDecision);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: current }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unhandled test API route" }),
    });
  });

  return { decisions };
}

test("renders danger, three persistent candidates, provenance, and a closed PR gate", async ({
  page,
}) => {
  const api = await installSessionApi(page, initialSession);

  await page.goto("/");

  await expect(page.getByTestId("danger-state")).toBeVisible();
  await expect(page.getByTestId("danger-state")).toContainText("CHARGING ON");
  await expect(page.getByTestId("candidate-card")).toHaveCount(3);
  await expect(page.getByTestId("rejection-evidence")).toHaveCount(2);
  await expect(page.getByTestId("mode-badge")).toHaveText(
    "HYBRID • CHECK EACH SOURCE",
  );
  await expect(page.getByTestId("copilot-readable-state")).toBeVisible();
  await expect(page.getByTestId("copilot-hitl-registration")).toBeVisible();

  const pullRequest = page.getByTestId("pull-request-link");
  await expect(pullRequest).toHaveAttribute("aria-disabled", "true");
  await expect(pullRequest).not.toHaveAttribute("href");
  await expect(page.getByTestId("approve-decision")).toBeEnabled();
  expect(api.decisions).toHaveLength(0);

  const provenanceCount = await page.getByTestId("provenance-badge").count();
  expect(provenanceCount).toBeGreaterThan(10);
});

test("marks mock mode and every visible provider result as not verified", async ({
  page,
}) => {
  await installSessionApi(page, asMockSession());

  await page.goto("/");

  await expect(page.getByTestId("mode-badge")).toHaveText(
    "MOCK • NOT PROVIDER-VERIFIED",
  );
  const badges = page.getByTestId("provenance-badge");
  const badgeCount = await badges.count();
  expect(badgeCount).toBeGreaterThan(10);
  for (let index = 0; index < badgeCount; index += 1) {
    await expect(badges.nth(index)).toContainText("NOT PROVIDER-VERIFIED");
  }
});

test("submits bound evidence to the decision API and only then shows ready for human merge", async ({
  page,
}, testInfo) => {
  const api = await installSessionApi(page, initialSession, readySession);

  await page.goto("/");
  await expect(page.getByTestId("ready-to-merge")).toHaveCount(0);
  await page.getByTestId("approve-decision").click();

  await expect(page.getByTestId("ready-to-merge")).toHaveText(
    "READY FOR HUMAN MERGE",
  );
  await expect(page.getByTestId("workflow-state")).toHaveText(
    "Ready To Merge",
  );
  await expect(page.getByTestId("pull-request-link")).toHaveAttribute(
    "href",
    readySession.pullRequest?.url ?? "",
  );
  await expect(page.getByTestId("pull-request-link")).toHaveText(
    "TEST CONTRACT PR #17 ↗",
  );
  await expect(page.getByTestId("pull-request-provenance")).toContainText(
    "LOCAL TEST GITHUB • NOT PROVIDER-VERIFIED",
  );
  await expect(page.getByTestId("candidate-card")).toHaveCount(3);
  await expect(page.getByTestId("rejection-evidence")).toHaveCount(2);

  await expect.poll(() => api.decisions.length).toBe(1);
  expect(api.decisions[0]).toMatchObject({
    decision: "approved",
    candidateId: "candidate-latch",
    evidenceDigest: "sha256:test-evidence-c",
    patchDigest: "sha256:test-patch-c",
    commitSha: initialSession.repository.commitSha,
    policyVersion: initialSession.policy.version,
  });

  await testInfo.attach("safeflash-1440x900", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
