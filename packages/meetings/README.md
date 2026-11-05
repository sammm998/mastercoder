# @forge/meetings

Meetings in Forge become build specs. This package covers the bot that joins Zoom/Teams/Meet calls, in-person
recordings uploaded from the mobile app (chunked and resumable), consent and GDPR retention, calendar sync, and the
pipeline: transcript, then extraction, then spec, which waits for a human to approve it before anything is built.

## Public API

```ts
// Meeting bots
interface MeetingBotProvider {
  name; isMock; postsConsentOnJoin; supportsScheduledJoin;
  join({ meetingUrl, botName = "Forge notetaker", consentMessage?, language = "sv", webhookUrl?, joinAt? }): Promise<{ botId, status }>;
  leave(botId); getStatus(botId); sendChatMessage(botId, text);
  getTranscript(botId): Promise<Transcript>; getRecordingUrl(botId): Promise<string | null>;
  parseWebhook(headers, body): Promise<MeetingEvent[]>;  // bot.joining | bot.in_call | bot.left | transcript.segment | chat.message | recording.ready | bot.error
  estimate(hours): CostEstimate;
}
createMeetingBotProvider({ usage?, meter?, mock? })     // MEETING_BOT_PROVIDER=recall|meetstream|vexa|mock (fallback mock)
parseMeetingUrl(url) → { platform: "zoom"|"teams"|"google_meet", nativeId, passcode?, url }; findMeetingUrl(text)

// Consent & GDPR
consentMessage(botName) (sv + en) · isStopRequest(text) · new ConsentGuard({ bots, repo? }).handle(event)
retentionUntil(policy, kind, from?) · retentionFor(policy) · purgeExpired(repo, store, now?) · deleteMeeting(id, { repo, store, chunks? })
MeetingRepo / InMemoryMeetingRepo

// Calendar
CalendarProvider.listEvents({ from, to }) — GoogleCalendarProvider, MicrosoftCalendarProvider, MockCalendarProvider
createCalendarProvider({ accessToken })                 // CALENDAR_PROVIDER=google|microsoft|mock (fallback mock)
scheduleBotsForUpcoming({ calendar, bots, windowMinutes, alreadyScheduled, now?, ... }) → { scheduled, skipped }

// In-person recordings
new ChunkedUploadService(store, chunkRepo).init/putChunk/status/complete
InMemoryChunkRepo · DrizzleChunkRepo(db)                 // upload_chunks table in @forge/db

// Pipeline
processMeeting({ meetingId?, audio? | transcript?, language, diarize? }, { llm, stt?, usage?, events?, projectId?, repo? })
  → { status: "awaiting_approval", transcript, extraction, spec }
approveSpec(spec) → build prompt for the intent router · approveMeeting(meetingId, repo)
```

LLM purposes: `meetings.extract` (summary, decisions, requirements as user stories with priority, open questions, action
items with owners/due) and `meetings.spec` (title, goals, userStories, entities with fields/relations, screens,
integrations, suggestedIntents, acceptanceCriteria, openQuestions). Both are validated with zod (`ExtractionSchema`,
`MeetingSpecSchema`) through `structured()`. Importing the package registers rule-based mock handlers
(`src/mock-llm.ts`, logic in `src/rules.ts`), so `LLM_PROVIDER=mock` runs the whole flow. Mock output carries
`generator: "mock-rules"` and its summary is labelled as a mock. The pipeline emits `phase.started`, `job.progress`,
`plan.ready` (`requiresApproval: true`) and `phase.completed`.

## Providers

| adapter | real/mock | API | env vars |
|---|---|---|---|
| `recall` | real | Recall.ai REST, EU `https://eu-central-1.recall.ai/api/v1` (`POST /bot/`, `/leave_call/`, `/send_chat_message/`, `GET /bot/{id}/`); consent via `chat.on_bot_join`; Standard Webhooks/Svix signatures | `RECALL_API_KEY`, `RECALL_REGION` (eu-central-1), `RECALL_WEBHOOK_SECRET` |
| `meetstream` | real | MeetStream REST `https://api.meetstream.ai/api/v1` (`/bots/create_bot`, `/status`, `/remove_bot`, `/get_transcript`, `/get_audio`, `/send_message`*) | `MEETSTREAM_API_KEY`, `MEETSTREAM_BASE_URL`?, `MEETSTREAM_WEBHOOK_SECRET`, `MEETSTREAM_USD_PER_HOUR`? |
| `vexa` | real (self-hosted, EU) | Vexa (`POST /bots`, `DELETE /bots/{platform}/{id}`, `GET /meetings`, `GET /transcripts/{platform}/{id}`, `POST …/chat`*), `X-API-Key` | `VEXA_URL`, `VEXA_API_KEY`, `VEXA_WEBHOOK_SECRET`, `VEXA_USD_PER_HOUR`? |
| `mock` | mock | simulated lifecycle on an injectable clock (`ManualClock`), HMAC-signed mock webhooks, transcript is an injected fixture | – |
| calendar `google` | real | Calendar API v3 `events.list` (conferenceData / hangoutLink / links in location or description) | OAuth token injected (`GOOGLE_CLIENT_ID/SECRET` live in the connection layer) |
| calendar `microsoft` | real | Graph `/me/calendarView` (`onlineMeeting.joinUrl`), `Prefer: outlook.timezone="UTC"` | OAuth token injected (`MICROSOFT_CLIENT_ID/SECRET`) |
| calendar `mock` | mock | in-memory events | `CALENDAR_PROVIDER` |

