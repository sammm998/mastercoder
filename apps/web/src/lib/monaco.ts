/**
 * Monaco, bundled from npm (no CDN loader: code and fonts never leave our origin). Only the core
 * editor, its standard features and Monarch syntax definitions are included — no language-service
 * workers — which keeps the chunk small. Loaded lazily by the editor components.
 */
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/register.all.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/dockerfile/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import { effectiveTheme } from "./theme";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
  }
}

if (typeof window !== "undefined" && !window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker: () => new Worker(new URL("./monaco.worker.ts", import.meta.url), { type: "module", name: "monaco-editor" }),
  };
}

const LANGS: Array<[RegExp, string]> = [
  [/\.(tsx?|mts|cts)$/, "typescript"],
  [/\.(jsx?|mjs|cjs)$/, "javascript"],
  [/\.scss$/, "scss"],
  [/\.css$/, "css"],
  [/\.html?$/, "html"],
  [/\.(md|mdx)$/, "markdown"],
  [/\.ya?ml$/, "yaml"],
  [/\.json$/, "javascript"],
  [/\.py$/, "python"],
  [/\.sql$/, "sql"],
  [/\.(sh|bash)$/, "shell"],
  [/Dockerfile$/, "dockerfile"],
  [/\.(xml|svg)$/, "xml"],
];

export function languageFor(path: string): string {
  for (const [re, lang] of LANGS) if (re.test(path)) return lang;
  return "plaintext";
}

let themed = false;
/** Forge editor themes, matched to the site's Horizon palette (blue keywords, amber numbers). */
export function defineThemes() {
  if (themed) return;
  themed = true;
  monaco.editor.defineTheme("forge-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7d8696", fontStyle: "italic" },
      { token: "keyword", foreground: "8fb3ff" },
      { token: "string", foreground: "8fe0bd" },
      { token: "number", foreground: "ffb35c" },
      { token: "type", foreground: "c7d6ff" },
    ],
    colors: {
      "editor.background": "#080b11",
      "editor.foreground": "#e8ecf4",
      "editorLineNumber.foreground": "#4a5263",
      "editorLineNumber.activeForeground": "#aab2c0",
      "editor.selectionBackground": "#3d78ff40",
      "editor.lineHighlightBackground": "#0f141e",
      "editorCursor.foreground": "#7aa8ff",
      "editorGutter.background": "#080b11",
    },
  });
  monaco.editor.defineTheme("forge-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7385", fontStyle: "italic" },
      { token: "keyword", foreground: "234fc4" },
      { token: "string", foreground: "0b7350" },
      { token: "number", foreground: "a65200" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#0b0f19",
      "editorLineNumber.foreground": "#a3abba",
      "editor.selectionBackground": "#2f5fe030",
      "editor.lineHighlightBackground": "#f3f5fa",
      "editorCursor.foreground": "#2f5fe0",
    },
  });
  // Follow the site theme toggle and OS changes live.
  const sync = () => monaco.editor.setTheme(currentMonacoTheme());
  window.addEventListener("forge:theme", sync);
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", sync);
}

export function currentMonacoTheme(): "forge-dark" | "forge-light" {
  return effectiveTheme() === "dark" ? "forge-dark" : "forge-light";
}

export { monaco };

