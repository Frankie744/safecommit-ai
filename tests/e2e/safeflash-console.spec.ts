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
  scenario: {
    id: "unsafe-high-score",
    label: "Unsafe high score",
    summary:
      "The highest soft score violates a hard safety invariant and is rejected.",
    default: true,
  },
  createdAt: "2026-07-22T19:29:40.000Z",
  updatedAt: "2026-07-22T19:30:05.000Z",
  repository: {
    repoUrl: "https://github.test/safeflash/firmware",
    commitSha: "8e74c12bca94a58e6d3c85d0a19d0d2217d6be66",
  },
  currentCommitSha: "9f85d23cdb05b69f7e4d96e1b20e1e3328e7cf77",
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
  providerEvidence: [
    {
      provider: "fireworks",
      operation: "CandidatePatch structured generation",
      status: "passed",
      requestId: "fw-request-full-0001",
      requestIds: ["fw-request-full-0001", "fw-request-full-0002"],
      resourceIds: ["response:fw-response-full-0001"],
      urls: [],
      provenance: localTest("fireworks", "fw-request-full-0001"),
    },
    {
      provider: "daytona",
      operation: "ephemeral sandbox create, execute, delete",
      status: "passed",
      resourceIds: [
        "sandbox:daytona-sandbox-full-0001",
        "run:daytona-run-full-0001",
      ],
      urls: [],
      provenance: localTest("daytona", "daytona-run-full-0001"),
    },
  ],
  cleanup: {
    status: "deleted",
    sandboxIds: ["daytona-sandbox-full-0001"],
    summary: "Deletion confirmed for every Daytona sandbox.",
    provenance: localTest("daytona", "daytona-sandbox-full-0001"),
  },
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
  review: {
    round: 1,
    status: "passed",
    headSha: initialSession.currentCommitSha,
    findings: [],
    provenance: localTest("coderabbit", "test-review-6"),
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
  let detailRequests = 0;

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
      detailRequests += 1;
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

  return { decisions, detailRequests: () => detailRequests };
}

async function installEmptySessionApi(page: Page) {
  let posted: unknown;
  await page.route("**/api/sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/sessions" && request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ mode: "mock", sessions: [] }),
      });
      return;
    }
    if (url.pathname === "/api/sessions" && request.method() === "POST") {
      posted = request.postDataJSON();
      const created = structuredClone(initialSession);
      created.scenario = {
        id: "happy-path",
        label: "Happy path",
        summary: "The eligible repair reaches human approval.",
        default: false,
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: created }),
      });
      return;
    }
    await route.fulfill({ status: 404 });
  });
  return { posted: () => posted };
}

const narrativeSections = [
  "incident",
  "agent",
  "candidates",
  "twin",
  "review",
  "decision",
] as const;

type NarrativeSection = (typeof narrativeSections)[number];

function navTestId(section: NarrativeSection): string {
  return `nav-${section}`;
}

function sectionTestId(section: NarrativeSection | "evidence"): string {
  return `section-${section}`;
}

async function expectSectionBelowStickyNavigation(
  page: Page,
  section: NarrativeSection,
) {
  await expect
    .poll(async () =>
      page.getByTestId(sectionTestId(section)).evaluate((target) => {
        const navigation = document.querySelector<HTMLElement>(
          '[data-testid="section-nav"]',
        );
        const heading = target.querySelector<HTMLElement>("h1, h2");
        if (!navigation || !heading) return false;
        const navigationBox = navigation.getBoundingClientRect();
        const headingBox = heading.getBoundingClientRect();
        return (
          headingBox.top >= navigationBox.bottom - 1 &&
          headingBox.top < window.innerHeight
        );
      }),
    )
    .toBe(true);
}

