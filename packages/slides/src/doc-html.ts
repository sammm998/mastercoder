import type { Doc, DocBlock, DeckTheme } from "./schema.js";
import { renderChartSvg } from "./chart-svg.js";
import { LIGHT_THEME, cssFontStack, escapeHtml as esc } from "./theme.js";

const TONES: Record<string, { bg: string; border: string; label: string }> = {
  info: { bg: "#eef4ff", border: "#3b82f6", label: "Info" },
  warning: { bg: "#fff6e6", border: "#f59e0b", label: "Warning" },
  success: { bg: "#ecfdf3", border: "#10b981", label: "Success" },
  note: { bg: "#f4f4f6", border: "#6b7280", label: "Note" },
};

function block(b: DocBlock, theme: DeckTheme): string {
  switch (b.type) {
    case "paragraph":
      return `<p>${esc(b.text).replace(/\n/g, "<br>")}</p>`;
    case "bullets":
      return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    case "numbered":
      return `<ol>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`;
    case "table":
      return `<figure class="table"><table><thead><tr>${b.headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`)
        .join("")}</tbody></table>${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
    case "image": {
      const ok = b.image.url && /^(data:image\/|https?:\/\/)/.test(b.image.url);
      const img = ok
        ? `<img src="${esc(b.image.url as string)}" alt="${esc(b.image.alt)}">`
        : `<div class="img-missing" role="img" aria-label="${esc(b.image.alt)}">${esc(b.image.alt)}<small>image not generated yet</small></div>`;
      return `<figure>${img}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
    }
    case "chart":
      return `<figure class="chart">${renderChartSvg(b.chart, { theme, width: 900, height: 420 })}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
    case "callout": {
      const t = TONES[b.tone] ?? (TONES.note as { bg: string; border: string; label: string });
      return `<aside class="callout" style="background:${t.bg};border-color:${t.border}" role="note" aria-label="${esc(b.title ?? t.label)}">${b.title ? `<strong>${esc(b.title)}</strong>` : ""}<p>${esc(b.text)}</p></aside>`;
    }
  }
}

/** Standalone themed HTML for a document (screen + A4 print). */
export function renderDocHtml(doc: Doc, opts: { lang?: string } = {}): string {
  const theme = doc.theme ?? LIGHT_THEME;
  const c = theme.colors;
  const toc = doc.sections.filter((s) => s.level <= 2);
  const body = doc.sections
    .map((s) => {
      const tag = `h${s.level}`;
      return `<section aria-labelledby="${esc(s.id)}"><${tag} id="${esc(s.id)}">${esc(s.heading)}</${tag}>${s.blocks.map((b) => block(b, theme)).join("\n")}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="${esc(opts.lang ?? "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)}</title>
<style>
:root{--text:${c.text};--muted:${c.muted};--accent:${c.accent};--accent2:${c.accent2};--border:${c.border ?? "#e5e7eb"};--surface:${c.surface};--bg:${c.bg}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:${cssFontStack(theme.fonts.body)};font-size:16px;line-height:1.6}
main{max-width:820px;margin:0 auto;padding:56px 28px 80px}
header.cover{border-bottom:4px solid var(--accent);padding-bottom:24px;margin-bottom:32px}
header.cover h1{font-family:${cssFontStack(theme.fonts.display)};font-size:40px;line-height:1.1;margin:0 0 8px;letter-spacing:-.02em}
header.cover .subtitle{font-size:20px;color:var(--muted);margin:0 0 12px}
header.cover .byline{font-size:14px;color:var(--muted)}
nav.toc{background:var(--surface);border-radius:12px;padding:16px 20px;margin-bottom:32px;font-size:14px}
nav.toc ol{margin:6px 0 0;padding-left:20px}
nav.toc a{color:inherit}
h1,h2,h3{font-family:${cssFontStack(theme.fonts.display)};line-height:1.25;letter-spacing:-.01em}
section>h1{font-size:28px;margin:40px 0 12px;padding-top:8px;border-top:1px solid var(--border)}
section>h2{font-size:22px;margin:28px 0 10px}
section>h3{font-size:18px;margin:22px 0 8px;color:var(--accent)}
figure{margin:20px 0}
figure img{max-width:100%;height:auto;border-radius:10px;display:block}
figcaption{font-size:13px;color:var(--muted);margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
thead th{background:var(--surface);font-weight:700;border-bottom:2px solid var(--accent)}
tbody th{font-weight:600}
.callout{border-left:5px solid;border-radius:8px;padding:12px 16px;margin:18px 0}
.callout p{margin:4px 0 0}
.chart svg{width:100%;height:auto}
.img-missing{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:200px;border:2px dashed var(--border);border-radius:10px;color:var(--muted)}
.img-missing small{font-size:11px;text-transform:uppercase;letter-spacing:.1em}
@page{size:A4;margin:18mm 16mm}
@media print{body{font-size:11pt}main{max-width:none;padding:0}section>h1{break-before:auto}figure,table,.callout{break-inside:avoid}h1,h2,h3{break-after:avoid}}
</style></head>
<body><main>
<header class="cover"><h1>${esc(doc.title)}</h1>${doc.subtitle ? `<p class="subtitle">${esc(doc.subtitle)}</p>` : ""}<p class="byline">${[doc.author, doc.date].filter(Boolean).map((x) => esc(x as string)).join(" · ")}</p></header>
${toc.length > 2 ? `<nav class="toc" aria-label="Contents"><strong>Contents</strong><ol>${toc.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.heading)}</a></li>`).join("")}</ol></nav>` : ""}
${body}
</main></body></html>`;
}
