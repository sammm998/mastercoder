import { costFor, getModels, textOf, type LLMProvider } from "@forge/llm";
import type { ChatRequest, ImageRequest, TtsRequest } from "./protocol.js";

/**
 * Minimal provider interfaces the gateway routes to. Real image/speech adapters live in the media
 * and speech packages; the platform wires them in. Every result carries its provider cost in USD.
 */
export interface GatewayChatProvider {
  readonly name: string;
  chat(req: ChatRequest, ctx: { projectId: string }): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  /** Upper-bound cost of a request, used for spend-cap checks before calling. */
  estimateUsd?(req: ChatRequest): number;
}

export interface GatewayImageProvider {
  readonly name: string;
  generate(req: ImageRequest, ctx: { projectId: string }): Promise<{ images: Array<{ mediaType: string; data: Uint8Array }>; model: string; costUsd: number }>;
  estimateUsd?(req: ImageRequest): number;
}

export interface GatewaySttProvider {
  readonly name: string;
  transcribe(req: { audio: Uint8Array; mediaType: string; language?: string }, ctx: { projectId: string }): Promise<{ text: string; durationSec: number; language?: string; model: string; costUsd: number }>;
  estimateUsd?(req: { audio: Uint8Array; mediaType: string }): number;
}

export interface GatewayTtsProvider {
  readonly name: string;
  synthesize(req: TtsRequest, ctx: { projectId: string }): Promise<{ audio: Uint8Array; mediaType: string; durationSec: number; model: string; costUsd: number }>;
  estimateUsd?(req: TtsRequest): number;
}

export interface GatewayProviders {
  chat?: GatewayChatProvider;
  image?: GatewayImageProvider;
  stt?: GatewaySttProvider;
  tts?: GatewayTtsProvider;
}

/** Chat via any @forge/llm provider (Anthropic/OpenAI/mock). Cost comes from @forge/llm pricing. */
export class LLMChatProvider implements GatewayChatProvider {
  readonly name: string;
  constructor(private readonly llm: LLMProvider, private readonly models = getModels()) {
    this.name = `llm:${llm.name}`;
  }
  private model(tier: ChatRequest["tier"]): string {
    return tier === "fast" ? this.models.fast : tier === "smart" ? this.models.planner : this.models.builder;
  }
  estimateUsd(req: ChatRequest): number {
    const chars = (req.system?.length ?? 0) + req.messages.reduce((a, m) => a + m.content.length, 0);
    return costFor(this.model(req.tier), { inputTokens: Math.ceil(chars / 4), outputTokens: req.maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }
  async chat(req: ChatRequest, ctx: { projectId: string }) {
    const r = await this.llm.complete({
      purpose: "appkit.gateway.chat",
      model: this.model(req.tier),
      system: req.system,
      messages: req.messages,
      maxTokens: req.maxTokens,
    });
    void ctx;
    return { text: textOf(r), model: r.model, inputTokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens, outputTokens: r.usage.outputTokens, costUsd: r.costUsd };
  }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

/** MOCK image provider: renders an SVG card that says "[mock image]" plus the prompt. Costs 0. */
export class MockGatewayImageProvider implements GatewayImageProvider {
  readonly name = "mock";
  async generate(req: ImageRequest) {
    const [w, h] = req.size.split("x").map(Number) as [number, number];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#e9e9e4"/><text x="50%" y="45%" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#555">[mock image]</text><text x="50%" y="55%" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#777">${escapeXml(req.prompt.slice(0, 80))}</text></svg>`;
    const images = Array.from({ length: req.n }, () => ({ mediaType: "image/svg+xml", data: new TextEncoder().encode(svg) }));
    return { images, model: "mock-image", costUsd: 0 };
  }
}

/** MOCK speech-to-text: returns a labeled placeholder transcript describing the audio size. Costs 0. */
export class MockGatewaySttProvider implements GatewaySttProvider {
  readonly name = "mock";
  async transcribe(req: { audio: Uint8Array; mediaType: string; language?: string }) {
    // 16 kB/s ≈ 128 kbps; good enough for a deterministic duration figure.
    const durationSec = Math.round((req.audio.byteLength / 16_000) * 10) / 10;
    return { text: `[mock transcription of ${req.audio.byteLength} bytes of ${req.mediaType}]`, durationSec, language: req.language, model: "mock-stt", costUsd: 0 };
  }
}

/** MOCK text-to-speech: returns a real, silent 16 kHz mono WAV whose length follows the text. Costs 0. */
export class MockGatewayTtsProvider implements GatewayTtsProvider {
  readonly name = "mock";
  async synthesize(req: TtsRequest) {
    const durationSec = Math.min(60, Math.max(0.5, req.text.length / 15));
    const rate = 16_000;
    const samples = Math.round(durationSec * rate);
    const buf = Buffer.alloc(44 + samples * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + samples * 2, 4);
    buf.write("WAVEfmt ", 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(samples * 2, 40);
    return { audio: new Uint8Array(buf), mediaType: "audio/wav", durationSec, model: "mock-tts", costUsd: 0 };
  }
}