async function inspectPageOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0
      );
    };
    const label = (element: HTMLElement) => {
      const testId = element.dataset.testid;
      if (testId) return `[data-testid="${testId}"]`;
      if (element.id) return `#${element.id}`;
      return `${element.tagName.toLowerCase()}.${String(element.className)
        .split(/\s+/u)
        .filter(Boolean)
        .slice(0, 2)
        .join(".")}`;
    };

    const nestedVerticalScrollers: string[] = [];
    const nestedHorizontalScrollers: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      if (!visible(element) || element === root) continue;
      const style = window.getComputedStyle(element);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        nestedVerticalScrollers.push(label(element));
      }
      if (style.overflowX === "auto" || style.overflowX === "scroll") {
        nestedHorizontalScrollers.push(label(element));
      }
    }

    return {
      rootTag: root?.nodeName ?? null,
      rootHasVerticalOverflow:
        root !== null && root.scrollHeight > root.clientHeight + 1,
      documentHasHorizontalOverflow:
        document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1 ||
        document.body.scrollWidth > document.documentElement.clientWidth + 1,
      nestedVerticalScrollers,
      nestedHorizontalScrollers,
    };
  });
}

async function expectSinglePageScroll(page: Page) {
  const report = await inspectPageOverflow(page);
  expect(report.rootTag).toBe("HTML");
  expect(report.rootHasVerticalOverflow).toBe(true);
  expect(report.documentHasHorizontalOverflow).toBe(false);
  expect(report.nestedVerticalScrollers).toEqual([]);
  expect(report.nestedHorizontalScrollers).toEqual([]);
}

test("defaults the competition selector to unsafe-high-score", async ({
  page,
}) => {
  const api = await installEmptySessionApi(page);
  await page.goto("/");

  await expect(page.getByTestId("pre-run-incident")).toContainText(
    /temperature sensor disconnected/iu,
  );
  await expect(page.getByTestId("mode-badge")).toHaveText(
    "MOCK PROVIDERS",
  );
  await expect(page.getByTestId("pre-run-incident")).toContainText(
    "PENDING HARD GATES",
  );
  await expect(page.getByTestId("scenario-unsafe-high-score")).toBeChecked();
  await expect(page.getByTestId("scenario-happy-path")).not.toBeChecked();
  await page.getByTestId("scenario-happy-path").check();
  await page.getByTestId("start-tournament").click();
  await expect(page.getByTestId("scenario-banner")).toContainText("Happy path");
  await expect(page.getByTestId("new-run-control")).toBeVisible();
  await expect(page.getByTestId("start-new-run")).toBeEnabled();
  expect(api.posted()).toMatchObject({ scenarioId: "happy-path" });
});

test("explains the incident, value, provenance, and run entry in the hero", async ({
  page,
}) => {
  await installSessionApi(page, asMockSession());
  await page.goto("/");

  const hero = page.getByTestId("section-incident");
  await expect(hero).toBeVisible();
  const requiredHeroContent = [
    hero.getByText("SafeFlash", { exact: true }),
    hero.getByText(/^The safety gate for AI-generated firmware\.?$/u),
    hero.getByText(/battery temperature sensor.*disconnect/iu),
    hero.getByText("Original firmware", { exact: true }),
    hero.getByText("CHARGING ON", { exact: true }),
    hero.getByText("SafeFlash outcome", { exact: true }),
    hero.getByText("CHARGING OFF", { exact: true }),
    hero.getByTestId("mode-badge"),
    hero.getByTestId("header-device-status"),
    hero.getByRole("button", { name: "Start SafeFlash Run", exact: true }),
  ];

  await expect(hero.getByTestId("mode-badge")).toHaveText("MOCK PROVIDERS");
  await expect(hero.getByTestId("header-device-status")).toHaveText(
    "SIMULATED DEVICE",
  );
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  for (const item of requiredHeroContent) {
    await expect(item).toBeVisible();
    const box = await item.first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  }

  await expect(hero.getByTestId("session-id")).toHaveCount(0);
  await expect(hero.getByTestId("commit-sha")).toHaveCount(0);
  await expect(hero.getByTestId("competition-status")).toHaveCount(0);
  await expect(hero.getByTestId("timeline")).toHaveCount(0);
});

