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
/** Forge editor themes, matched to the site's paper/ink palette. */
export function defineThemes() {
  if (themed) return;
  themed = true;
  monaco.editor.defineTheme("forge-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8f877a", fontStyle: "italic" },
      { token: "keyword", foreground: "ff8f5c" },
      { token: "string", foreground: "9fd6c4" },
      { token: "number", foreground: "f1c060" },
      { token: "type", foreground: "e8c9a8" },
    ],
    colors: {
      "editor.background": "#141210",
      "editor.foreground": "#f2ece2",
      "editorLineNumber.foreground": "#5a5248",
      "editorLineNumber.activeForeground": "#c3baab",
      "editor.selectionBackground": "#ff6a2b44",
      "editor.lineHighlightBackground": "#1e1b17",
      "editorCursor.foreground": "#ff6a2b",
      "editorGutter.background": "#141210",
    },
  });
  monaco.editor.defineTheme("forge-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7a7266", fontStyle: "italic" },
      { token: "keyword", foreground: "a8360a" },
      { token: "string", foreground: "2b6b5e" },
      { token: "number", foreground: "8a5a00" },
    ],
    colors: {
      "editor.background": "#fbf8f2",
      "editor.foreground": "#17140f",
      "editorLineNumber.foreground": "#b9ad98",
      "editor.selectionBackground": "#e8480c33",
      "editor.lineHighlightBackground": "#f3eee5",
      "editorCursor.foreground": "#e8480c",
    },
  });
}

export function currentMonacoTheme(): "forge-dark" | "forge-light" {
  const attr = document.documentElement.getAttribute("data-theme");
  const dark = attr ? attr === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "forge-dark" : "forge-light";
}

export { monaco };
