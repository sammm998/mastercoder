/**
 * Generative, token-driven vector art used as decorative visuals in composed sites (no stock imagery).
 * `ART_COMPONENT` is the source of src/components/Art.tsx (CSS variables, so it follows the theme);
 * `projectSvg` renders a standalone SVG file (literal colours, so it can be used as an <img>/WebGL texture).
 */
import { hashString } from "../curated.js";
import type { Palette } from "../types.js";

export const ART_COMPONENT = `/**
 * Decorative generative compositions drawn from design tokens (aria-hidden SVG, scales to its box).
 */
import type { CSSProperties } from "react";

const A = { fill: "var(--color-accent)" } satisfies CSSProperties;
const B = { fill: "var(--color-accent-2)" } satisfies CSSProperties;
const T = { fill: "var(--color-text)" } satisfies CSSProperties;
const S = { fill: "var(--color-surface)" } satisfies CSSProperties;
const L = { fill: "none", stroke: "var(--color-text)", strokeWidth: 1.5 } satisfies CSSProperties;
const LA = { fill: "none", stroke: "var(--color-accent)", strokeWidth: 2 } satisfies CSSProperties;

function Orbit() {
  return (
    <>
      <circle cx="260" cy="150" r="120" style={A} />
      <circle cx="150" cy="170" r="70" style={B} />
      <circle cx="200" cy="150" r="138" style={L} />
      <circle cx="200" cy="150" r="96" style={L} opacity="0.5" />
      <circle cx="318" cy="64" r="10" style={T} />
    </>
  );
}

function Arcs() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={\`M \${40 + i * 24} 300 A \${160 - i * 24} \${160 - i * 24} 0 0 1 \${360 - i * 24} 300\`} style={i % 2 ? LA : L} />
      ))}
      <rect x="0" y="230" width="400" height="70" style={A} />
      <circle cx="200" cy="150" r="22" style={B} />
    </>
  );
}

function Dots() {
  const dots = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++) {
      const r = 3 + ((x * 7 + y * 3) % 5) * 1.6;
      dots.push(<circle key={\`\${x}-\${y}\`} cx={24 + x * 32} cy={28 + y * 35} r={r} style={(x + y) % 5 === 0 ? A : (x * y) % 7 === 1 ? B : T} opacity={(x + y) % 5 === 0 ? 1 : 0.35} />);
    }
  return <>{dots}</>;
}

function Bands() {
  return (
    <>
      <rect x="-60" y="40" width="520" height="56" transform="rotate(-14 200 150)" style={A} />
      <rect x="-60" y="130" width="520" height="22" transform="rotate(-14 200 150)" style={T} />
      <rect x="-60" y="190" width="520" height="84" transform="rotate(-14 200 150)" style={B} />
    </>
  );
}

function Frames() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={40 + i * 22} y={20 + i * 16} width={320 - i * 44} height={260 - i * 32} rx={i * 2} style={i === 5 ? A : L} opacity={i === 5 ? 1 : 1 - i * 0.12} />
      ))}
      <rect x="250" y="40" width="90" height="90" style={B} />
    </>
  );
}

function Wave() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <path key={i} d={\`M0 \${120 + i * 18} C 100 \${40 + i * 30}, 200 \${220 - i * 10}, 400 \${100 + i * 20}\`} style={i === 3 ? LA : L} opacity={i === 3 ? 1 : 0.4 + i * 0.05} />
      ))}
      <circle cx="300" cy="90" r="46" style={A} />
    </>
  );
}

const VARIANTS = [Orbit, Arcs, Dots, Bands, Frames, Wave];

/** tone="inverse" redraws the composition in --color-on-accent for use on accent surfaces. */
export function Art({ variant = 0, className = "", tone = "default" }: { variant?: number; className?: string; tone?: "default" | "inverse" }) {
  const V = VARIANTS[Math.abs(variant) % VARIANTS.length]!;
  return (
    <svg className={\`art art--\${tone} \${className}\`} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {tone === "default" ? <rect width="400" height="300" style={S} /> : null}
      <V />
    </svg>
  );
}

export default Art;
`;

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** A 1600x1200 architectural-abstract SVG (plan/elevation motifs) in the palette's literal colours. */
export function projectSvg(p: Palette, title: string, index: number): string {
  const h = hashString(title + index);
  const r = (n: number) => ((h >>> (n % 24)) % 1000) / 1000;
  const W = 1600, H = 1200;
  const shapes: string[] = [];
  const kind = index % 4;
  if (kind === 0) {
    // Elevation: stacked volumes and a low sun.
    shapes.push(`<circle cx="${1100 + r(1) * 300}" cy="${300 + r(2) * 150}" r="${150 + r(3) * 80}" fill="${p.accent}"/>`);
    for (let i = 0; i < 5; i++) {
      const w = 260 + r(i + 4) * 260, x = 120 + i * 260, y = 520 + r(i + 9) * 260;
      shapes.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${H - y}" fill="${i % 2 ? p.surface : p.text}" opacity="${i % 2 ? 1 : 0.88}"/>`);
    }
  } else if (kind === 1) {
    // Plan: rooms and a courtyard.
    shapes.push(`<rect x="200" y="160" width="1200" height="880" fill="none" stroke="${p.text}" stroke-width="10"/>`);
    shapes.push(`<rect x="${560 + r(1) * 120}" y="${380 + r(2) * 80}" width="420" height="360" fill="${p.accent}"/>`);
    for (let i = 0; i < 6; i++) shapes.push(`<line x1="${200 + i * 200}" y1="160" x2="${200 + i * 200}" y2="${400 + r(i) * 300}" stroke="${p.text}" stroke-width="6"/>`);
    shapes.push(`<circle cx="${1240 - r(5) * 200}" cy="${900 - r(6) * 120}" r="70" fill="${p.accent2}"/>`);
  } else if (kind === 2) {
    // Section: terraces stepping down a slope.
    for (let i = 0; i < 7; i++) shapes.push(`<rect x="${i * 220}" y="${300 + i * 110}" width="${W}" height="120" fill="${i % 2 ? p.accent : p.text}" opacity="${i % 2 ? 0.95 : 0.12 + i * 0.1}"/>`);
    shapes.push(`<path d="M0 ${H} L${W} ${H * 0.35} L${W} ${H} Z" fill="${p.surface}" opacity="0.6"/>`);
  } else {
    // Facade rhythm: columns and openings.
    for (let i = 0; i < 12; i++) {
      const x = 120 + i * 115;
      shapes.push(`<rect x="${x}" y="${240 + (i % 3) * 30}" width="70" height="${700 - (i % 3) * 30}" fill="${i === 4 || i === 9 ? p.accent : p.text}" opacity="${i === 4 || i === 9 ? 1 : 0.8}"/>`);
    }
    shapes.push(`<rect x="0" y="940" width="${W}" height="260" fill="${p.accent2}" opacity="0.9"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${W}" height="${H}" fill="${p.surface}"/>
<rect width="${W}" height="${H}" fill="${p.bg}" opacity="0.35"/>
${shapes.join("\n")}
</svg>
`;
}

/** Favicon: brand initial on the accent colour. */
export function faviconSvg(p: Palette, brand: string): string {
  const letter = esc((brand.trim()[0] ?? "F").toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${p.accent}"/><text x="32" y="44" font-family="system-ui, sans-serif" font-size="36" font-weight="700" text-anchor="middle" fill="${p.onAccent}">${letter}</text></svg>\n`;
}