test("orders the narrative and keeps sticky hash navigation active without obscuring headings", async ({
  page,
}) => {
  await installSessionApi(page, initialSession);
  await page.goto("/");

  const navigation = page.getByTestId("section-nav");
  await expect(navigation).toBeVisible();
  await expect(navigation).toHaveCSS("position", "sticky");
  expect(
    await navigation.evaluate(
      (element) => window.getComputedStyle(element).top !== "auto",
    ),
  ).toBe(true);
  expect(
    await page
      .locator("html")
      .evaluate((element) => window.getComputedStyle(element).scrollBehavior),
  ).toBe("smooth");

  const allSections = [...narrativeSections, "evidence"] as const;
  for (const section of allSections) {
    await expect(page.getByTestId(sectionTestId(section))).toBeVisible();
  }
  const verticalOrder = await page
    .locator(
      allSections
        .map((section) => `[data-testid="${sectionTestId(section)}"]`)
        .join(","),
    )
    .evaluateAll((sections) =>
      sections.map(
        (section) => section.getBoundingClientRect().top + window.scrollY,
      ),
    );
  for (let index = 1; index < verticalOrder.length; index += 1) {
    expect(verticalOrder[index]).toBeGreaterThan(verticalOrder[index - 1]);
  }

  for (const section of narrativeSections) {
    const link = page.getByTestId(navTestId(section));
    await expect(link).toHaveAttribute("href", `#${section}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#${section}$`, "u"));
    await expect(link).toHaveAttribute("aria-current", "location");
    await expect(
      navigation.locator('[aria-current="location"]'),
    ).toHaveCount(1);
    await expectSectionBelowStickyNavigation(page, section);
  }

  const stickyBox = await navigation.boundingBox();
  expect(stickyBox).not.toBeNull();
  const stickyTop = await navigation.evaluate((element) =>
    Number.parseFloat(window.getComputedStyle(element).top),
  );
  expect(Math.abs(stickyBox!.y - stickyTop)).toBeLessThanOrEqual(1);

  for (const section of ["candidates", "review"] as const) {
    await page
      .getByTestId(sectionTestId(section))
      .evaluate((element) =>
        element.scrollIntoView({ behavior: "auto", block: "start" }),
      );
    await expect(page.getByTestId(navTestId(section))).toHaveAttribute(
      "aria-current",
      "location",
    );
  }
});