\* Endpoints marked * are assumed from the vendor's public docs and could not be checked from the build environment
(vendor hosts blocked, no keys). They are kept inside each adapter.

Bot cost (`bot_hours` usage, `src/pricing.ts`): Recall $0.50/h + $0.15/h transcription (recall.ai/pricing, 2025-Q4);
MeetStream $0.35/h (meetstream.ai/pricing, 2025-Q4, not re-verified); Vexa self-hosted about $0.01/bot-hour (Hetzner
CPX41 cost model); mock $0. Recall meters from the `in_call*` time to the `call_ended` time when status reaches
done; Vexa uses the meeting's start/end; MeetStream uses the transcript span.

## Consent & GDPR

- The bot always joins under a visible, non-empty name (default "Forge notetaker"; enforced by zod).
- A bilingual (sv + en) recording notice is posted in the meeting chat on join. Recall, MeetStream and the mock post
  it natively; for Vexa, `ConsentGuard` posts it on `bot.in_call`. Either way `consentNoticePosted` is set.
- Participants who type "Forge leave", "Forge lämna", "sluta spela in", "stop recording", "stoppa inspelningen",
  "lämna mötet", or just "lämna"/"leave" on its own trigger: an acknowledgement in chat, `leave()`, and
  `stopRequest {by, text, at}` on the meeting. The bot's own messages are ignored. "lämna" inside a normal sentence
  ("jag ska lämna in rapporten") is not a stop request.
- Retention per kind (`DEFAULT_RETENTION`): audio 30 days, transcript 180 days, extraction and spec 365 days.
  `purgeExpired` is idempotent and cron-safe. `deleteMeeting` (right to erasure) removes every object under
  `meetings/<id>/`, the transcript, extraction, spec and any in-flight upload chunks, and leaves a `deleted` tombstone.
- Webhooks are rejected unless they are authenticated: Recall by signature, MeetStream and Vexa by a `forge_token`
  that Forge appends to the callback URL (the API layer copies it into the `x-forge-webhook-token` header). The only
  way to accept unsigned deliveries is `MEETINGS_ALLOW_UNSIGNED_WEBHOOKS=true`, and it is ignored in production.

## Chunked upload

`init({ meetingId, totalSize, mimeType, chunkSize, sha256? })` stores a manifest at `uploads/<uploadId>/manifest.json`.
`putChunk` checks the index range, the exact chunk size and the sha256. Re-sending an identical chunk returns
`duplicate`; different bytes for a stored index are rejected. `status` returns `received` and `missing` so the client
can resume. `complete` concatenates the chunks in order into `meetings/<id>/audio.<ext>`, verifies the total size (and
the optional whole-file sha256), then deletes the chunks. It is idempotent.

## New env vars

`RECALL_WEBHOOK_SECRET`, `MEETSTREAM_BASE_URL`, `MEETSTREAM_WEBHOOK_SECRET`, `MEETSTREAM_USD_PER_HOUR`,
`VEXA_WEBHOOK_SECRET`, `VEXA_USD_PER_HOUR`, `CALENDAR_PROVIDER`, `MEETINGS_ALLOW_UNSIGNED_WEBHOOKS` (dev only).

## Tests

`pnpm --filter @forge/meetings test` runs the unit tests (stubbed `fetch`, no network). `test:integration` exercises
`DrizzleChunkRepo` on docker Postgres and `ChunkedUploadService` on SeaweedFS S3. `test/pipeline.test.ts` runs the
Swedish salon meeting fixture (`evals/fixtures/meetings/salong-mote.sv.txt`) through the mock pipeline and checks that
the requirements and booking entities come out.

## Limitations

- Vendor APIs are unit-tested against their documented request/response shapes with stubbed `fetch`. No live calls
  were made.
- The mock extraction is heuristic (cue phrases, suffix-stripping lemmatizer, frequency ranking). Expect awkward user
  stories for sentences without a clear cue. It is meant for offline runs and tests, not as a substitute for the model.
- `MeetingRepo` has only an in-memory implementation. The `meetings` table in `@forge/db` has a single
  `retention_until` column and no `stop_request`/per-kind retention, so a DB-backed repo needs schema additions
  (see the report).
- `complete()` assembles the recording in memory: `ObjectStore` has no multipart/streaming put. Default cap is 5 GiB;
  keep mobile uploads well below that, or add S3 multipart to `ObjectStore`.
- Vexa and MeetStream join immediately. `scheduleBotsForUpcoming` defers their future joins to a later run inside
  the lead time.
