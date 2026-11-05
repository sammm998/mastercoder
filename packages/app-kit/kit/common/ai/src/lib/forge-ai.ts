// @forge-kit:server-only
/**
 * Forge AI gateway client: chat, image generation, speech-to-text and text-to-speech.
 * SERVER-SIDE ONLY: FORGE_PROJECT_TOKEN must never reach the browser (the gateway rejects
 * browser requests). Usage is metered per project and capped by the project's spending limit.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  system?: string;
  maxTokens?: number;
  /** fast = cheapest, standard = default, smart = most capable. */
  tier?: "fast" | "standard" | "smart";
}

export interface ChatResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
}

export interface ImageResult {
  images: Array<{ mediaType: string; data: Uint8Array }>;
  model: string;
  costUsd: number;
}

export interface TranscriptResult {
  text: string;
  durationSec: number;
  language?: string;
  model: string;
  costUsd: number;
}

export interface SpeechResult {
  audio: Uint8Array;
  mediaType: string;
  model: string;
  costUsd: number;
}

export class ForgeAIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ForgeAIError";
  }
}

function config(): { url: string; token: string } {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") throw new Error("forge-ai is server-side only");
  const url = process.env.FORGE_AI_GATEWAY_URL;
  const token = process.env.FORGE_PROJECT_TOKEN;
  if (!url || !token) throw new Error("FORGE_AI_GATEWAY_URL and FORGE_PROJECT_TOKEN must be set");
  return { url: url.replace(/\/$/, ""), token };
}

async function post(route: "chat" | "image" | "stt" | "tts", body: unknown, timeoutMs = 120_000): Promise<Response> {
  const { url, token } = config();
  const res = await fetch(`${url}/v1/${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ForgeAIError(err.message ?? `Forge AI ${route} failed (${res.status})`, res.status, err.error ?? "error");
  }
  return res;
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const res = await post("chat", { messages, system: opts.system, maxTokens: opts.maxTokens, tier: opts.tier });
  return (await res.json()) as ChatResult;
}

/** Convenience: single prompt → text. */
export async function ask(prompt: string, opts: ChatOptions = {}): Promise<string> {
  return (await chat([{ role: "user", content: prompt }], opts)).text;
}

export async function generateImage(prompt: string, opts: { size?: "1024x1024" | "1024x1536" | "1536x1024"; n?: number } = {}): Promise<ImageResult> {
  const res = await post("image", { prompt, size: opts.size, n: opts.n }, 300_000);
  const body = (await res.json()) as { images: Array<{ mediaType: string; data: string }>; model: string; costUsd: number };
  return { ...body, images: body.images.map((i) => ({ mediaType: i.mediaType, data: Uint8Array.from(Buffer.from(i.data, "base64")) })) };
}

export async function speechToText(audio: Uint8Array, mediaType: string, opts: { language?: string } = {}): Promise<TranscriptResult> {
  const res = await post("stt", { audio: Buffer.from(audio).toString("base64"), mediaType, language: opts.language }, 300_000);
  return (await res.json()) as TranscriptResult;
}

export async function textToSpeech(text: string, opts: { voice?: string; format?: "mp3" | "wav"; language?: string } = {}): Promise<SpeechResult> {
  const res = await post("tts", { text, voice: opts.voice, format: opts.format, language: opts.language });
  return {
    audio: new Uint8Array(await res.arrayBuffer()),
    mediaType: res.headers.get("content-type") ?? "audio/mpeg",
    model: res.headers.get("x-forge-model") ?? "unknown",
    costUsd: Number(res.headers.get("x-forge-cost-usd") ?? 0),
  };
}
