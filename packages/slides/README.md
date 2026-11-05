# @forge/slides

Decks and documents for Forge. It covers JSON schemas (zod), LLM generation with rule-based mocks, a standalone themed
web renderer, pure editor operations, and exports to PPTX (pptxgenjs), PDF (Playwright Chromium `page.pdf`) and DOCX
(`docx`).

## Public API

```ts
import {
  // schemas
  DeckSchema, SlideSchema, DeckThemeSchema, ChartSchema, DocSchema, DocBlockSchema, ContentDataSchema,
  type Deck, type Slide, type Doc, type DeckTheme, type Chart, type ContentData,
  // generation (purposes "slides.outline" / "slides.document")
  generateDeck, generateDocument, estimateDeck, estimateDocument,
  // images (decoupled from @forge/media)
  type ImageResolver, imageResolver, PlaceholderImageResolver, resolveDeckImages, resolveDocImages,
  // rendering + editing
  renderDeckHtml, renderDocHtml, renderChartSvg, chartToPng, applyDeckEdit, applyDeckEdits, DeckEditOpSchema,
  // export
  exportPptx, exportDeckPdf, exportDocx, exportDocPdf, htmlToPdf,
  // theming
  DEFAULT_THEME, LIGHT_THEME, themeFromTokens,
} from "@forge/slides";
```

### Deck JSON
`{ title, theme: { colors: { bg, surface, text, muted, accent, accent2, border? }, fonts: { display, body } }, slides: [...], meta? }`.
Each slide is `{ id, layout, title, subtitle?, bullets?, body?, columns?, image?: { url? | artifactId? | prompt?, alt }, chart?: { type: bar|line|pie|doughnut, labels, series: [{ name, values }] }, stats?: [{ value, label }], quote?: { text, author }, timeline?: [{ label, text }], notes }`.
The layouts are `title`, `section`, `bullets`, `two-column`, `image-left`, `image-full`, `chart`, `quote`, `stats`,
`timeline` and `closing`. Validation checks unique slide ids, hex colours, one value per chart label, a single series
for pie/doughnut charts, and that an image has a url, artifactId or prompt.

### Document JSON
`{ title, subtitle?, author?, date?, theme?, sections: [{ id, heading, level: 1|2|3, blocks: [...] }] }`. A block is one
of: `paragraph`, `bullets`, `numbered`, `table` (rows must match the header count), `image`, `chart` or
`callout` (`info|warning|success|note`).

### Generation
- `generateDeck(llm, { brief, slideCount = 10, theme?, data?, model?, sink?, meter?, images? })` calls `structured()`
  with purpose `slides.outline`, validates the outline with zod, applies the theme (a `DeckTheme` or loose design
  tokens via `themeFromTokens`) and de-duplicates ids. It returns `{ value: Deck, costUsd, model, mock }`. Pass `sink`
  to meter LLM usage through `MeteredLLM`.
- `generateDocument(llm, { brief, data?, theme?, author?, images? })` works the same way with purpose `slides.document`.
- `data` (`ContentData`: metrics, charts, team, competitors, quotes, segments, ask, contact) holds the facts to use.
  Prompts and mocks never invent numbers. Without data they write explicit `[add figure]` placeholders.
- **Mock mode** (`LLM_PROVIDER=mock`): `src/mock-llm.ts` registers rule-based handlers. They detect the deck type
  (pitch / report / training / general) and language (sv / en). They take the subject, description, audience and
  nouns from the brief and assemble a fixed structure:
  - pitch: title, problem, solution, market, product, business model, traction, competition, team, financials/ask, plus
    why-now, roadmap, customer quote and closing when there is room
  - report: summary, metrics, trend, highlights, challenges, outlook, recommendations, appendix
  - training: agenda, objectives, module, concepts, example, exercise, check, summary, resources
  - documents: a market analysis (executive summary, market size table, segments table, competitors table, trends as h2
    subsections, risks, recommendations, methodology as h3), or a generic report

  Output is tagged `meta.generator = "rule-based mock (LLM_PROVIDER=mock)"`, and documents carry a callout saying so.

### Images
`ImageResolver.resolve({ prompt?, artifactId?, url?, alt, width, height }) → { bytes? | url?, mimeType }` is injected by
the caller, so slides never imports media. `resolveDeckImages` and `resolveDocImages` fill `image.url` with data URIs.
Example wiring with `@forge/media`:

