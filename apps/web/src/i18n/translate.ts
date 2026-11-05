import type en from "../../messages/en.json";
import type { Locale } from "./config";

export type Messages = typeof en;
type MessageTree = { [k: string]: string | MessageTree };

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid dotted message key, derived from messages/en.json. */
export type MessageKey = Leaves<Messages>;
export type Namespace = keyof Messages;
export type Vars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

export function lookup(messages: MessageTree, key: string): string | undefined {
  let node: string | MessageTree | undefined = messages;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * Minimal ICU-style formatting: `{name}` interpolation and
 * `{count, plural, one {# file} other {# files}}` (with `=0 {...}` exact matches).
 */
export function format(template: string, vars: Vars | undefined, locale: Locale): string {
  if (!vars) return template;
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== "{") {
      out += ch;
      i++;
      continue;
    }
    const end = matchBrace(template, i);
    if (end < 0) {
      out += template.slice(i);
      break;
    }
    out += formatArg(template.slice(i + 1, end), vars, locale);
    i = end + 1;
  }
  return out;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let j = start; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function formatArg(body: string, vars: Vars, locale: Locale): string {
  const comma = body.indexOf(",");
  if (comma < 0) {
    const v = vars[body.trim()];
    return v === undefined ? `{${body}}` : typeof v === "number" ? new Intl.NumberFormat(locale).format(v) : v;
  }
  const name = body.slice(0, comma).trim();
  const rest = body.slice(comma + 1);
  const comma2 = rest.indexOf(",");
  const kind = rest.slice(0, comma2).trim();
  if (kind !== "plural" || comma2 < 0) return `{${body}}`;
  const n = Number(vars[name] ?? 0);
  const options = parseOptions(rest.slice(comma2 + 1));
  const category = new Intl.PluralRules(locale).select(n);
  const chosen = options[`=${n}`] ?? options[category] ?? options.other ?? "";
  return format(chosen.replace(/#/g, new Intl.NumberFormat(locale).format(n)), vars, locale);
}

function parseOptions(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] ?? "")) i++;
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const sel = s.slice(i, open).trim();
    const close = matchBrace(s, open);
    if (close < 0) break;
    out[sel] = s.slice(open + 1, close);
    i = close + 1;
  }
  return out;
}

export function createTranslator(messages: MessageTree, locale: Locale): Translate {
  return (key, vars) => {
    const template = lookup(messages, key);
    return template === undefined ? key : format(template, vars, locale);
  };
}

/** Flatten a message tree into dotted keys (used by the completeness test). */
export function flattenKeys(tree: MessageTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === "string" ? [`${prefix}${k}`] : flattenKeys(v, `${prefix}${k}.`)));
}

export function pick(messages: Messages, namespaces: readonly Namespace[]): Partial<Messages> {
  const out: Partial<Messages> = {};
  for (const ns of namespaces) (out as Record<string, unknown>)[ns] = messages[ns];
  return out;
}
