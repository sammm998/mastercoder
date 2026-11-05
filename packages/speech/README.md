# @forge/speech

Speech-to-text for Forge: voice prompts (web + mobile mic streaming over the WebSocket gateway), in-person
meeting recordings and meeting-bot audio. Swedish (`sv`) and English (`en`) are first-class.

## Public API

```ts
interface SttProvider {
  name; isMock; model;
  transcribe(audio: Uint8Array, { mimeType, language: "sv"|"en"|string, diarize? }): Promise<Transcript>;
  openStream({ language, sampleRate, encoding: "pcm16"|"opus", channels?, diarize? }): Promise<SttStream>;
  estimate(durationSec, { streaming?, diarize? }?): CostEstimate;
}
interface SttStream { send(chunk); on("partial"|"final"|"error", cb); close(): Promise<Transcript> }
interface Transcript { text; language; durationSec; segments: {start,end,text,speaker?}[]; words?: {text,start,end,speaker?}[]; provider; model }

createSttProvider({ usage?, meter?, registry? })        // STT_PROVIDER=elevenlabs|deepgram|whisper|mock (fallback mock)
wer(ref, hyp, { language, numbers? }) / cer(...)       // real Levenshtein WER/CER; werDetails/cerDetails give S/D/I counts
normalizeText(text, { language, numbers? })             // lowercase, strip punctuation, unify whitespace, keep å/ä/ö, numbers→digits
encodeWav / decodeWavHeader / wavPcm / splitWav / chunkPcm / floatTo16BitPcm / resampleLinear
normalizeSpeakers / segmentsFromWords / SpeakerLabeler   // vendor speaker ids → "Speaker 1", "Speaker 2", …
MockSttProvider / MockTranscriptRegistry / mockTranscriptRegistry / sha256Hex
STT_PRICES / whisperPrice / sttEstimate / recordTranscription
// streaming over the Forge gateway
AudioStreamClient (browser/Expo, import from "@forge/speech/protocol"), StreamingSessionManager (server)
```

Every finished transcription (batch or stream close) records a `transcription_minutes` `UsageRecord` with
`costUsd` into the injected `UsageSink`.

### Gateway protocol (`@forge/speech/protocol`, isomorphic, no DOM/Node types)

| direction | message |
|---|---|
| client → server | `{type:"audio.start", streamId, language, sampleRate, encoding:"pcm16"\|"opus", channels?, diarize?}` |
| client → server | `{type:"audio.chunk", streamId, seq, data: base64}` (≤ 256 KiB per chunk, duplicates by `seq` are dropped) |
| client → server | `{type:"audio.stop", streamId}` |
| server → client | `{type:"transcript.partial", streamId, text}` · `{type:"transcript.final", streamId, segment}` |
| server → client | `{type:"transcript.done", streamId, transcript}` · `{type:"transcript.error", streamId, code, message}` |

`StreamingSessionManager({ provider, send(connId, msg), onTranscript?, maxStreamsPerConnection=2, maxBytesPerStream≈1h })`:
`handle(connId, raw)` for every inbound gateway message, `disconnect(connId)` when a socket closes.

## Providers

| adapter | real/mock | endpoint | env vars |
|---|---|---|---|
| `elevenlabs` (recommended default) | real | Scribe `POST https://api.elevenlabs.io/v1/speech-to-text`; realtime `wss://…/v1/speech-to-text/realtime` (Scribe v2 Realtime, PCM only) | `ELEVENLABS_API_KEY`, `ELEVENLABS_BASE_URL`?, `ELEVENLABS_STT_MODEL`? (scribe_v1) |
| `deepgram` | real | `POST https://api.deepgram.com/v1/listen?model=nova-3&language=sv&diarize=true&smart_format=true`; `wss://api.deepgram.com/v1/listen` (linear16 or opus) | `DEEPGRAM_API_KEY`, `DEEPGRAM_BASE_URL`? (EU: `https://api.eu.deepgram.com`), `DEEPGRAM_MODEL`? |
| `whisper` | real (self-hosted, EU) | OpenAI-compatible `POST {WHISPER_URL}/v1/audio/transcriptions` (faster-whisper-server / speaches serving `KBLab/kb-whisper-large`); streaming = windowed batch | `WHISPER_URL`, `WHISPER_MODEL`?, `WHISPER_API_KEY`?, `WHISPER_GPU_USD_PER_HOUR`? (0.27), `WHISPER_REALTIME_FACTOR`? (10) |
| `mock` | mock | none — WAV-header duration; registered sha256 → fixture transcript, else `"[mock transcript: N.N s of audio]"` | – |

### Prices (provider cost, `src/pricing.ts`)

| adapter | prerecorded | streaming | diarization | source |
|---|---|---|---|---|
| ElevenLabs Scribe | $0.40/h | $0.40/h | included | elevenlabs.io/pricing/api (2025-Q4) |
| Deepgram Nova-3 (monolingual) | $0.0043/min | $0.0077/min | +$0.0020/min | deepgram.com/pricing (2025-Q4) |
| Whisper self-hosted | GPU $/h ÷ 60 ÷ realtime factor (default $0.27/h, 10×) | same | n/a | Hetzner GEX44 list price |

## New env vars

`ELEVENLABS_BASE_URL`, `ELEVENLABS_STT_MODEL`, `DEEPGRAM_BASE_URL`, `DEEPGRAM_MODEL`, `WHISPER_MODEL`, `WHISPER_API_KEY`,
`WHISPER_GPU_USD_PER_HOUR`, `WHISPER_REALTIME_FACTOR` (all optional; `STT_PROVIDER`, `ELEVENLABS_API_KEY`,
`DEEPGRAM_API_KEY`, `WHISPER_URL` already exist in `.env.example`).

## Evals

`evals/speech/` holds 6 Swedish 16 kHz mono WAVs synthesized with Piper (KBLab `sv-se-nst-medium`, CC0) plus
`evals/fixtures/voice/todo-sv.wav`, their reference texts and sha256 in `fixtures.json`
(`evals/speech/generate-fixtures.sh` regenerates them; espeak-ng fallback). `pnpm --filter @forge/speech eval:wer`
runs every configured adapter and prints WER/CER; adapters without credentials are reported as SKIPPED.
`test/evals-wer.test.ts` runs the same harness in unit tests.

## Limitations

- Vendor APIs were not called from this environment (no keys, vendor hosts blocked): request/response mapping is
  unit-tested with stubbed `fetch` and a fake WebSocket, written against the vendors' public docs. The ElevenLabs
  realtime message names (`partial_transcript`, `committed_transcript[_with_timestamps]`) follow the Scribe v2 Realtime docs.
- Mock WER is 0 by construction (sha256 registry), it validates the pipeline, not recognition quality. Real WER numbers
  need `ELEVENLABS_API_KEY` / `DEEPGRAM_API_KEY` / a `WHISPER_URL` server.
- Whisper: no diarization, no partials; streaming latency ≈ window length (8 s default). opus streaming is only supported by Deepgram.
- ElevenLabs realtime and Whisper streaming accept PCM16 only; browsers should send PCM16 (see `AudioStreamClient.sendFloat32`).
- Prices are list prices captured 2025-Q4; pass `price` to an adapter for negotiated rates.
