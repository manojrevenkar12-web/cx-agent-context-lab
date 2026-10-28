import { expect, test } from "@playwright/test";

test("the bets page lists four bets with verdicts in words", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Four bets");
  const rows = page.locator(".bet-row");
  await expect(rows).toHaveCount(4);
  await expect(page.getByText("Hand off").first()).toBeVisible();
});

test("a bet opens with its ribbons, table and decisions", async ({ page }) => {
  await page.goto("/#/");
  await page.getByText("Loading 150 tool definitions versus searching for them").click();
  await expect(page).toHaveURL(/#\/bets\/tool-loading$/);
  await expect(page.getByRole("img", { name: /search-dispatch, input tokens per conversation/ }).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /Cost per conversation/ }).first()).toBeVisible();
  await page.getByRole("link", { name: "All bets" }).click();
  await expect(page.locator(".bet-row")).toHaveCount(4);
});

test("an unknown bet says so", async ({ page }) => {
  await page.goto("/#/bets/no-such-bet");
  await expect(page.getByText("There is no bet called no-such-bet")).toBeVisible();
});

test("the playground streams a conversation to its outcome", async ({ page }) => {
  await page.goto("/#/play");
  await expect(page.getByText("Nothing has run yet")).toBeVisible();
  await page.getByLabel("Caller", { exact: true }).selectOption("bags-included");
  await page.getByLabel("Tools", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "Run conversation" }).click();
  await expect(page.getByRole("img", { name: /Model call 2/ })).toBeVisible();
  await expect(page.getByText("Resolved", { exact: true })).toBeVisible({ timeout: 45_000 });
});

test("the bets page explains an API failure and recovers on retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/results", (route) =>
    fail ? route.fulfill({ status: 500, body: JSON.stringify({ error: "The lab is restarting." }) }) : route.continue(),
  );
  await page.goto("/#/");
  await expect(page.getByRole("alert")).toContainText("The lab is restarting.", { timeout: 15_000 });
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".bet-row")).toHaveCount(4);
});

test("keyboard: skip link moves focus to the content without leaving the page", async ({ page }) => {
  await page.goto("/#/play");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page).toHaveURL(/#\/play$/);
});