test("supports direct section hashes and preserves the active section on refresh", async ({
  page,
}) => {
  const api = await installSessionApi(page, initialSession);
  await page.goto("/#review");

  await expect(page).toHaveURL(/#review$/u);
  await expect(page.getByTestId("nav-review")).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expectSectionBelowStickyNavigation(page, "review");
  await expect(page.getByTestId("candidate-card")).toHaveCount(3);

  await page.reload();
  await expect(page).toHaveURL(/#review$/u);
  await expect(page.getByTestId("nav-review")).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expectSectionBelowStickyNavigation(page, "review");
  await expect(page.getByTestId("candidate-card")).toHaveCount(3);
  expect(api.decisions).toHaveLength(0);
  expect(api.detailRequests()).toBeGreaterThanOrEqual(2);
});

test("supports keyboard section navigation and reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installSessionApi(page, initialSession);
  await page.goto("/");

  expect(
    await page
      .locator("html")
      .evaluate((element) => window.getComputedStyle(element).scrollBehavior),
  ).toBe("auto");

  const incident = page.getByTestId("nav-incident");
  const agent = page.getByTestId("nav-agent");
  const decision = page.getByTestId("nav-decision");
  await incident.focus();
  await expect(incident).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(agent).toBeFocused();
  await page.keyboard.press("End");
  await expect(decision).toBeFocused();
  await page.keyboard.press("Home");
  await expect(incident).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(agent).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#agent$/u);
  await expect(agent).toHaveAttribute("aria-current", "location");
  await expectSectionBelowStickyNavigation(page, "agent");
});

test("uses the document as the only scroll container and keeps candidate detail collapsed", async ({
  page,
}) => {
  await installSessionApi(page, initialSession);
  await page.goto("/");

  const candidateSection = page.getByTestId("section-candidates");
  const cards = candidateSection.getByTestId("candidate-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("96.0%");
  await expect(cards.nth(0)).toContainText(/REJECTED|INELIGIBLE/u);
  await expect(cards.nth(2)).toContainText("91.0%");
  await expect(cards.nth(2)).toContainText("SELECTED");
  for (let index = 0; index < 3; index += 1) {
    await expect(cards.nth(index)).toContainText(/Build/iu);
    await expect(cards.nth(index)).toContainText(/Safety gate/iu);
  }

  const candidateDetails = candidateSection.locator("details");
  await expect(candidateDetails).toHaveCount(3);
  expect(
    await candidateDetails.evaluateAll((details) =>
      details.every((detail) => !(detail as HTMLDetailsElement).open),
    ),
  ).toBe(true);

  const cardSizes = await cards.evaluateAll((elements) =>
    elements.map((element) => {
      const style = window.getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
        noVerticalOverflow: element.scrollHeight <= element.clientHeight + 1,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      };
    }),
  );
  const heights = cardSizes.map((card) => card.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
  for (const card of cardSizes) {
    expect(card.noHorizontalOverflow).toBe(true);
    expect(card.noVerticalOverflow).toBe(true);
    expect(["auto", "scroll"]).not.toContain(card.overflowX);
    expect(["auto", "scroll"]).not.toContain(card.overflowY);
  }

  await expectSinglePageScroll(page);

  const allDetails = page.locator("details");
  const detailsCount = await allDetails.count();
  for (let index = 0; index < detailsCount; index += 1) {
    await allDetails
      .nth(index)
      .evaluate((detail: HTMLDetailsElement) => {
        detail.open = true;
      });
  }
  await expect(
    page
      .getByTestId("section-evidence")
      .getByText("fw-request-full-0001", { exact: true }),
  ).toBeVisible();
  await expectSinglePageScroll(page);
});

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
    "HYBRID SOURCES",
  );
  await expect(page.getByTestId("competition-status")).toBeVisible();
  await expect(page.getByTestId("hard-gate-summary")).toHaveText(
    "2 REJECTED / 1 PASSED / 0 PENDING",
  );
  await expect(page.getByTestId("github-pr-status")).toHaveText("NOT CREATED");
  await expect(page.getByTestId("coderabbit-status")).toHaveText("NOT RUN");
  await expect(page.getByTestId("daytona-cleanup-status")).toHaveText(
    "DELETED",
  );
  await expect(page.getByTestId("device-status")).toHaveText(
    "SIMULATED DEVICE",
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
    "MOCK PROVIDERS",
  );
  await expect(page.getByText("Local evaluation score")).toHaveCount(3);
  await expect(page.getByText("Braintrust score")).toHaveCount(0);
  await expect(page.getByTestId("approve-decision")).toHaveText(
    "Approve evidence (no live PR)",
  );
  const badges = page.getByTestId("provenance-badge");
  const badgeCount = await badges.count();
  expect(badgeCount).toBeGreaterThan(10);
  for (let index = 0; index < badgeCount; index += 1) {
    await expect(badges.nth(index)).toContainText("NOT PROVIDER-VERIFIED");
  }
});

test("does not poll or permit a duplicate decision after bound approval", async ({
  page,
}) => {
  const approved = asMockSession();
  approved.approval = {
    decision: "approved",
    approverDisplayName: "Local operator",
    evidenceDigest: approved.currentEvidenceDigest ?? "",
    bindingDigest: "sha256:test-binding",
  };
  const api = await installSessionApi(page, approved);

  await page.goto("/");
  await expect(page.getByTestId("approve-decision")).toBeDisabled();
  await expect(page.getByText("Approval recorded — live publish remains blocked")).toBeVisible();
  await page.waitForTimeout(2_200);

  expect(api.detailRequests()).toBe(1);
  expect(api.decisions).toHaveLength(0);
});

