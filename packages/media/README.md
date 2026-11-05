# @forge/media

Image and video generation for Forge: provider adapters (fal.ai, Replicate, a local mock), moderation that runs
before every model call, brand-consistent image sets, logo kits, a job service that stores artifacts and meters
usage, and programmatic video with Remotion.

## Public API

```ts
import {
  createMediaProvider,            // MEDIA_PROVIDER=fal|replicate|mock (default mock)
  type MediaProvider,             // textToImage / editImage / removeBackground / upscale / textToVideo / imageToVideo / estimate
  FalMediaProvider, ReplicateMediaProvider, MockMediaProvider,
  MediaJobService, type Artifact, // run(job, { projectId, taskId }) -> Artifact[]
  moderate, moderateRules, assertAllowed, // { allowed, category?, reason, source, matched? }
  styleFromBrand, generateImageSet, // shared style suffix + seed for a set
  generateLogo, wordmarkSvg, pngsToIco,
  PRICE_TABLE, priceFor, costForUnits, megapixels,
  MediaJobSchema, type MediaJob,
} from "@forge/media";

import { renderRemotionVideo, probeVideo, DEFAULT_VIDEO_THEME, videoThemeFrom } from "@forge/media/remotion";
```

- **`MediaProvider`** results are `{ items: [{ bytes?, url?, mimeType, width?, height?, durationSec?, meta? }], costUsd, provider, model }`.
  `estimate(job)` returns a `CostEstimate` from the price table (provider cost, no markup).
- **`MediaJobService`** (`{ provider, store: ObjectStore, sink: UsageSink, events: EventSink, moderationLlm? }`):
  `run(job, { projectId, taskId })` validates the job (zod), moderates it (throws `ForgeError("MODERATION_BLOCKED")`,
  emits `task.failed` with `charged: false`, never calls the provider), emits `job.progress`, downloads URL-only
  results, stores outputs at `projects/<projectId>/media/<artifactId>.<ext>`, records one `UsageRecord`
  (`image_count` or `media_seconds`, with `costUsd`), emits `artifact.ready` and returns
  `Artifact[]` (`{ id, kind: "image"|"video", storageKey, mimeType, meta, costUsd }`).
- **Moderation** (`moderate({ prompt, images? }, { llm? })`) blocks four categories:
  `sexual_minors` (sexual term + minor indicator, numeric ages, CSAM terms), `deepfake` (named real/public person or
  personal target + face swap/nude/fake/impersonate/"make it look like", face swaps or undressing of uploaded photos),
  `brand_impersonation` (known brand + logo/official/login/phishing patterns; standalone fake-login/phishing pages) and
  `violent_extremism` (extremist organisations + recruitment/glorification always; + propaganda/flags/symbols unless an
  educational/historical context is present; slogans like "1488"; glorifying attackers). Lexicons are Swedish + English
  over normalised text (NFKC, zero-width removal, Cyrillic/Greek homoglyphs, diacritics, leetspeak with both `1→i` and
  `1→l`, spelled-out letters "n u d e", squashed repeats). Swedish ambiguities are handled: bare "barn" counts as a minor
  indicator only in Swedish text, and the Swedish numeral "sex" ("sex barn" = six children) is not read as a sexual term.
  When rules allow and an `llm` is passed, the LLM is asked as a second check (purpose `media.moderate`); its mock
  handler in `src/mock-llm.ts` re-runs the rules and labels its reason `[mock rule-based check]`.
- **Brand consistency**: `styleFromBrand({ palette, mood, styleSuffix })` → `{ suffix, seed, palette }`;
  `generateImageSet(provider, { prompts, brand, n })` moderates every prompt first, then generates all prompts with the
  same seed + suffix.
- **Logos**: `generateLogo(provider, { name, brand, tagline? })` → text-to-image with a logo preset → background removal →
  trim and square transparent PNGs (1024…16 px, 180 = apple-touch, 192/512 = PWA) + `favicon.ico` (16/32/48) via sharp,
  plus a real SVG wordmark (monogram badge + name in the brand font and colours).
