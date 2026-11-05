import { z } from "zod";
import type { UsageSink } from "@forge/shared";
import { MeteredLLM, getModels, structured, type LLMProvider } from "@forge/llm";

export const DOCS_PURPOSE = "integrations.docs_to_openapi";

const ParamIn = z.enum(["path", "query", "header", "body"]);
export const DocsSpecSchema = z.object({
  title: z.string().default("Imported API"),
  baseUrl: z.string().default(""),
  endpoints: z
    .array(
      z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().min(1),
        summary: z.string().default(""),
        params: z
          .array(z.object({ name: z.string().min(1), in: ParamIn, required: z.boolean().default(false), type: z.string().default("string"), description: z.string().default("") }))
          .default([]),
      }),
    )
    .default([]),
});
export type DocsSpec = z.infer<typeof DocsSpecSchema>;

export function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype|html|head|body|div|section|main|article|h1|table|p)\b/i.test(text) || /<\/(html|body|table|p|div)>/i.test(text);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#") && e !== "#39") return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/tr|\/pre|\/section|\/dt|\/dd)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " "),
  );
}

/** HTML docs -> plain text with tables rendered as markdown pipe tables (shared by heuristic and LLM paths). */
export function normalizeDocs(input: string): string {
  if (!looksLikeHtml(input)) return input;
  const html = input.replace(/<(script|style|noscript|svg|nav|footer)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const withTables = html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1] ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim()),
    );
    if (!rows.length) return " ";
    const lines = rows.map((cells) => `| ${cells.join(" | ")} |`);
    lines.splice(1, 0, `| ${rows[0]!.map(() => "---").join(" | ")} |`);
    return `\n${lines.join("\n")}\n`;
  });
  return stripTags(withTables)
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, a) => l || (a[i - 1] ?? "") !== "")
    .join("\n")
    .trim();
}

const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s/"'`<>]+)?(\/[^\s"'`<>|]*)/g;
const ENDPOINT_ONE = new RegExp(ENDPOINT.source);
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "parameter", "param", "field", "namn", "parameter name", "key"],
  type: ["type", "typ", "data type", "datatyp"],
  required: ["required", "obligatorisk", "req", "mandatory", "krävs"],
  description: ["description", "beskrivning", "details", "notes"],
  in: ["in", "location", "plats", "param type", "where"],
};

function headerIndex(cells: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  cells.forEach((c, i) => {
    const k = c.toLowerCase().replace(/[*:]/g, "").trim();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) if (idx[field] === undefined && aliases.includes(k)) idx[field] = i;
  });
  return idx;
}

function truthy(s: string | undefined): boolean {
  return /^(yes|true|required|ja|y|x|✓|✔|obligatorisk)$/i.test((s ?? "").trim());
}

function normType(t: string | undefined): string {
  const s = (t ?? "").toLowerCase();
  if (/int/.test(s)) return "integer";
  if (/float|double|number|decimal/.test(s)) return "number";
  if (/bool/.test(s)) return "boolean";
  if (/array|list|\[\]/.test(s)) return "array";
  if (/object|json|map/.test(s)) return "object";
  return "string";
}

/**
 * Rule-based extraction of endpoints from API docs text: "METHOD /path" patterns (":id" -> "{id}",
 * "?a=1" -> query params) and parameter tables following each endpoint. Also the mock for the LLM purpose.
 */
