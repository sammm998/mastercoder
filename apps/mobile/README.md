# @forge/mobile — Forge for iOS and Android

Expo SDK 58 · expo-router · React Native 0.88 · React 19 · TypeScript strict. Dark editorial look (warm
near-black, off-white ink, ember accent, serif display), Swedish + English, accessible by default.

## Screens

| Route | What it does |
|-------|--------------|
| `sign-in` | Password sign-in (`auth.login`), magic-link request (`auth.requestMagicLink`), paste-the-link sign-in (`auth.verifyMagicLink`) |
| `auth/magic?token=` | Deep link `forge://auth/magic?token=…` → verifies and signs in |
| `/` | Workspaces + projects (`workspace.list`, `project.list`, `project.create`) |
| `project/[id]` | Chat: send prompts (`task.create`, plan-mode toggle), answer clarifying questions (`task.answerClarification`), approve plans (`task.approvePlan`); history from `project.events` + live stream from `/ws/events/:projectId` rendering intents, cost estimates, questions, phase progress, checkpoints, gates, artifacts, previews and results |
| `project/[id]/voice` | Voice prompt: real-time PCM streaming to `/ws/audio/:projectId?lang=sv\|en` with the transcript shown while speaking; editable; sent with `source: "voice"` |
| `project/[id]/preview` | Expo projects: QR code + "Open in Expo Go" (`exp://`/`exps://`); web projects: WebView (iframe on web) |
| `meetings` | Server meetings (`meetings.list`) + recordings on this phone with upload progress, resume, re-upload, remove |
| `meetings/record` | Consent notice (must be ticked), long in-person recording (AAC mono 96 kbps, document dir, keep-awake, background audio), pause/resume, stop → resumable upload |
| `meetings/[id]` | Status (polls while processing), summary, requirements, decisions, action items, spec with editable build prompt, approve → build in a project (`meetings.approveSpec`), GDPR delete |
| `settings` | Language (device / Svenska / English), account, sign out (revokes the session) |

## Architecture

