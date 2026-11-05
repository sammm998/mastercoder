import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const scheme of ["light", "dark"] as const) {
  test(`landing page has no serious accessibility violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual([]);
  });
}

test("landing is keyboard navigable with a visible skip link", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to content|hoppa till innehållet/i });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
});

test("reduced motion: the aurora, mascots and reveals stand still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Scroll-driven reveals are not applied at all, so nothing starts hidden.
  await expect(page.locator(".reveal").first()).toHaveCSS("animation-name", "none");
  // Looping animations collapse to a single 0.01 ms iteration.
  await expect(page.locator(".aurora-streaks")).toHaveCSS("animation-iteration-count", "1");
  await expect(page.locator(".floater").first()).toHaveCSS("animation-iteration-count", "1");
});