export function heuristicDocsSpec(text: string): DocsSpec {
  const lines = text.split("\n");
  const title = (lines.find((l) => l.trim() && !l.startsWith("|")) ?? "Imported API").replace(/^#+\s*/, "").trim().slice(0, 120);
  const baseMatch =
    /base\s*url[^h\n]*(https?:\/\/[^\s"'`<>|)]+)/i.exec(text) ?? /\b(https?:\/\/api\.[^\s"'`<>|)]+)/i.exec(text) ?? /\b(https?:\/\/[^\s"'`<>|)]*\/(?:api|v\d+)\b[^\s"'`<>|)]*)/i.exec(text);
  let baseUrl = baseMatch ? baseMatch[1]!.replace(/[.,;:]+$/, "").replace(/\/$/, "") : "";
  type Ep = DocsSpec["endpoints"][number] & { at: number };
  const endpoints: Ep[] = [];
  let offset = 0;
  const lineStarts = lines.map((l) => {
    const s = offset;
    offset += l.length + 1;
    return s;
  });
  for (const m of text.matchAll(ENDPOINT)) {
    const host = m[2];
    let rawPath = m[3]!.replace(/[.,;:)]+$/, "");
    if (host && !baseUrl) baseUrl = host;
    const [pathPart, queryPart] = rawPath.split("?") as [string, string | undefined];
    rawPath = pathPart;
    const path = rawPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}").replace(/<([A-Za-z_][A-Za-z0-9_]*)>/g, "{$1}") || "/";
    const at = m.index ?? 0;
    const lineNo = lineStarts.findLastIndex((s) => s <= at);
    const rest = (lines[lineNo] ?? "").slice(at - (lineStarts[lineNo] ?? 0) + m[0].length).replace(/^[\s\-–—:|]+/, "").replace(/\|.*$/, "").trim();
    const prev = lines.slice(Math.max(0, lineNo - 2), lineNo).reverse().find((l) => l.trim() && !l.startsWith("|") && !ENDPOINT_ONE.test(l));
    const params: DocsSpec["endpoints"][number]["params"] = [...path.matchAll(/\{([^}]+)\}/g)].map((p) => ({ name: p[1]!, in: "path", required: true, type: "string", description: "" }));
    for (const kv of (queryPart ?? "").split("&").filter(Boolean)) {
      const name = kv.split("=")[0]!;
      if (name && !params.some((p) => p.name === name)) params.push({ name, in: "query", required: false, type: "string", description: "" });
    }
    const dup = endpoints.find((e) => e.method === m[1] && e.path === path);
    if (dup) continue;
    endpoints.push({ method: m[1] as Ep["method"], path, summary: (rest || prev || "").slice(0, 200), params, at });
  }
  // Parameter tables: attach each table to the closest preceding endpoint.
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim().startsWith("|")) {
      i++;
      continue;
    }
    const start = i;
    const rows: string[][] = [];
    while (i < lines.length && lines[i]!.trim().startsWith("|")) {
      const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      i++;
    }
    const at = lineStarts[start] ?? 0;
    const owner = [...endpoints].reverse().find((e) => e.at <= at);
    if (!owner || rows.length < 2) continue;
    const h = headerIndex(rows[0]!);
    if (h.name === undefined) continue;
    for (const r of rows.slice(1)) {
      const name = (r[h.name] ?? "").replace(/[`*]/g, "").split(/\s/)[0]!;
      if (!/^[A-Za-z_][\w.-]*$/.test(name)) continue;
      const loc = (h.in !== undefined ? r[h.in] : "")?.toLowerCase() ?? "";
      const desc = h.description !== undefined ? (r[h.description] ?? "") : "";
      const requiredCell = h.required !== undefined ? r[h.required] : undefined;
      const required = truthy(requiredCell) || /\brequired\b|\bobligatorisk\b/i.test(desc) || /\(required\)/i.test(r[h.name] ?? "");
      const where: "path" | "query" | "header" | "body" = /path/.test(loc)
        ? "path"
        : /header/.test(loc)
          ? "header"
          : /body|form|json/.test(loc)
            ? "body"
            : /query/.test(loc)
              ? "query"
              : owner.path.includes(`{${name}}`)
                ? "path"
                : owner.method === "GET" || owner.method === "DELETE"
                  ? "query"
                  : "body";
      const existing = owner.params.find((p) => p.name === name);
      const param = { name, in: where, required: where === "path" || required, type: normType(h.type !== undefined ? r[h.type] : undefined), description: desc.slice(0, 300) };
      if (existing) Object.assign(existing, { ...param, in: existing.in === "path" ? "path" : param.in });
      else owner.params.push(param);
    }
  }
  return { title, baseUrl, endpoints: endpoints.map(({ at: _a, ...e }) => e) };
}

/** Convert the simplified endpoint list into an OpenAPI 3.1 document. */
export function docsSpecToOpenApi(spec: DocsSpec): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of spec.endpoints) {
    const schemaFor = (t: string) => (t === "array" ? { type: "array", items: {} } : t === "object" ? { type: "object" } : { type: ["string", "integer", "number", "boolean"].includes(t) ? t : "string" });
    const params = e.params.filter((p) => p.in !== "body");
    const bodyParams = e.params.filter((p) => p.in === "body");
    const item = (paths[e.path] ??= {});
    item[e.method.toLowerCase()] = {
      summary: e.summary || `${e.method} ${e.path}`,
      parameters: params.map((p) => ({ name: p.name, in: p.in, required: p.in === "path" || p.required, ...(p.description ? { description: p.description } : {}), schema: schemaFor(p.type) })),
      ...(bodyParams.length
        ? {
            requestBody: {
              required: bodyParams.some((p) => p.required),
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: Object.fromEntries(bodyParams.map((p) => [p.name, { ...schemaFor(p.type), ...(p.description ? { description: p.description } : {}) }])),
                    required: bodyParams.filter((p) => p.required).map((p) => p.name),
                  },
                },
              },
            },
          }
        : {}),
      responses: { "200": { description: "Successful response", content: { "application/json": { schema: {} } } } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: spec.title || "Imported API", version: "0.0.0-docs", description: "Generated by Forge from API documentation (verify before relying on it)." },
    servers: spec.baseUrl ? [{ url: spec.baseUrl }] : [],
    paths,
  };
}

/** Docs (HTML/text) -> OpenAPI. Uses the LLM when provided (metered when `usage` is given), else the heuristic. */
export async function docsToOpenApi(
  input: string,
  opts: { llm?: LLMProvider; usage?: UsageSink; pageUrl?: string } = {},
): Promise<{ document: Record<string, unknown>; source: "docs-heuristic" | "docs-llm" }> {
  const text = normalizeDocs(input).slice(0, 60_000);
  if (!opts.llm) return { document: docsSpecToOpenApi(heuristicDocsSpec(text)), source: "docs-heuristic" };
  const llm = opts.usage ? new MeteredLLM(opts.llm, opts.usage) : opts.llm;
  const { value } = await structured(
    llm,
    {
      purpose: DOCS_PURPOSE,
      model: getModels().builder,
      system:
        "You convert REST API documentation into a list of endpoints. Output JSON: {title, baseUrl, endpoints:[{method, path, summary, params:[{name, in: path|query|header|body, required, type: string|integer|number|boolean|array|object, description}]}]}. " +
        "Use {name} for path parameters. Only include endpoints that the documentation actually describes; never invent endpoints.",
      messages: [{ role: "user", content: `${opts.pageUrl ? `Docs URL: ${opts.pageUrl}\n` : ""}<docs>\n${text}\n</docs>` }],
      maxTokens: 8000,
    },
    DocsSpecSchema as unknown as z.ZodType<DocsSpec>,
  );
  return { document: docsSpecToOpenApi(value), source: "docs-llm" };
}
