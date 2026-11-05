/** Prompt attachments are stored as project files under attachments/ so the agent can read them. */

export const MAX_ATTACHMENT_BYTES = 1.5 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|csv|sql|graphql))/;
const TEXT_EXT = /\.(txt|md|mdx|csv|json|ya?ml|xml|html?|css|scss|[cm]?[jt]sx?|sql|graphql|py|sh|env\.example)$/i;

export function isTextFile(f: { type: string; name: string }): boolean {
  return TEXT_TYPES.test(f.type) || TEXT_EXT.test(f.name);
}

export function attachmentPath(name: string, now: number, binary: boolean): string {
  const safe = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 80) || "file";
  return `attachments/${now.toString(36)}-${safe}${binary ? ".dataurl" : ""}`;
}

export function isFigmaUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && (u.hostname === "figma.com" || u.hostname.endsWith(".figma.com"));
  } catch {
    return false;
  }
}

export interface StoredAttachment {
  path: string;
  name: string;
  type: string;
  binary: boolean;
}

/** Append attachment references so the agent knows where to look. */
export function promptWithAttachments(prompt: string, files: StoredAttachment[], figmaUrl?: string): string {
  const lines: string[] = [];
  for (const f of files) lines.push(`- ${f.path} (${f.type || "file"}${f.binary ? ", base64 data URL" : ""}; original name "${f.name}")`);
  let out = prompt.trim();
  if (lines.length) out += `\n\nAttachments (saved in the project):\n${lines.join("\n")}`;
  if (figmaUrl) out += `\n\nFigma design: ${figmaUrl}`;
  return out;
}

export function readAsText(file: File): Promise<string> {
  return file.text();
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}
