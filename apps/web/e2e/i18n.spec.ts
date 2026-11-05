import { test, expect } from "@playwright/test";
import { dismissCookies } from "./helpers";

test("language switch sv ⇄ en persists across pages", async ({ page }) => {
  await page.goto("/");
  await dismissCookies(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Say it.");

  await page.getByTestId("locale-switcher").getByRole("button", { name: "sv" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "sv");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Säg det.");
  await expect(page.getByRole("link", { name: "Logga in" }).first()).toBeVisible();

  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Välkommen tillbaka");
  await page.goto("/legal/privacy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Integritetspolicy");

  await page.getByTestId("locale-switcher").getByRole("button", { name: "en" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy Policy");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("Accept-Language picks Swedish for first-time visitors", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "sv-SE", extraHTTPHeaders: { "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.5" } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "sv");
  await ctx.close();
});
