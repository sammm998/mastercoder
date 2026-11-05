import sharp from "sharp";
import type { Chart, DeckTheme } from "./schema.js";
import { DEFAULT_THEME, cssFontStack, escapeHtml, seriesColors } from "./theme.js";

export interface ChartRenderOptions {
  width?: number;
  height?: number;
  theme?: DeckTheme;
  /** Fill the background (PNG export) or leave transparent (inline in HTML). */
  background?: boolean;
  /** Font size scale; 1 = 14px base at 800px width. */
  fontScale?: number;
}

function niceStep(range: number, target = 5): number {
  if (range <= 0) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function formatNumber(n: number, unit = ""): string {
  const abs = Math.abs(n);
  const s = abs >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : abs >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`;
  return `${s}${unit}`;
}

function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  if (inner <= 0) return `M${cx} ${cy} L${p(r, a0)} A${r} ${r} 0 ${large} 1 ${p(r, a1)} Z`;
  return `M${p(r, a0)} A${r} ${r} 0 ${large} 1 ${p(r, a1)} L${p(inner, a1)} A${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
}

/** Render a chart to a standalone, accessible SVG string (bar, line, pie, doughnut). */
export function renderChartSvg(chart: Chart, opts: ChartRenderOptions = {}): string {
  const W = opts.width ?? 800;
  const H = opts.height ?? 450;
  const theme = opts.theme ?? DEFAULT_THEME;
  const colors = seriesColors(theme);
  const fs = Math.round(14 * (W / 800) * (opts.fontScale ?? 1));
  const font = cssFontStack(theme.fonts.body).replace(/'/g, "&apos;");
  const text = theme.colors.text;
  const muted = theme.colors.muted;
  const grid = theme.colors.border ?? theme.colors.muted;
  const parts: string[] = [];
  const titleText = chart.title ?? `${chart.type} chart`;
  const desc = chart.series.map((s) => `${s.name}: ${s.values.map((v, i) => `${chart.labels[i]} ${formatNumber(v, chart.unit)}`).join(", ")}`).join("; ");
  if (opts.background) parts.push(`<rect width="${W}" height="${H}" fill="${theme.colors.surface}"/>`);

  const legend = (items: Array<{ name: string; color: string }>, y: number) => {
    let x = fs;
    for (const it of items) {
      parts.push(`<rect x="${x}" y="${y - fs * 0.75}" width="${fs * 0.8}" height="${fs * 0.8}" rx="${fs * 0.15}" fill="${it.color}"/>`);
      parts.push(`<text x="${x + fs * 1.1}" y="${y}" font-size="${fs}" fill="${muted}">${escapeHtml(it.name)}</text>`);
      x += fs * 2 + it.name.length * fs * 0.6;
    }
  };

  if (chart.type === "pie" || chart.type === "doughnut") {
    const s = chart.series[0]!;
    const total = s.values.reduce((a, v) => a + Math.max(0, v), 0) || 1;
    const cx = W * 0.32;
    const cy = H / 2;
    const r = Math.min(W * 0.28, H * 0.42);
    const inner = chart.type === "doughnut" ? r * 0.58 : 0;
    let a = -Math.PI / 2;
    s.values.forEach((v, i) => {
      const da = (Math.max(0, v) / total) * Math.PI * 2;
      if (da > 0) parts.push(`<path d="${arcPath(cx, cy, r, inner, a, a + da)}" fill="${colors[i % colors.length]}" stroke="${theme.colors.surface}" stroke-width="2"/>`);
      a += da;
    });
    if (inner > 0) parts.push(`<text x="${cx}" y="${cy + fs * 0.4}" text-anchor="middle" font-size="${fs * 1.6}" font-weight="700" fill="${text}">${formatNumber(total, chart.unit)}</text>`);
    chart.labels.forEach((label, i) => {
      const y = H * 0.2 + i * fs * 1.9;
      const pct = ((Math.max(0, s.values[i] ?? 0) / total) * 100).toFixed(0);
      parts.push(`<rect x="${W * 0.64}" y="${y - fs * 0.8}" width="${fs}" height="${fs}" rx="${fs * 0.2}" fill="${colors[i % colors.length]}"/>`);
      parts.push(`<text x="${W * 0.64 + fs * 1.5}" y="${y}" font-size="${fs}" fill="${text}">${escapeHtml(label)} <tspan fill="${muted}">${pct}%</tspan></text>`);
    });
  } else {
    const all = chart.series.flatMap((s) => s.values);
    const minV = Math.min(0, ...all);
    const maxV = Math.max(0, ...all);
    const step = niceStep(maxV - minV);
    const lo = Math.floor(minV / step) * step;
    const hi = Math.ceil(maxV / step) * step || step;
    const left = fs * 4.2;
    const right = W - fs * 1.2;
    const top = fs * 1.5;
    const bottom = H - fs * (chart.series.length > 1 ? 4.2 : 2.6);
    const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    for (let v = lo; v <= hi + step / 2; v += step) {
      parts.push(`<line x1="${left}" x2="${right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${grid}" stroke-width="1" ${v === 0 ? "" : 'stroke-dasharray="3 4"'}/>`);
      parts.push(`<text x="${left - fs * 0.5}" y="${(y(v) + fs * 0.35).toFixed(1)}" text-anchor="end" font-size="${fs * 0.9}" fill="${muted}">${formatNumber(v, chart.unit)}</text>`);
    }
    const n = chart.labels.length;
    const band = (right - left) / n;
    chart.labels.forEach((label, i) => {
      parts.push(`<text x="${(left + band * (i + 0.5)).toFixed(1)}" y="${bottom + fs * 1.4}" text-anchor="middle" font-size="${fs * 0.9}" fill="${muted}">${escapeHtml(label)}</text>`);
    });
    if (chart.type === "bar") {
      const k = chart.series.length;
      const bw = (band * 0.72) / k;
      chart.series.forEach((s, si) => {
        s.values.forEach((v, i) => {
          const x = left + band * i + band * 0.14 + bw * si;
          const y0 = y(Math.max(0, v));
          const h = Math.abs(y(v) - y(0));
          parts.push(`<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" rx="${Math.min(6, bw / 6).toFixed(1)}" fill="${colors[si % colors.length]}"/>`);
          if (n * k <= 16) parts.push(`<text x="${(x + bw * 0.46).toFixed(1)}" y="${(y0 - fs * 0.4).toFixed(1)}" text-anchor="middle" font-size="${fs * 0.8}" fill="${text}">${formatNumber(v, chart.unit)}</text>`);
        });
      });
    } else {
      chart.series.forEach((s, si) => {
        const pts = s.values.map((v, i) => `${(left + band * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`);
        parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="${Math.max(2, fs / 5)}" stroke-linejoin="round" stroke-linecap="round"/>`);
        pts.forEach((p) => {
          const [cx, cy] = p.split(",");
          parts.push(`<circle cx="${cx}" cy="${cy}" r="${fs / 3}" fill="${colors[si % colors.length]}"/>`);
        });
      });
    }
    if (chart.series.length > 1) legend(chart.series.map((s, i) => ({ name: s.name, color: colors[i % colors.length] as string })), H - fs * 0.9);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="ct dc" font-family="${font}">
<title id="ct">${escapeHtml(titleText)}</title><desc id="dc">${escapeHtml(desc)}</desc>
${parts.join("\n")}
</svg>`;
}

/** Rasterise a chart to PNG via sharp (librsvg). */
export async function chartToPng(chart: Chart, opts: ChartRenderOptions = {}): Promise<Uint8Array> {
  const svg = renderChartSvg(chart, { background: true, ...opts });
  return new Uint8Array(await sharp(Buffer.from(svg), { density: 144 }).resize(opts.width ?? 800).png().toBuffer());
}
