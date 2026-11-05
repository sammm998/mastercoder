/**
 * Deterministic design-critic response: raise text/muted/button contrast in tokens.css to WCAG
 * targets by mixing towards black or white. Only hex colours in custom properties are touched.
 */

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (rgb: [number, number, number]) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return 21;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix `fg` towards black or white (whichever contrasts more with `bg`) until `min` is reached. */
export function ensureContrast(fg: string, bg: string, min: number): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b || contrast(fg, bg) >= min) return fg;
  const target: [number, number, number] = luminance(b) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const mixed = toHex([0, 1, 2].map((i) => f[i]! + (target[i]! - f[i]!) * t) as [number, number, number]);
    if (contrast(mixed, bg) >= min) return mixed;
  }
  return toHex(target);
}

const PAIRS: Array<{ fg: string; bg: string; min: number }> = [
  { fg: "--color-text", bg: "--color-bg", min: 7 },
  { fg: "--color-muted", bg: "--color-bg", min: 4.5 },
  { fg: "--color-accent", bg: "--color-bg", min: 3 },
  { fg: "--color-accent-contrast", bg: "--color-accent", min: 4.5 },
];

/** Returns the adjusted CSS and a description of each change (empty when nothing needed changing). */
export function improveContrast(css: string): { css: string; changes: string[] } {
  const changes: string[] = [];
  const out = css.replace(/\{([^{}]*)\}/g, (block, body: string) => {
    const vars = new Map<string, string>();
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) vars.set(m[1]!, m[2]!);
    let next = body;
    for (const p of PAIRS) {
      const fg = vars.get(p.fg);
      const bg = vars.get(p.bg);
      if (!fg || !bg) continue;
      const fixed = ensureContrast(fg, bg, p.min);
      if (fixed.toLowerCase() !== fg.toLowerCase()) {
        changes.push(`${p.fg} ${fg} → ${fixed} (contrast ${contrast(fg, bg).toFixed(2)} → ${contrast(fixed, bg).toFixed(2)} on ${p.bg})`);
        next = next.replace(new RegExp(`(${p.fg}\\s*:\\s*)${fg}\\b`), `$1${fixed}`);
        vars.set(p.fg, fixed);
      }
    }
    return block.replace(body, next);
  });
  return { css: out, changes };
}
