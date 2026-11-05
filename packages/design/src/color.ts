/**
 * Colour science: sRGB <-> OKLab/OKLCH (Björn Ottosson, https://bottosson.github.io/posts/oklab/),
 * gamut mapping by chroma reduction, WCAG 2.x relative luminance + contrast ratio, and lightness
 * auto-adjustment to reach a target contrast.
 */

export interface Rgb { r: number; g: number; b: number } // 0..1 gamma-encoded sRGB
export interface Oklab { L: number; a: number; b: number }
export interface Oklch { l: number; c: number; h: number } // l 0..1, c ~0..0.4, h degrees

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex colour "${hex}"`);
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklab({ r, g, b }: Rgb): Oklab {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Unclamped linear sRGB from OKLab (may be out of gamut). */
function oklabToLinear({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabToRgb(lab: Oklab): Rgb {
  const [r, g, b] = oklabToLinear(lab);
  return { r: toGamma(clamp01(r)), g: toGamma(clamp01(g)), b: toGamma(clamp01(b)) };
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h: c < 1e-4 ? 0 : h };
}

export function oklchToOklab({ l, c, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  return { L: l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
}

export function inGamut(lch: Oklch, eps = 1e-6): boolean {
  return oklabToLinear(oklchToOklab(lch)).every((v) => v >= -eps && v <= 1 + eps);
}

/** Map into sRGB gamut by reducing chroma (binary search) at constant lightness and hue. */
export function gamutMap(lch: Oklch): Oklch {
  const l = clamp01(lch.l);
  if (inGamut({ ...lch, l })) return { ...lch, l };
  let lo = 0, hi = lch.c;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut({ l, c: mid, h: lch.h })) lo = mid; else hi = mid;
  }
  return { l, c: lo, h: lch.h };
}

export function oklchToHex(lch: Oklch): string {
  return rgbToHex(oklabToRgb(oklchToOklab(gamutMap(lch))));
}

export function hexToOklch(hex: string): Oklch {
  return oklabToOklch(rgbToOklab(hexToRgb(hex)));
}

export function oklchCss({ l, c, h }: Oklch): string {
  return `oklch(${(l * 100).toFixed(2)}% ${c.toFixed(4)} ${h.toFixed(2)})`;
}

/** Parse #hex, rgb()/rgba(), or oklch() into hex (alpha ignored). */
export function parseColor(input: string): string {
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) return rgbToHex(hexToRgb(s));
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) return rgbToHex({ r: Number(rgb[1]) / 255, g: Number(rgb[2]) / 255, b: Number(rgb[3]) / 255 });
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (ok) {
    const l = Number(ok[1]) / (ok[2] ? 100 : 1);
    return oklchToHex({ l, c: Number(ok[3]), h: Number(ok[4]) });
  }
  throw new Error(`Unsupported colour "${input}"`);
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const WCAG = { AA_TEXT: 4.5, AA_LARGE: 3, AAA_TEXT: 7, UI: 3 } as const;

/**
 * Adjust only OKLCH lightness of `fg` until it reaches `min` contrast against `bg`.
 * Moves away from the background's luminance; if that direction cannot reach the target it tries the
 * other direction; as a last resort returns black or white (whichever contrasts most).
 */
export function ensureContrast(fg: string, bg: string, min: number): { hex: string; ratio: number; adjusted: boolean } {
  const start = contrastRatio(fg, bg);
  if (start >= min) return { hex: fg, ratio: start, adjusted: false };
  const lch = hexToOklch(fg);
  const bgL = hexToOklch(bg).l;
  const dirs: Array<1 | -1> = bgL > 0.6 ? [-1, 1] : [1, -1];
  for (const dir of dirs) {
    // Binary search for the lightness closest to the original that reaches the target.
    const edge = dir === 1 ? 1 : 0;
    const edgeHex = oklchToHex({ ...lch, l: edge });
    if (contrastRatio(edgeHex, bg) < min) continue;
    let near = lch.l, far = edge;
    for (let i = 0; i < 28; i++) {
      const mid = (near + far) / 2;
      if (contrastRatio(oklchToHex({ ...lch, l: mid }), bg) >= min) far = mid; else near = mid;
    }
    const hex = oklchToHex({ ...lch, l: far });
    return { hex, ratio: contrastRatio(hex, bg), adjusted: true };
  }
  const bw = contrastRatio("#000000", bg) > contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
  return { hex: bw, ratio: contrastRatio(bw, bg), adjusted: true };
}

/** Readable text colour (near-black or near-white, tinted with `hue`) for a given background. */
export function readableOn(bg: string, hue = 0, min: number = WCAG.AA_TEXT): string {
  const dark = oklchToHex({ l: 0.16, c: 0.02, h: hue });
  const light = oklchToHex({ l: 0.985, c: 0.01, h: hue });
  const best = contrastRatio(dark, bg) >= contrastRatio(light, bg) ? dark : light;
  return ensureContrast(best, bg, min).hex;
}

/** Perceptual distance in OKLab (deltaE-OK). */
export function deltaE(a: string, b: string): number {
  const x = rgbToOklab(hexToRgb(a)), y = rgbToOklab(hexToRgb(b));
  return Math.sqrt((x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2);
}
