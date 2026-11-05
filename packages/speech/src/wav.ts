/**
 * WAV (RIFF) utilities. Isomorphic: only DataView/Uint8Array, no Node Buffer, no DOM.
 */

export interface WavInfo {
  /** 1 = PCM integer, 3 = IEEE float, 0xFFFE = extensible. */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  /** Byte offset of the first sample in the file. */
  dataOffset: number;
  /** Size of the sample data in bytes (clamped to what is actually present). */
  dataLength: number;
  durationSec: number;
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavFormatError";
  }
}

function ascii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return ascii(v, 0, 4) === "RIFF" && ascii(v, 8, 4) === "WAVE";
}

/** Parse a RIFF/WAVE header (walks chunks, so LIST/fact chunks before `data` are fine). */
export function decodeWavHeader(bytes: Uint8Array): WavInfo {
  if (!isWav(bytes)) throw new WavFormatError("Not a RIFF/WAVE file");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataLength" | "durationSec"> | undefined;
  while (off + 8 <= bytes.byteLength) {
    const id = ascii(v, off, 4);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw new WavFormatError("Truncated fmt chunk");
      fmt = {
        audioFormat: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        byteRate: v.getUint32(body + 8, true),
        blockAlign: v.getUint16(body + 12, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) throw new WavFormatError("data chunk before fmt chunk");
      // Streaming writers put 0 or 0xFFFFFFFF as size; clamp to the bytes we have.
      const available = bytes.byteLength - body;
      const dataLength = size === 0 || size === 0xffffffff ? available : Math.min(size, available);
      const durationSec = fmt.byteRate > 0 ? dataLength / fmt.byteRate : 0;
      return { ...fmt, dataOffset: body, dataLength, durationSec };
    }
    off = body + size + (size % 2); // chunks are word aligned
  }
  throw new WavFormatError("No data chunk found");
}

/** Sample bytes (little-endian PCM) of a WAV file, without copying. */
export function wavPcm(bytes: Uint8Array): { info: WavInfo; pcm: Uint8Array } {
  const info = decodeWavHeader(bytes);
  return { info, pcm: bytes.subarray(info.dataOffset, info.dataOffset + info.dataLength) };
}

export interface EncodeWavOptions {
  sampleRate: number;
  channels?: number;
}

/** Wrap 16-bit little-endian PCM (as Int16Array or raw bytes) in a canonical 44-byte WAV header. */
export function encodeWav(pcm: Int16Array | Uint8Array, opts: EncodeWavOptions): Uint8Array {
  const channels = opts.channels ?? 1;
  const bytes = pcm instanceof Int16Array ? int16ToBytes(pcm) : pcm;
  if (bytes.byteLength % 2 !== 0) throw new WavFormatError("PCM16 data must have an even byte length");
  const out = new Uint8Array(44 + bytes.byteLength);
  const v = new DataView(out.buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + bytes.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, opts.sampleRate, true);
  v.setUint32(28, opts.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, bytes.byteLength, true);
  out.set(bytes, 44);
  return out;
}

/** Little-endian bytes of an Int16Array (copy; endianness-safe). */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) v.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(n);
  const v = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true);
  return out;
}

/** Browser mic helper: Float32 [-1,1] samples (Web Audio) → Int16 PCM. */
export function floatTo16BitPcm(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Linear-interpolation resampler (e.g. 48 kHz mic → 16 kHz for STT). */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = pos - i0;
    out[i] = (samples[i0] ?? 0) * (1 - t) + (samples[i1] ?? 0) * t;
  }
  return out;
}

/** Split raw PCM16 bytes into chunks of `chunkMs` (frame aligned). */
export function chunkPcm(pcm: Uint8Array, opts: { sampleRate: number; channels?: number; chunkMs: number }): Uint8Array[] {
  const frame = 2 * (opts.channels ?? 1);
  const size = Math.max(frame, Math.floor((opts.sampleRate * opts.chunkMs) / 1000) * frame);
  const out: Uint8Array[] = [];
  for (let o = 0; o < pcm.byteLength; o += size) out.push(pcm.subarray(o, Math.min(o + size, pcm.byteLength)));
  return out;
}

/** Split a PCM16 WAV file into standalone WAV files of at most `chunkSec` seconds each. */
export function splitWav(wav: Uint8Array, chunkSec: number): Array<{ startSec: number; wav: Uint8Array }> {
  const { info, pcm } = wavPcm(wav);
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) throw new WavFormatError("splitWav supports PCM16 only");
  const parts = chunkPcm(pcm, { sampleRate: info.sampleRate, channels: info.channels, chunkMs: chunkSec * 1000 });
  let start = 0;
  return parts.map((p) => {
    const r = { startSec: start, wav: encodeWav(p, { sampleRate: info.sampleRate, channels: info.channels }) };
    start += p.byteLength / info.byteRate;
    return r;
  });
}

/** Seconds of audio in raw PCM16 bytes. */
export function pcmDurationSec(byteLength: number, sampleRate: number, channels = 1): number {
  return byteLength / (sampleRate * channels * 2);
}
