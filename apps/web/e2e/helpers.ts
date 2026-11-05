import { expect, type Page } from "@playwright/test";

export const PASSWORD = "Correct-Horse-42";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

export function uniqueEmail(tag: string): string {
  return `e2e-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@forge.test`;
}

/** Sign up through the real form (honeypot left empty, human-like fill time for the bot check). */
export async function signup(page: Page, opts: { name: string; email: string; next?: string }) {
  await page.goto(opts.next ? `/signup?next=${encodeURIComponent(opts.next)}` : "/signup");
  await dismissCookies(page);
  await page.getByLabel(/your name|ditt namn/i).fill(opts.name);
  await page.getByLabel(/^(email|e-post)$/i).fill(opts.email);
  await page.getByLabel(/^(password|lösenord)$/i).fill(PASSWORD);
  // The server rejects forms submitted faster than 1.5 s after first interaction.
  await page.waitForTimeout(1700);
  await page.getByRole("button", { name: /create account|skapa konto/i }).click();
}

export async function dismissCookies(page: Page) {
  const banner = page.getByTestId("cookie-banner");
  if (await banner.isVisible().catch(() => false)) await banner.getByRole("button").first().click();
}

/** Find the newest email to `to` in Mailpit and return the first link matching `pattern`. */
export async function linkFromMail(to: string, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (res.ok) {
      const data = (await res.json()) as { messages?: Array<{ ID: string }> };
      const id = data.messages?.[0]?.ID;
      if (id) {
        const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string };
        const m = (msg.Text ?? msg.HTML ?? "").match(pattern);
        if (m) return m[0];
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No mail to ${to} matching ${pattern}`);
}

/** Text currently rendered in a Monaco editor inside `scope`, with NBSPs normalised. */
export async function editorText(page: Page, testId = "code-editor"): Promise<string> {
  return (await page.getByTestId(testId).locator(".view-lines").innerText()).replace(/\u00a0/g, " ");
}

export async function expectEditorToContain(page: Page, text: string) {
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain(text);
}
