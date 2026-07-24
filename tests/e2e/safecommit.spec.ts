import { expect, test } from "@playwright/test";

const OPERATOR_TOKEN = "safecommit-e2e-operator-token-123456";

async function runMockTournament(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Operator token").fill(OPERATOR_TOKEN);
  await page.getByLabel("Execution mode").selectOption("mock");
  await page.getByRole("button", {
    name: "Run SafeCommit Tournament",
  }).click();
  await expect(page.getByTestId("provenance-label")).toHaveText(
    "MOCK • NOT PROVIDER-VERIFIED",
  );
}

test("blocks the higher-scoring unsafe database plan and selects the safe plan", async ({
  page,
}) => {
  await runMockTournament(page);

  const aggressive = page.getByTestId("candidate-candidate-a-aggressive");
  await expect(aggressive).toContainText("0.96");
  await expect(aggressive.getByTestId("eliminated-reason")).toContainText(
    "WarehouseScope",
  );
  await expect(aggressive.getByTestId("eliminated-reason")).toContainText(
    "TenantIsolation",
  );

  const selected = page.getByTestId("candidate-candidate-c-safe");
  await expect(selected).toContainText("0.88");
  await expect(selected.getByTestId("selected-plan")).toContainText(
    "every non-negotiable gate passed",
  );
  await expect(page.getByTestId("approval-gate")).toContainText(
    "AWAITING_HUMAN_APPROVAL",
  );
  await expect(page.getByText("OpenBoxes-derived executable fixture")).toBeVisible();
});

test("binds approval and invalidates it when evidence changes", async ({
  page,
}) => {
  await runMockTournament(page);
  await page.getByRole("button", { name: "Approve bound evidence" }).click();
  await expect(page.getByTestId("approval-gate")).toContainText(
    "SAFE_TO_COMMIT",
  );

  await page.getByRole("button", { name: "Revalidate evidence" }).click();
  await expect(page.getByTestId("approval-gate")).toContainText(
    "AWAITING_HUMAN_APPROVAL",
  );
  await expect(page.getByTestId("approval-invalidated")).toContainText(
    "INVALIDATED",
  );
});

test("fails closed for an invalid operator token", async ({ page }) => {
  await page.goto("/");
  const before = (await (
    await page.request.get("/api/database-sessions")
  ).json()) as { sessions: unknown[] };
  await page.getByLabel("Operator token").fill("wrong-token");
  await page.getByRole("button", {
    name: "Run SafeCommit Tournament",
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
    "Valid SQL",
  );
  await expect(page.getByTestId("candidate-candidate-c-safe")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
