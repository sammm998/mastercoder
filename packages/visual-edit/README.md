# @forge/visual-edit

Click-to-edit for generated apps, with no LLM call: map a DOM element in the live preview back to its JSX
source and apply text/class/style/attribute changes directly to the code.

## Public API

| Export | What it does |
|---|---|
| `forgeSourceTags(opts?)` (`@forge/visual-edit/vite`) | Vite plugin, `apply: "serve"` only. Adds `data-forge-src="path:line:col"` to host JSX elements and injects the inspector into `index.html`. `{ inspector?: boolean; include?(id) }` |
| default export of `@forge/visual-edit/babel` | Babel plugin doing the same tagging (no-op when `NODE_ENV=production` or `enabled: false`). `{ root?, enabled? }` |
| `tagJsxSource(code, relPath)` | Core tagger (magic-string, with source map). |
| `INSPECTOR_SCRIPT` | Minified inspector (string). Inline it in the preview's dev HTML. Generated from `src/inspector/inspector.ts` by `pnpm --filter @forge/visual-edit build:inspector`; a test fails if stale. |
| `applyVisualEdit(source, { line, column }, edit, { filename? })` | Locate the JSX element whose `<` is at line/column (1-based; falls back to the innermost opening tag containing the position) and apply `edit`, preserving formatting. |
| `describeElement(source, pos)` | Static text / className / style / src·alt·href of the element (prefills the edit panel). |
| protocol (`@forge/visual-edit/protocol`) | `forge:select` / `forge:ready` (inspector → parent), `forge:inspect` / `forge:highlight` (parent → inspector), guards (`isSelectMessage`, `isParentMessage`…), `parseSrc`, `selectorForSrc`, `srcFromSelector`. |

`VisualEdit = { kind: "text", value } | { kind: "class", add?, remove? } | { kind: "style", prop, value | null } | { kind: "attr", name: "src"|"alt"|"href", value }`

Edits handled: JSX text (multi-line, mixed children → leading text), string-literal children, empty and
self-closing elements; `className` as string, `{"…"}`, template literals (static quasis) and
`cn()/clsx()` calls; `style={{…}}` objects (add/update/remove, kebab-case or camelCase, custom
properties, multi-line formatting preserved); attributes (expression values replaced, quote style kept).
Runtime-computed values throw `VisualEditError("DYNAMIC")`; parse errors `"PARSE"`; missing element
`"NOT_FOUND"`.

Security: the inspector only accepts messages whose `source` is `window.parent`; the Forge workspace only
accepts messages from the preview iframe's origin and window. `parseSrc` rejects absolute and `..` paths.

## Providers

None — pure local code (no vendor APIs, no env vars).

## Limitations

- Styles are written as inline `style` props; Tailwind users can use the class add/remove fields instead.
- Text inside `{expression}`/i18n calls is not editable visually (by design).
- The inspector highlights by `data-forge-src`; elements rendered from the same JSX in a loop share a source location, so an edit applies to all of them.
