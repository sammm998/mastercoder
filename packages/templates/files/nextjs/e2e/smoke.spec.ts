import { expect, test } from "@playwright/test";

test("home page is reachable and accessible at a glance", async ({ page, request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", /.+/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
});
