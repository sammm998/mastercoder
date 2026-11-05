import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bytesToInt16,
  chunkPcm,
  decodeWavHeader,
  encodeWav,
  floatTo16BitPcm,
  int16ToBytes,
  isWav,
  pcmDurationSec,
  resampleLinear,
  splitWav,
  wavPcm,
  WavFormatError,
} from "../src/wav.js";
import { base64ToBytes, bytesToBase64 } from "../src/base64.js";

function tone(sec: number, rate = 16000, hz = 440): Int16Array {
  const n = Math.round(sec * rate);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000);
  return s;
}

describe("wav", () => {
  it("encodes PCM16 and decodes the header back", () => {
    const pcm = tone(1.5);
    const wav = encodeWav(pcm, { sampleRate: 16000 });
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    expect(isWav(wav)).toBe(true);
    const info = decodeWavHeader(wav);
    expect(info).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataOffset: 44, dataLength: pcm.length * 2 });
    expect(info.durationSec).toBeCloseTo(1.5, 6);
    expect(Array.from(bytesToInt16(wavPcm(wav).pcm).slice(0, 50))).toEqual(Array.from(pcm.slice(0, 50)));
  });

  it("walks extra chunks (LIST) before data", () => {
    const base = encodeWav(tone(0.1), { sampleRate: 16000 });
    const list = new Uint8Array(8 + 6);
    list.set([0x4c, 0x49, 0x53, 0x54, 6, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
    const wav = new Uint8Array(base.byteLength + list.byteLength);
    wav.set(base.subarray(0, 36));
    wav.set(list, 36);
    wav.set(base.subarray(36), 36 + list.byteLength);
    const info = decodeWavHeader(wav);
    expect(info.dataOffset).toBe(44 + list.byteLength);
    expect(info.durationSec).toBeCloseTo(0.1, 6);
  });

  it("decodes the real Swedish fixture", () => {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL("../../../evals/fixtures/voice/todo-sv.wav", import.meta.url))));
    const info = decodeWavHeader(bytes);
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.durationSec).toBeGreaterThan(2);
  });

  it("rejects non-WAV input", () => {
    expect(isWav(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(() => decodeWavHeader(new TextEncoder().encode("OggS........."))).toThrow(WavFormatError);
  });

  it("splits into chunks", () => {
    const pcm = int16ToBytes(tone(2.5));
    const chunks = chunkPcm(pcm, { sampleRate: 16000, chunkMs: 1000 });
    expect(chunks.map((c) => c.byteLength)).toEqual([32000, 32000, 16000]);
    const parts = splitWav(encodeWav(pcm, { sampleRate: 16000 }), 1);
    expect(parts.map((p) => p.startSec)).toEqual([0, 1, 2]);
    expect(decodeWavHeader(parts[2]!.wav).durationSec).toBeCloseTo(0.5, 6);
    expect(pcmDurationSec(32000, 16000)).toBe(1);
  });

  it("converts float frames and resamples", () => {
    expect(Array.from(floatTo16BitPcm(new Float32Array([0, 1, -1, 2])))).toEqual([0, 32767, -32768, 32767]);
    const r = resampleLinear(new Float32Array(48000), 48000, 16000);
    expect(r.length).toBe(16000);
  });
});

describe("base64", () => {
  it("round-trips and matches Buffer", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 100, 1001]) {
      const b = new Uint8Array(len).map((_, i) => (i * 37 + 11) % 256);
      const s = bytesToBase64(b);
      expect(s).toBe(Buffer.from(b).toString("base64"));
      expect(Array.from(base64ToBytes(s))).toEqual(Array.from(b));
    }
    expect(() => base64ToBytes("ab$c")).toThrow();
  });
});
