import sharp from "sharp";
import { oklabToOklch, oklabToRgb, rgbToHex, rgbToOklab, type Oklab } from "../color.js";
import type { BrandInput } from "../types.js";

export interface ColorCluster {
  hex: string;
  /** Fraction of opaque pixels in this cluster (0..1). */
  share: number;
  l: number;
  c: number;
  h: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (x: Oklab, y: Oklab) => (x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2;

/** Deterministic k-means (k-means++ seeding, fixed seed) in OKLab space. */
export function kmeans(points: Oklab[], k: number, iterations = 16, seed = 42): Array<{ center: Oklab; size: number }> {
  if (points.length === 0) return [];
  const kk = Math.min(k, points.length);
  const rand = mulberry32(seed);
  const centers: Oklab[] = [points[Math.floor(rand() * points.length)]!];
  while (centers.length < kk) {
    const d = points.map((p) => Math.min(...centers.map((c) => dist2(p, c))));
    const total = d.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rand() * total;
    let idx = 0;
    for (; idx < d.length - 1; idx++) {
      r -= d[idx]!;
      if (r <= 0) break;
    }
    centers.push(points[idx]!);
  }
  const assign = new Array<number>(points.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    points.forEach((p, i) => {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => {
        const dd = dist2(p, c);
        if (dd < bd) { bd = dd; best = j; }
      });
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    });
    const sums = centers.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    points.forEach((p, i) => {
      const s = sums[assign[i]!]!;
      s.L += p.L; s.a += p.a; s.b += p.b; s.n++;
    });
    sums.forEach((s, j) => {
      if (s.n) centers[j] = { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n };
    });
    if (!moved && it > 0) break;
  }
  const sizes = centers.map((_, j) => assign.filter((a) => a === j).length);
  return centers.map((center, j) => ({ center, size: sizes[j]! })).filter((c) => c.size > 0);
}

/** Dominant colours of a logo/image (transparent pixels ignored), sorted by share. */
export async function extractDominantColors(input: Buffer | Uint8Array | string, k = 5): Promise<ColorCluster[]> {
  const { data, info } = await sharp(input).resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pts: Oklab[] = [];
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3]! < 128) continue;
    pts.push(rgbToOklab({ r: data[i]! / 255, g: data[i + 1]! / 255, b: data[i + 2]! / 255 }));
  }
  const clusters = kmeans(pts, k);
  const total = clusters.reduce((a, c) => a + c.size, 0) || 1;
  return clusters
    .map(({ center, size }) => {
      const hex = rgbToHex(oklabToRgb(center));
      const lch = oklabToOklch(center);
      return { hex, share: size / total, l: lch.l, c: lch.c, h: lch.h };
    })
    .sort((a, b) => b.share - a.share);
}

/** Choose brand primary/secondary from logo clusters: most chromatic significant colours with distinct hues. */
export function brandFromClusters(clusters: ColorCluster[]): BrandInput {
  const notes: string[] = [`logo clusters: ${clusters.map((c) => `${c.hex} ${(c.share * 100).toFixed(0)}%`).join(", ")}`];
  const chromatic = clusters.filter((c) => c.c > 0.04 && c.share >= 0.03).sort((a, b) => b.c * Math.sqrt(b.share) - a.c * Math.sqrt(a.share));
  const primary = chromatic[0] ?? clusters.filter((c) => c.l > 0.08 && c.l < 0.95)[0] ?? clusters[0];
  const hueDiff = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  const secondary = primary ? chromatic.find((c) => c !== primary && hueDiff(c.h, primary.h) > 30) : undefined;
  if (!chromatic.length) notes.push("logo is achromatic; accent derived from art direction hue");
  return {
    colors: {
      ...(primary && primary.c > 0.04 ? { primary: primary.hex } : {}),
      ...(secondary ? { secondary: secondary.hex } : {}),
    },
    fonts: {},
    source: "logo",
    notes,
  };
}

export async function brandFromLogo(input: Buffer | Uint8Array | string, k = 5): Promise<BrandInput> {
  return brandFromClusters(await extractDominantColors(input, k));
}

