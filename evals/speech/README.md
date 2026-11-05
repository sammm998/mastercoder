# Speech WER eval

Swedish speech fixtures and a word-error-rate harness for every `@forge/speech` adapter.

| file | content |
|---|---|
| `audio/sv-01.wav` … `sv-06.wav` | 6 Swedish prompts, 16 kHz mono PCM16, ~4–6 s each |
| `../fixtures/voice/todo-sv.wav` | "Bygg en att-göra-app där jag kan lägga till och bocka av uppgifter." (voice-prompt fixture) |
| `fixtures.json` | reference text, sha256 and duration per file |
| `generate-fixtures.sh` | regenerates the WAVs and the manifest |
| `run-wer.ts` | runs each configured adapter and reports WER/CER |

## How the audio was made

Synthesized locally with **Piper** (`piper-tts` from PyPI) and the Swedish voice `sv-se-nst-medium`
(trained by KBLab on the NST corpus, CC0), downloaded from the rhasspy/piper GitHub release
`v0.0.2/voice-sv-se-nst-medium.tar.gz`, then resampled to 16 kHz mono with ffmpeg (bit-exact, no metadata, so the
sha256 values are stable). `espeak-ng -v sv` is the fallback when Piper is unavailable (lower quality, robotic).
This is synthetic speech: WER on it is an optimistic lower bound for real microphone audio.

## Running

```
pnpm --filter @forge/speech eval:wer          # table
npx tsx evals/speech/run-wer.ts --json        # machine-readable
```

- `mock` always runs. The mock looks the WAV's sha256 up in a registry built from `fixtures.json`, so its WER is 0 by
  construction. It checks the pipeline (WAV decoding, hashing, normalization, scoring), not recognition quality.
- `elevenlabs` / `deepgram` / `whisper` run only when `ELEVENLABS_API_KEY` / `DEEPGRAM_API_KEY` / `WHISPER_URL` are set,
  and are reported as `SKIPPED` otherwise. No real-adapter WER has been measured yet: no keys, and no reachable
  Whisper model, in the build environment.

Scoring normalizes both sides (lowercase, punctuation removed, whitespace unified, å/ä/ö kept, spelled-out numbers
mapped to digits) and reports corpus WER (total edits / total reference words) plus mean CER.