- **Auth**: session token in `expo-secure-store` (Keychain/Keystore, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), sent as
  `Authorization: Bearer` on every tRPC call (`credentials: "omit"` so the API's cookie is never used). An
  `UNAUTHORIZED` response signs out locally. WebSockets pass the token as `?token=` because the gateway only reads
  cookie/query (see "API changes" below).
- **tRPC v11** (`@trpc/react-query`, `superjson`), `import type { AppRouter } from "@forge/api"` (type-only).
- **Pure logic in `src/lib/`** (no React Native imports, unit-tested in node):
  - `events.ts` — zod parsing of gateway frames (checked at compile time against `@forge/shared`'s `ForgeEvent`),
    history replay and a deduplicating timeline reducer (history + live overlap on reconnect).
  - `ws.ts` — ws(s) URL building, jittered exponential backoff, `ReconnectingSocket` (ping, reconnect, stop on
    4400/4403/4501) with injected socket + timers.
  - `chunks.ts` — chunk planning, `ResumableUploader` and `KeyValueUploadStore`.
  - `audio-protocol.ts` — voice streaming protocol, transcript reducer, PCM helpers, bounded send queue.
  - `i18n.ts` — typed keys, `{param}` interpolation, plural objects via `Intl.PluralRules`, locale picking.
  - `preview.ts`, `qr.ts`, `meeting.ts`, `auth.ts`, `format.ts`.
- **Native glue** in `src/` (`api.tsx`, `uploads.tsx`, `i18n.tsx`, `storage.ts`, hooks, components) and `app/` routes.

### Meeting uploads (resumable)

1. Stop recording → the file (in the app's document directory) is registered locally as status `local`
   (no network needed, so a meeting that ends offline is never lost).
2. `meetings.startRecording` creates the meeting + upload (2 MiB chunks) → status `uploading`.
3. For every chunk the server is missing (`meetings.uploadStatus` is the source of truth): read only that byte
   range (`expo-file-system` `FileHandle`), SHA-256 it (`expo-crypto`), `PUT /uploads/:uploadId/:index` with
   `x-chunk-sha256` and an octet-stream body (`expo/fetch`). Two in parallel; network/5xx/429/400 retried with
   backoff (re-reading and re-hashing); state persisted to AsyncStorage after each chunk.
4. Verify with `uploadStatus`, then `meetings.completeRecording` → `done`; the local file is deleted.
5. Resumes on launch, sign-in, app foreground and network regain (`expo-network`). `404` → `expired` (offer
   "Upload again", which re-creates the upload for the same file); `401` pauses until sign-in.

### Voice protocol (client side, `src/lib/audio-protocol.ts`)

Client sends `{"type":"start","encoding":"pcm_s16le","sampleRate":16000,"channels":1,"language":"sv"}`, then
binary little-endian int16 PCM frames from `expo-audio`'s `useAudioStream`, then `{"type":"stop"}`. The client
accepts `{"type":"transcript","text","isFinal"}` (also `partial`/`final`, `transcript`/`is_final` spellings),
`{"type":"error","message"}` and `{"type":"done"}`. Close code 4501 shows "live transcription isn't available".

## Accessibility

Every control has `accessibilityRole`/`accessibilityLabel` (and state: selected, checked, busy, disabled);
progress bars expose `accessibilityValue`; status/errors use live regions; chat rows are announced as single
units; touch targets ≥ 48 pt; text scales with the OS setting (only dense chrome caps at 1.6×); colours meet
WCAG AA on the dark background (see `src/theme.ts`); state is never colour-only.

## i18n

`src/i18n/{en,sv}.json`. Every UI string goes through `t()`. `test/i18n.test.ts` enforces identical key sets,
non-empty strings, matching `{placeholders}` and that Swedish strings are actually translated.

## Scripts

```bash
pnpm --filter @forge/mobile start         # Expo dev server (EXPO_PUBLIC_API_URL=http://<LAN-IP>:4000 for a device)
pnpm --filter @forge/mobile test          # vitest, src/lib
pnpm --filter @forge/mobile typecheck     # scripts/typecheck.mjs (tsc API; see below)
pnpm --filter @forge/mobile lint
pnpm --filter @forge/mobile export:web    # expo export --platform web → dist/
pnpm --filter @forge/mobile test:e2e      # web build + real API + headless Chromium (docker stack up)
pnpm --filter @forge/mobile doctor        # expo-doctor
```

`typecheck` runs the same check as `tsc -p tsconfig.json --noEmit` and fails on any error in this app. Because
`import type { AppRouter }` makes tsc check the API's *source* (and `@forge/shared`) under Expo's ambient types —
where `expo-modules-core` declares `ProcessEnv` with `[key: string]: any` — one implicit-any appears inside
`packages/shared/src/env.ts`. Diagnostics in other workspace packages are printed as notes, not failures; those
packages are checked by their own `typecheck`.

## What was verified here (no device available)

- `vitest`: 56 tests (uploader resume/retry/expiry/auth/offline, reducer, socket, audio protocol, i18n parity, QR, preview, meeting view, formatting).
- `typecheck` and `lint` green.
- `expo export --platform web` bundles all routes (Metro, 1046 modules).
- `expo-doctor`: 18/20 checks pass; the 2 failures need network access to exp.host / React Native Directory.
- `test:e2e` on the web build against the real API: sign-in, projects, chat history, live WebSocket event,
  API error display, web preview iframe, meetings, record consent screen, Swedish switch, no page errors.
- **Not verified**: native microphone streaming, native recording/background audio, chunk reads via
  `FileHandle`, SecureStore, Expo Go deep links and the native WebView. These need a device or simulator.

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `EXPO_PUBLIC_API_URL` | `app.json` `extra.apiUrl` → `http://localhost:4000` | Inlined at bundle time; use a LAN IP on devices |

## Limitations

- JS doesn't run while the app is suspended, so uploads pause in the background and resume on foreground or
  network regain (state is persisted per chunk). A native background upload task would remove this limitation.
- Uploads start after the recording stops, because `startRecording` needs the total size up front and an
  in-progress AAC file isn't finalised.
- The voice server half (`AudioStreamHandler`) isn't wired in `apps/api` yet; until it is, the voice screen shows
  "Live transcription isn't available" and the user can type instead.
- Magic links in emails point to the web app (`APP_URL/auth/magic`); on a phone, paste the link or configure
  universal links/app links for that domain to open `auth/magic` directly.