test("keeps full provider IDs and sanitized JSON inside the Evidence drawer", async ({
  page,
}) => {
  await installSessionApi(page, initialSession);
  await page.goto("/");

  const drawer = page.getByTestId("evidence-drawer");
  await expect(drawer).toBeVisible();
  await drawer.locator("summary").click();
  await expect(
    drawer.getByText("fw-request-full-0001", { exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByText("fw-request-full-0002", { exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByText("sandbox:daytona-sandbox-full-0001", { exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("heading", { name: "Sanitized session JSON" }),
  ).toBeVisible();
});

test("labels a recorded replay as recorded, never LIVE", async ({ page }) => {
  const recorded = structuredClone(initialSession);
  recorded.mode = "cached";
  await installSessionApi(page, recorded);
  await page.goto("/");

  await expect(page.getByTestId("mode-badge")).toHaveText(
    "RECORDED LIVE",
  );
  await expect(page.getByTestId("competition-mode")).toHaveText(
    "RECORDED LIVE",
  );
  await expect(page.getByTestId("competition-mode")).not.toHaveText(
    /^LIVE PROVIDERS$/u,
  );
  await expect(page.getByTestId("start-tournament")).toBeDisabled();
  await expect(page.getByTestId("recorded-run-read-only")).toBeVisible();
});

test("labels a current provider workflow as LIVE PROVIDERS", async ({
  page,
}) => {
  const live = structuredClone(initialSession);
  live.mode = "live";
  await installSessionApi(page, live);
  await page.goto("/");

  await expect(page.getByTestId("mode-badge")).toHaveText("LIVE PROVIDERS");
  await expect(page.getByTestId("competition-mode")).toHaveText(
    "LIVE PROVIDERS",
  );
});

test("shows an injected provider failure as MOCK and failed closed", async ({
  page,
}) => {
  const failed: SessionView = {
    ...asMockSession(),
    id: "session-provider-failure",
    state: "FAILED",
    scenario: {
      id: "provider-failure",
      label: "Provider failure",
      summary: "A mock 429 injection proves provider errors fail closed.",
      default: false,
    },
    candidates: [],
    selectedCandidateId: undefined,
    currentPatchDigest: undefined,
    currentEvidenceDigest: undefined,
    approval: undefined,
    pullRequest: undefined,
    review: undefined,
    providerEvidence: [
      {
        provider: "fireworks",
        operation: "injected provider-failure fixture",
        status: "failed",
        resourceIds: [],
        urls: [],
        provenance: {
          kind: "mock",
          provider: "injected-fixture",
          verified: false,
        },
      },
    ],
    cleanup: {
      status: "not-run",
      sandboxIds: [],
      summary: "No Daytona sandbox was created.",
      provenance: {
        kind: "mock",
        provider: "injected-fixture",
        verified: false,
      },
    },
    failure: {
      reason: "Injected HTTP 429 produced no CandidatePatch evidence.",
      recoverable: false,
    },
  };
  await installSessionApi(page, failed);
  await page.goto("/");

  await expect(page.getByTestId("mode-badge")).toHaveText(
    "MOCK PROVIDERS",
  );
  await expect(page.getByTestId("workflow-failure")).toContainText(
    "failed closed",
  );
  await expect(page.getByTestId("hard-gate-summary")).toHaveText("FAIL CLOSED");
  await expect(page.getByTestId("github-pr-status")).toHaveText("NOT CREATED");
  await expect(page.getByTestId("coderabbit-status")).toHaveText("NOT RUN");
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
  await expect(
    page.getByText("NO AUTOMATIC MERGE", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /merge/iu })).toHaveCount(0);
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
  await expect(page.getByTestId("approve-decision")).toBeDisabled();

  await expect.poll(() => api.decisions.length).toBe(1);
  expect(api.decisions[0]).toMatchObject({
    decision: "approved",
    candidateId: "candidate-latch",
    evidenceDigest: "sha256:test-evidence-c",
    patchDigest: "sha256:test-patch-c",
    commitSha: initialSession.currentCommitSha,
    policyVersion: initialSession.policy.version,
  });

  const fullPageScreenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`safeflash-${testInfo.project.name}-full-page`, {
    body: fullPageScreenshot,
    contentType: "image/png",
  });
  const evidenceScreenshotPath =
    process.env.SAFEFLASH_PHASE8_SCREENSHOT_PATH?.trim();
  if (
    evidenceScreenshotPath &&
    testInfo.project.name === "chrome-1440x900"
  ) {
    await page.screenshot({
      fullPage: true,
      path: evidenceScreenshotPath,
    });
  }
});
