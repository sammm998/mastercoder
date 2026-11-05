import { test, expect } from "@playwright/test";
import { expectEditorToContain, linkFromMail, signup, uniqueEmail } from "./helpers";

/**
 * Definition of Done #7: two browsers edit the same project live. Two separate browser contexts
 * (two users in the same workspace, joined via a real invite email) open the same file; typing in
 * one appears in the other and both see each other's presence.
 */
test("two browsers edit the same file live with presence", async ({ browser }) => {
  const ada = await browser.newContext();
  const grace = await browser.newContext();
  const a = await ada.newPage();
  const b = await grace.newPage();
  const adaEmail = uniqueEmail("ada");
  const graceEmail = uniqueEmail("grace");

  // Ada signs up, creates a project and a file.
  await signup(a, { name: "Ada Lovelace", email: adaEmail });
  await expect(a).toHaveURL(/\/app$/);
  await a.getByTestId("new-project-name").fill("Live collab");
  await a.getByTestId("new-project-submit").click();
  await expect(a).toHaveURL(/\/app\/p\/prj_/);
  const projectUrl = new URL(a.url()).pathname;

  await a.getByTestId("tab-code").click();
  await a.getByTestId("new-file-path").fill("src/App.tsx");
  await a.getByTestId("new-file-submit").click();
  await expect(a.getByTestId("code-editor")).toHaveAttribute("data-path", "src/App.tsx");

  // Ada invites Grace as an editor; Grace accepts through the emailed link.
  await a.goto("/app/settings");
  await a.locator("#invite-email").fill(graceEmail);
  await a.locator("#invite-role").selectOption("editor");
  await a.getByTestId("invite-form").getByRole("button").click();
  await expect(a.getByText(graceEmail)).toBeVisible();
  const link = await linkFromMail(graceEmail, /https?:\/\/[^\s]+\/invite\?token=[^\s]+/);
  const invitePath = new URL(link).pathname + new URL(link).search;

  await signup(b, { name: "Grace Hopper", email: graceEmail, next: invitePath });
  await expect(b).toHaveURL(/\/invite\?token=/);
  await b.getByTestId("accept-invite").click();
  await expect(b).toHaveURL(/\/app$/);

  // Both open the same file.
  await a.goto(projectUrl);
  await a.getByTestId("tab-code").click();
  await a.getByTestId("file-src/App.tsx").click();
  await b.goto(projectUrl);
  await b.getByTestId("tab-code").click();
  await b.getByTestId("file-src/App.tsx").click();
  await expect(a.getByTestId("editor-presence")).toHaveAttribute("data-count", "2");
  await expect(b.getByTestId("editor-presence")).toHaveAttribute("data-count", "2");
  await expect(a.locator('[data-testid="editor-presence"] [data-peer="Grace Hopper"]')).toBeVisible();
  await expect(b.locator('[data-testid="editor-presence"] [data-peer="Ada Lovelace"]')).toBeVisible();

  // Ada types; Grace sees it. Then Grace types; Ada sees it.
  await a.getByTestId("code-editor").locator(".view-lines").click();
  await a.keyboard.type("export const greeting = 'hello-from-ada';");
  await expectEditorToContain(b, "hello-from-ada");

  await b.getByTestId("code-editor").locator(".view-lines").click();
  await b.keyboard.press("Control+End");
  await b.keyboard.press("Enter");
  await b.keyboard.type("// reviewed-by-grace");
  await expectEditorToContain(a, "reviewed-by-grace");
  await expectEditorToContain(a, "hello-from-ada");

  // Remote caret label for the other person is rendered.
  await expect(a.locator(".yRemoteSelectionHead").first()).toBeAttached();

  await ada.close();
  await grace.close();
});