```ts
const resolver = imageResolver(async ({ prompt, alt, width, height }) => {
  const [art] = await mediaJobs.run({ type: "text-to-image", prompt: prompt ?? alt, width, height, n: 1 }, { projectId });
  return { bytes: await store.get(art.storageKey), mimeType: art.mimeType };
});
```

`PlaceholderImageResolver` renders a clearly labelled placeholder ("Image placeholder" + alt text) for offline use and
tests. Images that are not resolved render as an explicit "image not generated yet" box, never as fake imagery.

### Rendering, editing, export
- `renderDeckHtml(deck, { mode: "present" | "print" })` returns one self-contained HTML file (no external requests).
  Slides are 16:9 and sized in container units, themed through CSS variables. Keys: ←/→, PageUp/PageDown, Space,
  Home/End; `N` shows the notes panel, `P` the presenter view (timer, next slide, notes), `F` fullscreen. It supports
  swipe and syncs the URL hash. Accessibility: each slide is a `group` with `aria-roledescription="slide"` and a label,
  hidden slides use `hidden`, an `aria-live` region announces slide changes, buttons have labels, charts are SVG with
  `<title>`/`<desc>`, and `prefers-reduced-motion` is respected.
- `applyDeckEdit(deck, op)` is pure (it never mutates its input) and re-validates the result. Ops: `setTitle`,
  `updateSlide` (patch fields), `addSlide`, `removeSlide`, `moveSlide`, `duplicateSlide`, `changeLayout` (moves content
  between fields, e.g. bullets → two columns or a timeline) and `changeTheme`. It throws `ForgeError` `BAD_INPUT` or
  `NOT_FOUND`.
- `exportPptx(deck)` builds a 16:9 deck with native PowerPoint charts (bar/line/pie/doughnut in theme colours), images
  pre-cropped to cover with sharp, speaker notes on every slide, and theme fonts (`headFontFace`/`bodyFontFace`) and
  colours.
- `exportDeckPdf(deck)` prints the HTML in print mode with Playwright Chromium, one 1280×720 page per slide.
  `exportDocPdf(doc)` prints A4.
- `exportDocx(doc)` writes real Heading1–3 styles in theme fonts, bullet and numbered lists, bordered tables with a
  shaded header, images, charts (rendered to PNG by the built-in SVG chart renderer + sharp), callouts (shaded with a
  coloured rule) and page-number footers.

## Providers

| Adapter | Real / mock | Env vars | Notes |
|---|---|---|---|
| LLM (via `@forge/llm`) | real (Anthropic / OpenAI) or `mock` | `LLM_PROVIDER`, `MODEL_BUILDER` | The mock handlers for `slides.outline` and `slides.document` are rule-based templates |
| `ImageResolver` | injected by the caller; `PlaceholderImageResolver` is a local labelled placeholder | none | Real images come from `@forge/media` through the resolver |
| PDF (Playwright Chromium) | real, local | none (uses the preinstalled Playwright browsers) | `page.pdf` with `printBackground` |

## New env vars

None. It uses the existing `LLM_PROVIDER` and `MODEL_*` variables.

## Tests

`pnpm --filter @forge/slides test` runs 19 unit tests with no network and no docker. They launch the local Playwright
Chromium for the PDF and keyboard tests. They cover:
- schema validation for decks and documents
- a 10-slide pitch deck generated in mock mode (structure, data use, placeholders, metering)
- Swedish and training/report decks, and slide-count padding
- HTML a11y and navigation in a real browser
- SVG/PNG charts
- PPTX inspected with jszip: 10 slide XMLs, 10 notes slides, a native chart, media and theme fonts
- PDF page count = slide count (pdf-lib), plus an A4 document PDF
- DOCX `document.xml` containing Heading1/2/3, `<w:tbl>` and `<w:drawing>`
- every editor op, including invalid ones

## Limitations

- Mock decks and documents are templates filled with the brief's nouns. Wording can be awkward for unusual briefs, and
  they contain placeholders rather than facts by design.
- Text fitting in PPTX relies on `fit: "shrink"`, which PowerPoint applies on open. LibreOffice may not shrink very long
  text.
- Fonts are referenced by name. HTML/PDF fall back to Inter/Helvetica/Arial when the brand font is not installed, and
  PPTX/DOCX depend on fonts on the viewer's machine. Nothing is embedded.
- `loadImageBytes` fetches http(s) image URLs at export time. Resolve images to data URIs first for fully offline
  exports.
- No `create<X>Provider()` factory here: slides has no external vendor of its own. LLM and media providers come from
  `@forge/llm` (`createLLM`) and `@forge/media` (`createMediaProvider`).
