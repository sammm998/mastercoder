/** "rgb(255, 106, 43)" / "rgba(…)" / "#abc" → "#rrggbb" (null when transparent or unparseable). */
export function toHex(css: string | undefined | null): string | null {
  if (!css) return null;
  const s = css.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return null;
  if (m[4] !== undefined) {
    const a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (a === 0) return null;
  }
  return `#${[m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Accept CSS lengths the style editor writes: "16px", "1rem 2rem", "0", "auto". */
export function validLength(v: string): boolean {
  return /^(?:(?:-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch)?|auto)\s*){1,4}$/.test(v.trim());
}
