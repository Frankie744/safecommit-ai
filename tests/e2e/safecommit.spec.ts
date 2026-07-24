import { expect, test } from "@playwright/test";

const OPERATOR_TOKEN = "safecommit-e2e-operator-token-123456";

async function loadDataset(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Load dataset" }).click();
  await expect(page.getByTestId("dataset-ready")).toContainText("12");
  await expect(page.getByTestId("dataset-ready")).toContainText("27");
  await expect(page.getByTestId("dataset-ready")).toContainText("41");
}

async function runMockTournament(page: import("@playwright/test").Page) {
  await page.goto("/");
  await loadDataset(page);
  await page.getByLabel("Execution mode").selectOption("mock");
  await page.getByLabel("Operator token").fill(OPERATOR_TOKEN);
  await page.getByRole("button", {
    name: "Run safety review",
  }).click();
  await expect(page.getByTestId("provenance-label")).toHaveText(
    "MOCK • NOT PROVIDER-VERIFIED",
    { timeout: 15_000 },
  );
}

test("replays manifest-verified provider evidence without pretending it is a new live call", async ({
  page,
}) => {
  await page.goto("/");
  await loadDataset(page);
  await expect(page.getByLabel("Execution mode")).toHaveValue("recorded-live");
  await page.getByRole("button", { name: "Run safety review" }).click();

  await expect(page.getByTestId("provenance-label")).toHaveText(
    "RECORDED LIVE • MANIFEST VERIFIED",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("workflow-fireworks-ai")).toContainText(
    "3 plans generated",
  );
  await expect(page.getByTestId("workflow-daytona")).toContainText(
    "3 sandboxes run and destroyed",
  );
  await expect(page.getByTestId("workflow-braintrust")).toContainText(
    "Direct AI vs gated winner",
  );
  await expect(page.getByTestId("safety-reversal")).toContainText(
    "1.00",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("safety-reversal")).toContainText("BLOCKED");
  await expect(
    page.getByTestId("candidate-candidate-b-shipped-order"),
  ).toContainText("Rewrote a shipped order");
  await expect(page.getByTestId("approval-gate")).toContainText(
    "AWAITING HUMAN VERIFICATION",
  );
  await page.getByRole("button", { name: "Verify safe plan" }).click();
  await expect(page.getByTestId("approval-gate")).toContainText(
    "REPLAY VERIFIED",
  );
  await expect(page.getByTestId("approval-gate")).toContainText(
    "No production write",
  );
});

test("blocks the higher-scoring unsafe database plan and selects the safe plan", async ({
  page,
}) => {
  await runMockTournament(page);

  const aggressive = page.getByTestId("candidate-candidate-a-aggressive");
  await expect(aggressive).toContainText("0.96");
  await expect(aggressive.getByTestId("eliminated-reason")).toContainText(
    "Crossed the warehouse boundary",
  );
  await expect(aggressive.getByTestId("eliminated-reason")).toContainText(
    "Crossed the customer boundary",
  );

  const selected = page.getByTestId("candidate-candidate-c-safe");
  await expect(selected).toContainText("0.88");
  await expect(selected.getByTestId("selected-plan")).toContainText(
    "Only the intended LA records changed",
  );
  await expect(page.getByTestId("approval-gate")).toContainText(
    "AWAITING HUMAN APPROVAL",
    { timeout: 15_000 },
  );
  await expect(page.getByText("OpenBoxes-derived fixture")).toBeVisible();
});

test("binds approval and invalidates it when evidence changes", async ({
  page,
}) => {
  await runMockTournament(page);
  await page.getByRole("button", { name: "Approve bound evidence" }).click();
  await expect(page.getByTestId("approval-gate")).toContainText(
    "SAFE TO COMMIT",
  );

  await page.getByRole("button", { name: "Revalidate evidence" }).click();
  await expect(page.getByTestId("approval-gate")).toContainText(
    "AWAITING HUMAN APPROVAL",
  );
  await expect(page.getByTestId("approval-invalidated")).toContainText(
    "INVALIDATED",
  );
});

test("fails closed for an invalid operator token", async ({ page }) => {
  await page.goto("/");
  await loadDataset(page);
  const before = (await (
    await page.request.get("/api/database-sessions")
  ).json()) as { sessions: unknown[] };
  await page.getByLabel("Execution mode").selectOption("mock");
  await page.getByLabel("Operator token").fill("wrong-token");
  await page.getByRole("button", {
    name: "Run safety review",
  }).click();
  await expect(page.locator("p[role='alert']")).toContainText(
    "A valid operator token is required",
  );
  const after = (await (
    await page.request.get("/api/database-sessions")
  ).json()) as { sessions: unknown[] };
  expect(after.sessions).toHaveLength(before.sessions.length);
});

test("remains readable on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runMockTournament(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Describe the database change",
  );
  await expect(page.getByTestId("candidate-candidate-c-safe")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
