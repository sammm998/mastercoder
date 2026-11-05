import { env, selectAdapter, type UsageSink } from "@forge/shared";
import type { MeterContext, SttProvider } from "./types.js";
import { MockSttProvider, type MockTranscriptRegistry } from "./mock.js";
import { ElevenLabsSttProvider } from "./adapters/elevenlabs.js";
import { DeepgramSttProvider } from "./adapters/deepgram.js";
import { WhisperSttProvider } from "./adapters/whisper.js";
import { whisperPrice } from "./pricing.js";

export interface CreateSttOptions {
  usage?: UsageSink;
  meter?: MeterContext;
  /** Mock only: fixture registry (defaults to the process-wide registry). */
  registry?: MockTranscriptRegistry;
}

export const STT_PROVIDER_NAMES = ["elevenlabs", "deepgram", "whisper", "mock"] as const;

/**
 * STT_PROVIDER=elevenlabs|deepgram|whisper|mock (fallback mock).
 * ElevenLabs Scribe is the recommended real default; whisper for audio that must stay on Forge's EU servers.
 */
export function createSttProvider(o: CreateSttOptions = {}): SttProvider {
  return selectAdapter<SttProvider>(
    "STT_PROVIDER",
    {
      elevenlabs: () =>
        new ElevenLabsSttProvider({
          apiKey: env("ELEVENLABS_API_KEY"),
          baseUrl: process.env.ELEVENLABS_BASE_URL || undefined,
          model: process.env.ELEVENLABS_STT_MODEL || undefined,
          usage: o.usage,
          meter: o.meter,
        }),
      deepgram: () =>
        new DeepgramSttProvider({
          apiKey: env("DEEPGRAM_API_KEY"),
          baseUrl: process.env.DEEPGRAM_BASE_URL || undefined,
          model: process.env.DEEPGRAM_MODEL || undefined,
          usage: o.usage,
          meter: o.meter,
        }),
      whisper: () => {
        const model = process.env.WHISPER_MODEL || "KBLab/kb-whisper-large";
        return new WhisperSttProvider({
          baseUrl: env("WHISPER_URL"),
          model,
          apiKey: process.env.WHISPER_API_KEY || undefined,
          price: whisperPrice(model, Number(process.env.WHISPER_GPU_USD_PER_HOUR || 0.27), Number(process.env.WHISPER_REALTIME_FACTOR || 10)),
          usage: o.usage,
          meter: o.meter,
        });
      },
      mock: () => new MockSttProvider({ registry: o.registry, usage: o.usage, meter: o.meter }),
    },
    "mock",
  ).instance;
}
