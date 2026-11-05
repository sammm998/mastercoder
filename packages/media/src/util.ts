import { createHash } from "node:crypto";

/** 32-bit FNV-1a hash of a string (deterministic, used for seeds and mock compositions). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

/** mulberry32 PRNG: deterministic floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(s: string): boolean {
  return HEX.test(s.trim());
}

export function normalizeHex(s: string): string {
  const m = s.trim().match(HEX);
  if (!m?.[1]) throw new Error(`Not a hex color: ${s}`);
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex).slice(1);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** HSL (h in degrees, s/l in 0..1) to hex. */
export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/** Relative luminance (WCAG) of a hex color, 0..1. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Readable text color (near-black or white) for a background. */
export function readableOn(bg: string): string {
  return luminance(bg) > 0.4 ? "#111111" : "#ffffff";
}

/** Deterministic 5-colour palette derived from a seed (used when no brand palette is given). */
export function paletteFromSeed(seed: number): string[] {
  const rnd = prng(seed);
  const base = Math.floor(rnd() * 360);
  return [
    hslToHex(base, 0.55, 0.18),
    hslToHex((base + 30) % 360, 0.65, 0.45),
    hslToHex((base + 180) % 360, 0.7, 0.55),
    hslToHex((base + 210) % 360, 0.5, 0.75),
    hslToHex(base, 0.25, 0.94),
  ];
}

// ---- PNG tEXt chunk insertion (used to tag mock output in-file) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert tEXt chunks (latin1 keyword/value) right after the IHDR chunk of a PNG. */
export function addPngText(png: Uint8Array, entries: Record<string, string>): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => png[i] === b)) throw new Error("Not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdrLen = view.getUint32(8);
  const insertAt = 8 + 12 + ihdrLen;
  const chunks: Uint8Array[] = [];
  for (const [k, v] of Object.entries(entries)) {
    const data = Buffer.from(`${k}\0${v}`, "latin1");
    const typeAndData = new Uint8Array(4 + data.length);
    typeAndData.set(Buffer.from("tEXt", "latin1"), 0);
    typeAndData.set(data, 4);
    const chunk = new Uint8Array(12 + data.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk.set(typeAndData, 4);
    dv.setUint32(8 + data.length, crc32(typeAndData));
    chunks.push(chunk);
  }
  const extra = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, insertAt), 0);
  let off = insertAt;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  out.set(png.subarray(insertAt), off);
  return out;
}

/** Read tEXt chunks from a PNG. */
export function readPngText(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  while (off + 8 <= png.length) {
    const len = view.getUint32(off);
    const type = Buffer.from(png.subarray(off + 4, off + 8)).toString("latin1");
    if (type === "tEXt") {
      const data = Buffer.from(png.subarray(off + 8, off + 8 + len)).toString("latin1");
      const z = data.indexOf("\0");
      if (z > 0) out[data.slice(0, z)] = data.slice(z + 1);
    }
    if (type === "IEND") break;
    off += 12 + len;
  }
  return out;
}

export function toDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function extForMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return map[mime] ?? "bin";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
