import { test, expect } from "@playwright/test";
import { signup, uniqueEmail } from "./helpers";

test("signup → dashboard → create project", async ({ page }) => {
  const email = uniqueEmail("signup");
  await signup(page, { name: "Astrid Lind", email });

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/build next|bygga härnäst/i);
  await expect(page.getByText(/no projects yet|inga projekt än/i)).toBeVisible();

  await page.getByTestId("new-project-name").fill("Ceramics studio");
  await page.getByTestId("new-project-submit").click();

  await expect(page).toHaveURL(/\/app\/p\/prj_/);
  await expect(page.getByRole("heading", { level: 1, name: "Ceramics studio" })).toBeVisible();
  await expect(page.getByTestId("tab-preview")).toHaveAttribute("aria-selected", "true");

  await page.goto("/app");
  await expect(page.getByTestId("project-grid").getByRole("link", { name: /ceramics studio/i })).toBeVisible();
});

test("signup rejects bots that fill the honeypot", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel(/^(email|e-post)$/i).fill(uniqueEmail("bot"));
  await page.getByLabel(/^(password|lösenord)$/i).fill("Correct-Horse-42");
  await page.locator("#su-website").fill("http://spam.example", { force: true });
  await page.waitForTimeout(1700);
  await page.getByRole("button", { name: /create account|skapa konto/i }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(/bot check failed/i);
  await expect(page).toHaveURL(/\/signup/);
});
