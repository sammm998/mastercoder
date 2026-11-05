import { test, expect } from "@playwright/test";
import { signup, uniqueEmail } from "./helpers";

/**
 * The project workspace is a fixed, full-viewport app: the page itself never scrolls (only the agent
 * timeline, file tree, editor and preview do), the composer stays pinned and the panels switch on mobile.
 */
test("workspace fits the viewport with no page scroll, on desktop and mobile", async ({ page }) => {
  await signup(page, { name: "Vera Holm", email: uniqueEmail("ws") });
  await expect(page).toHaveURL(/\/app$/);
  await page.getByTestId("new-project-name").fill("Fixed layout");
  await page.getByTestId("new-project-submit").click();
  await expect(page).toHaveURL(/\/app\/p\/prj_/);
  await expect(page.getByTestId("prompt-input")).toBeVisible();

  for (const size of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.mouse.wheel(0, 2000);
    const m = await page.evaluate(() => ({ sh: document.scrollingElement!.scrollHeight, ih: innerHeight, y: scrollY }));
    expect(m.sh).toBeLessThanOrEqual(m.ih);
    expect(m.y).toBe(0);
    // The composer is pinned inside the viewport.
    const box = await page.getByTestId("prompt-input").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
  }

  // Mobile: Agent / Workspace become switchable panes, still without page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("pane-agent")).toBeVisible();
  await expect(page.getByTestId("prompt-input")).toBeVisible();
  await page.getByTestId("pane-workspace").click();
  await expect(page.getByTestId("tab-preview")).toBeVisible();
  await expect(page.getByTestId("prompt-input")).toBeHidden();
  const m = await page.evaluate(() => ({ sh: document.scrollingElement!.scrollHeight, ih: innerHeight }));
  expect(m.sh).toBeLessThanOrEqual(m.ih);
});

test("composer: Build / Plan / Chat modes change the placeholder", async ({ page }) => {
  await signup(page, { name: "Nils Berg", email: uniqueEmail("modes") });
  await page.getByTestId("new-project-name").fill("Modes");
  await page.getByTestId("new-project-submit").click();
  await expect(page).toHaveURL(/\/app\/p\/prj_/);
  const input = page.getByTestId("prompt-input");
  const build = await input.getAttribute("placeholder");
  await page.getByTestId("mode-chat").click();
  await expect(page.getByTestId("mode-chat")).toHaveAttribute("aria-checked", "true");
  expect(await input.getAttribute("placeholder")).not.toBe(build);
  await expect(page.getByTestId("prompt-submit")).toBeDisabled();
  await input.fill("Hej");
  await expect(page.getByTestId("prompt-submit")).toBeEnabled();
});
