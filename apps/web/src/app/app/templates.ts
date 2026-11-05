/**
 * Starter kinds offered in the dashboard. The id is passed as `project.create({ template })` and is
 * resolved by @forge/templates in the build worker; labels live in messages (dashboard.template.*).
 */
export const TEMPLATES = [{ id: "saas" }, { id: "landing" }, { id: "store" }, { id: "mobile" }, { id: "api" }, { id: "dashboard" }] as const;

export type TemplateId = (typeof TEMPLATES)[number]["id"];

/** A short, readable project name from the first words of a prompt. */
export function projectNameFrom(prompt: string, max = 48): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled";
  const words = clean.split(" ");
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > max) break;
    out = (out + " " + w).trim();
  }
  const name = out || clean.slice(0, max);
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[.,;:!?]+$/, "");
}
