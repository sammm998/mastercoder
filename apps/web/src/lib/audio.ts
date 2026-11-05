/** Mic → PCM16 @ 16 kHz for the streaming speech gateway (/ws/audio/:projectId). */

export const TARGET_RATE = 16_000;

/** Average-downsample mono float samples from `inRate` to `outRate` (outRate <= inRate). */
export function downsample(input: Float32Array, inRate: number, outRate: number = TARGET_RATE): Float32Array {
  if (outRate === inRate) return input;
  if (outRate > inRate) throw new Error("Upsampling is not supported");
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const end = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = pos; j < end; j++) {
      sum += input[j]!;
      n++;
    }
    out[i] = n ? sum / n : 0;
    pos = end;
  }
  return out;
}

/** Clamp float [-1, 1] samples to signed 16-bit little-endian PCM. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export const TranscriptMessage = {
  parse(raw: unknown): { type: "transcript.partial" | "transcript.final"; text: string } | null {
    if (typeof raw !== "string") return null;
    try {
      const v = JSON.parse(raw) as { type?: unknown; text?: unknown };
      if ((v.type === "transcript.partial" || v.type === "transcript.final") && typeof v.text === "string") return { type: v.type, text: v.text };
    } catch {
      /* not JSON */
    }
    return null;
  },
};

export interface VoiceCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(code: "denied" | "unsupported" | "not_configured" | "connection"): void;
  onLevel?(level: number): void;
}

/**
 * Streams microphone audio over a WebSocket. Uses a ScriptProcessorNode (no AudioWorklet module
 * load, which a strict CSP would block) and resamples to 16 kHz mono PCM16.
 */
export class VoiceStreamer {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly cb: VoiceCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return this.cb.onError("unsupported");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      return this.cb.onError("denied");
    }
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = TranscriptMessage.parse(e.data);
      if (!m) return;
      if (m.type === "transcript.partial") this.cb.onPartial(m.text);
      else this.cb.onFinal(m.text);
    };
    ws.onclose = (e) => {
      if (this.stopped) return;
      this.cb.onError(e.code === 4501 ? "not_configured" : "connection");
      this.teardownAudio();
    };
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(this.stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    this.node = node;
    node.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      if (this.cb.onLevel) {
        let peak = 0;
        for (let i = 0; i < input.length; i += 64) peak = Math.max(peak, Math.abs(input[i]!));
        this.cb.onLevel(peak);
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const pcm = floatTo16BitPCM(downsample(input, ctx.sampleRate));
      ws.send(pcm.buffer);
    };
    source.connect(node);
    // ScriptProcessor only runs while connected to the destination; the output buffer stays silent.
    node.connect(ctx.destination);
  }

  /** Stop capturing; keep the socket briefly so the final transcript can arrive. */
  stop(graceMs = 1500): void {
    this.stopped = true;
    this.teardownAudio();
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    window.setTimeout(() => ws.close(1000, "done"), graceMs);
  }

  private teardownAudio() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
