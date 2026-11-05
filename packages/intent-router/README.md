# @forge/intent-router

Turns a typed, spoken, meeting-derived or API prompt into **multi-label intents** (from `@forge/shared`
`IntentKind`), a **cost estimate** shown before any work starts (via `@forge/billing` `estimateTask`), and a
decision whether to ask **exactly one** clarifying question.

## Public API

```ts
classify(prompt, {
  llm,                      // LLMProvider (MeteredLLM-wrapped when `usage` is given)
  source?: "typed" | "voice" | "meeting" | "api",
  attachments?: [{ name, mimeType?, text? }],   // e.g. meeting transcript / document excerpt
  clarifyAboveUsd?: number, // default INTENT_CLARIFY_ABOVE_USD or 1.5
  minConfidence?: number,   // default 0.6
  usage?, meter?: { workspaceId?, projectId?, taskId? },
  events?: EventSink, projectId?, taskId?,     // emits intent.classified, cost.estimate, clarify.question
  model?,                   // default MODEL_FAST
}): Promise<{
  intents: Intent[];        // { kind, confidence, summary, hint? } sorted by confidence
  needsClarification: boolean; question?: string; options?: string[];
  estimate: CostEstimate; language: "sv" | "en"; complexity: "trivial" | "normal" | "complex";
  ambiguous: boolean; engine: "llm" | "mock-rules" | "rules-fallback";
}>

classifyByRules(prompt, { source?, attachments? })   // the rule-based sv/en classifier
detectLanguage(text), kindLabel(kind, lang)
estimate(input)                                      // = @forge/billing estimateTask
```

LLM call: purpose **`intent.classify`**, model `MODEL_FAST`, structured JSON output validated with zod
(`LlmClassificationSchema`), prompt passed as JSON data (not instructions). If the model output stays
invalid after one retry, the rule-based classifier is used (`engine: "rules-fallback"`).

### Hints
`mobile → expo` · `backend → fastapi` (Python/FastAPI/Django/Flask) or `hono` · `video → remotion` (product
video, screenshots, brand assets, promo/explainer) else `generative` · `agent → cron | webhook | chat | email` ·
`integration → openapi | mcp | <app slugs>` (e.g. `hubspot`, `google_sheets,slack`) · `website → landing |
portfolio | blog | shop` · `app → from-meeting` when the request refers to a meeting.
Quantities for the estimate are extracted when stated: video seconds/minutes, image count, slide count
(sv + en, digits and number words).

### Clarification rule
`needsClarification = ambiguous && estimate.highUsd > threshold`, where `ambiguous` is any of:
the classifier flags it (nothing concrete to build, explicit alternatives like "a website or an app",
no description at all such as "Bygg en app"), the top confidence is below `minConfidence`, or two build
targets (app/website/mobile/backend) have similar middling confidence. Cheap requests ("Gör en bild",
"Make a logo") proceed without asking; clear expensive requests proceed without asking. The question is
always a single sentence ending at the first `?`, in the user's language, with 2-4 options.

### Rule-based classifier (mock for `intent.classify`)
`src/rules.ts`, registered in `src/mock-llm.ts` so `LLM_PROVIDER=mock` works end-to-end. Swedish + English
lexicons with Unicode word boundaries and compound-suffix matching (`bokningssystem`, `produktbilder`,
`att-göra-app`), plus context rules: mobile absorbs generic "app"; references to existing things are not
deliverables ("a video for my booking app", "vår webbshop", "på hemsidan", "a whitepaper for SaaS companies");
feature mentions are not deliverables ("upload documents", "mobile-friendly", "video calls"); chat platforms
used as the agent's channel are not integrations ("Slack agent ... in #help") while posting to them is;
"using this API" / spec files are integrations, building an API is a backend; Swedish "bilder" inside a
presentation counts slides; questions vs. requests ("How do I…?" vs "Can you build…?").

## Providers
| Provider | Adapter | Real / mock | Env vars |
|---|---|---|---|
| LLM (via `@forge/llm`) | Anthropic / OpenAI | real | `LLM_PROVIDER`, `MODEL_FAST` |
| LLM (via `@forge/llm`) | `MockLLMProvider` + handler `intent.classify` (rule-based) | mock | `LLM_PROVIDER=mock` |

New env var: `INTENT_CLARIFY_ABOVE_USD` (default `1.5`; not yet in `.env.example`).

## Tests
`test/router.test.ts` (mock mode): 93 hand-labelled prompts (`test/labelled.ts`, 41 sv / 52 en) with ≥ 90%
exact-set accuracy required (currently 100%; a second batch of 22 prompts written after the first tuning pass
scored 20/22 before two lexicon additions); all 20 prompts parsed from `evals/benchmark.md` classified to
their expected intents with no clarification; hints/quantities; multi-label; clarification only for
ambiguous+expensive; LLM path post-processing, retry → rules fallback, metering and events.

## Limitations
- The rule-based classifier is a lexicon/pattern system: good on the request styles above, but it has no
  world knowledge. Real deployments should run the LLM path (the mock is labelled `engine: "mock-rules"`).
- Labelled accuracy is measured on prompts written by the package author (risk of overfitting); the
  benchmark prompts are the independent check.
- Complexity is a feature-count heuristic; estimates are only as good as `@forge/billing` budgets.
- Language detection is binary sv/en.