- **Remotion** (`src/remotion/`): compositions `Explainer` (title card + staggered bullet reveals), `ProductDemo`
  (screenshots in a browser/laptop/phone frame with pan/zoom and captions) and `AnimatedText` (rise/typewriter/scale),
  all themed by `{ colors: { bg, surface, text, muted, accent, accent2 }, fonts: { display, body } }`.
  `renderRemotionVideo({ composition, props, durationSec, fps, width, height })` bundles once per process with
  `@remotion/bundler`, then `selectComposition` + `renderMedia({ codec: "h264" })` using the preinstalled Chromium found
  by `findChromiumExecutable()` (prefers `/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`
  with `chromeMode: "headless-shell"`, falls back to Playwright's `chromium-*/chrome-linux64/chrome`).
  Props are validated with zod. `probeVideo()` uses ffprobe, or Remotion's `getVideoMetadata` if ffprobe is missing.

## Providers

| Adapter | Real / mock | Env vars | Notes |
|---|---|---|---|
| `fal` (`FalMediaProvider`) | real (fetch, queue REST API) | `FAL_KEY`, optional `FAL_QUEUE_URL` | `POST https://queue.fal.run/{model}` with `Authorization: Key …`, polls `status_url`, fetches `response_url`. Models: FLUX schnell/dev/pro 1.1, FLUX Kontext (edit), FLUX Fill (masked edit), Bria background removal, ESRGAN upscaler, Veo 3.1 (fast) and Kling 2.5 Turbo Pro for video. |
| `replicate` (`ReplicateMediaProvider`) | real (fetch, predictions API) | `REPLICATE_API_TOKEN` | `POST /v1/models/{owner}/{name}/predictions` (or `/v1/predictions` with `owner/name:version`), polls `urls.get`. FLUX family, Recraft background removal + crisp upscale, Kling 2.5 Turbo Pro / Veo 3.1 Fast. |
| `mock` (`MockMediaProvider`) | mock: deterministic local rendering | `MEDIA_MOCK_VIDEO_FORMAT=mp4\|webp` (optional) | Real PNGs rendered with sharp from an SVG composition derived from the prompt hash + brand palette, tagged `MOCK` in the corner, `meta.mock = true` and PNG tEXt `forge:mock=true`. Edits are real sharp blends (mask-aware). Background removal is a **luminance-key approximation**, not segmentation: the background luminance comes from the corners and similar pixels become transparent. Upscaling is a real lanczos3 resize. Video is a Ken Burns pan/zoom over a generated frame (or the input image): **H.264 mp4 via ffmpeg when `ffmpeg` is on PATH, otherwise an animated WebP via sharp** (`meta.renderer` says which). Cost is $0. |

Model ids are configurable per adapter (`new FalMediaProvider({ models: { image: "…" } })`) or per job (`job.model`;
`schnell`/`dev`/`pro` aliases select the FLUX tier).

## Pricing

`src/pricing.ts` holds the price table per model with its source. fal bills image models per output megapixel,
rounded up per image. Video prices are per second; Kling uses a base block ($0.35 for 5 s + $0.07/s). Veo is called with
`generate_audio: false`, so the audio-off price applies. Durations snap to what the model accepts (Veo 4/6/8 s,
Kling 5/10 s) and the snapped duration is billed. **Prices were checked 2026-11 from vendor model pages, as summarised
by public pricing aggregators (fal.ai was not reachable from the build sandbox). Verify them before billing changes.**
Override them at runtime without a deploy: `MEDIA_PRICE_OVERRIDES='{"fal-ai/flux/dev":0.025}'` (USD per unit).

## New env vars

| Var | Purpose |
|---|---|
| `MEDIA_PROVIDER` | `fal` \| `replicate` \| `mock` (default `mock`) |
| `FAL_KEY`, `FAL_QUEUE_URL` | fal.ai API key; optional queue base URL |
| `REPLICATE_API_TOKEN` | Replicate API token |
| `MEDIA_PRICE_OVERRIDES` | JSON map model → USD per unit |
| `MEDIA_MOCK_VIDEO_FORMAT` | force the mock's video output to `mp4` (needs ffmpeg) or `webp` |
| `REMOTION_BROWSER_EXECUTABLE` | explicit Chromium path for Remotion (else auto-detected under `PLAYWRIGHT_BROWSERS_PATH` / `/opt/pw-browsers`) |
| `REMOTION_LICENSE_KEY` | passed to `renderMedia({ licenseKey })` for Remotion company-license usage reporting |

## Tests

- `pnpm --filter @forge/media test`: unit tests (no network). They cover moderation (60+ allowed and blocked cases, sv + en,
  obfuscation, plus the LLM second check), the fal and Replicate adapters against a stubbed `fetch` (queue/poll flow, auth
  headers, cost math, error mapping), pricing, the factory, real mock rendering (PNG, alpha key, resize, masked edit,
  mp4/WebP video), brand sets, logos and `MediaJobService` (storage, usage, events, moderation short-circuit).
- `pnpm --filter @forge/media test:integration`: real Remotion renders. It renders a 3 s `ProductDemo` mp4 from a generated
  screenshot and asserts the file size, the H.264 codec, 1280×720 and a duration of about 3 s via ffprobe. It also renders
  `Explainer` and `AnimatedText`. Needs Chromium and does not need docker.

## License

The Remotion compositions in `src/remotion/` use **Remotion**, which is source-available under the
[Remotion License](https://www.remotion.dev/license), not an OSI open-source license (see `node_modules/remotion/LICENSE.md`):

- **Free License**: individuals, for-profit organisations with **up to 3 employees**, non-profit and not-for-profit
  organisations, and evaluation before commercial use. Commercial video creation is allowed under it.
- **Company License**: required for every other for-profit organisation (4+ employees). It is bought at
  [remotion.pro](https://www.remotion.pro/license). An operator of Forge that is such a company needs one before
  enabling Remotion rendering in production. Set `REMOTION_LICENSE_KEY` so renders are attributed to the license.
- You may not copy or modify Remotion's own code to sell or relicense a derivative of Remotion. Generating videos with it
  is fine.
- The license notes that terms change slightly in Remotion 5.0. This package pins `4.0.541`.

The rest of this package uses sharp (Apache-2.0), zod (MIT) and React (MIT).

## Limitations

- Real adapters are tested only against stubbed `fetch`. No vendor API was called during development because no keys
  were available. Response shapes follow the vendors' documented queue/predictions APIs.
- Image inputs to the vendor APIs are sent as data URIs. Very large images should be uploaded to storage first and passed
  as https URLs.
- Rule-based moderation is a first line of defence. It cannot see image content: images are only checked when the
  optional LLM check is enabled (inline bytes/data URIs; remote URLs are not fetched). Lexicons favour recall for the
  four categories, so some benign prompts that combine a celebrity with "photorealistic", or a brand with "logo", are
  blocked on purpose.
- The mock is not a generative model. Its outputs are abstract compositions, labelled as mock everywhere.
- The first Remotion render bundles with webpack (around 20 s). Later renders in the same process reuse the bundle.
