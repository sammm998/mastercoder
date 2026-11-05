"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { assignSlots, bandLayout, formatUsd, formatUsdPrecise, labelIndices, linearTicks, shortDay, stackColumn, yScale } from "@/lib/chart";
import { OTHER } from "@/lib/costs";
import { S } from "@/lib/strings";

export interface StackedBarChartProps {
  title: string;
  description: string;
  days: string[];
  keys: string[];
  series: Record<string, number[]>;
  totals: number[];
  /** Index of a column to mark as a spike (gets a critical marker above it). */
  spikeIndex?: number | null;
  height?: number;
}

const MARGIN = { top: 14, right: 8, bottom: 24, left: 52 };

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function seriesColor(slot: number): string {
  return slot > 0 ? `var(--series-${slot})` : "var(--muted)";
}

/**
 * Accessible stacked column chart in plain SVG: role="img" with title + description, keyboard-navigable
 * columns (arrow keys) with a tooltip and a live region, a legend, and an optional data-table view.
 */
export function StackedBarChart({ title, description, days, keys, series, totals, spikeIndex, height = 240 }: StackedBarChartProps) {
  const id = useId();
  const [wrapRef, width] = useWidth<HTMLDivElement>(720);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const slots = assignSlots(keys, OTHER);
  const innerW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const { ticks, max } = linearTicks(Math.max(0, ...totals), 4);
  const y = yScale(max, innerH);
  const gap = days.length > 45 ? 1 : 2;
  const band = bandLayout(days.length, innerW, gap);
  const labels = labelIndices(days.length, Math.max(2, Math.floor(innerW / 64)));
  // Keys arrive ordered by total spend, so the largest series sits on the baseline.
  const order = keys;

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!days.length) return;
    const cur = active ?? days.length - 1;
    let next: number | null = cur;
    if (e.key === "ArrowRight") next = Math.min(days.length - 1, cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = days.length - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setActive(next);
  };

  const activeSummary =
    active !== null && days[active]
      ? `${shortDay(days[active])}: ${formatUsdPrecise(totals[active] ?? 0)} total. ` +
        order
          .map((k) => ({ k, v: series[k]?.[active] ?? 0 }))
          .filter((r) => r.v > 0)
          .map((r) => `${r.k} ${formatUsdPrecise(r.v)}`)
          .join(", ")
      : "";

  const tooltipLeft = active !== null ? MARGIN.left + band.x(active) + band.bandwidth / 2 : 0;
  const flip = tooltipLeft > width * 0.6;

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <div ref={wrapRef} style={{ position: "relative" }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onMouseLeave={() => setActive(null)}
        >
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{`${description} Use left and right arrow keys to read each day.`}</desc>
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`} aria-hidden="true">
                <line className={t === 0 ? "baseline" : "gridline"} x1={0} x2={innerW} />
                <text className="tick" x={-8} dy="0.32em" textAnchor="end">
                  {formatUsd(t)}
                </text>
              </g>
            ))}
            {days.map((day, i) => {
              const segs = stackColumn(order, (k) => series[k]?.[i] ?? 0);
              const x = band.x(i);
              return (
                <g key={day} aria-hidden="true">
                  {segs.map((s, si) => {
                    const top = y(s.y1);
                    const h = Math.max(0, y(s.y0) - top);
                    const isTop = si === segs.length - 1;
                    const r = isTop ? Math.min(3, band.bandwidth / 3, h) : 0;
                    return (
                      <path
                        key={s.key}
                        className="seg"
                        fill={seriesColor(slots[s.key] ?? 0)}
                        d={roundedTopRect(x, top, band.bandwidth, h, r)}
                        opacity={active !== null && active !== i ? 0.45 : 1}
                      />
                    );
                  })}
                  {spikeIndex === i && (totals[i] ?? 0) > 0 ? (
                    <path className="spike-mark" d={`M${x + band.bandwidth / 2 - 5},${y(totals[i] ?? 0) - 10} h10 l-5,7 z`} />
                  ) : null}
                  <rect
                    className="hit"
                    x={x - gap / 2}
                    y={0}
                    width={band.bandwidth + gap}
                    height={innerH}
                    onMouseEnter={() => setActive(i)}
                    style={active === i ? { fill: "var(--ink)", fillOpacity: 0.05 } : undefined}
                  />
                </g>
              );
            })}
            {labels.map((i) => (
              <text key={i} className="tick" aria-hidden="true" x={band.x(i) + band.bandwidth / 2} y={innerH + 16} textAnchor="middle">
                {shortDay(days[i] ?? "")}
              </text>
            ))}
          </g>
        </svg>
        {active !== null && days[active] ? (
          <div
            className="tooltip"
            aria-hidden="true"
            style={{ top: MARGIN.top, left: flip ? undefined : tooltipLeft + 12, right: flip ? width - tooltipLeft + 12 : undefined }}
          >
            <strong>{shortDay(days[active])}</strong>
            <table>
              <tbody>
                {[...order]
                  .reverse()
                  .filter((k) => (series[k]?.[active] ?? 0) > 0)
                  .map((k) => (
                    <tr key={k}>
                      <td>
                        <span className="swatch" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 6, background: seriesColor(slots[k] ?? 0) }} />
                        {k}
                      </td>
                      <td className="num">{formatUsdPrecise(series[k]?.[active] ?? 0)}</td>
                    </tr>
                  ))}
                <tr>
                  <td>
                    <strong>{S.costs.total}</strong>
                  </td>
                  <td className="num">
                    <strong>{formatUsdPrecise(totals[active] ?? 0)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {activeSummary}
        </p>
      </div>
      <figcaption>
        {keys.length > 1 ? (
          <ul className="legend" aria-label={S.costs.legend}>
            {keys.map((k) => (
              <li key={k}>
                <span className="swatch" aria-hidden="true" style={{ background: seriesColor(slots[k] ?? 0) }} />
                {k}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" style={{ marginTop: 8 }} aria-expanded={showTable} aria-controls={`${id}-table`} onClick={() => setShowTable((v) => !v)}>
          {showTable ? S.costs.hideTable : S.costs.showTable}
        </button>
      </figcaption>
      {showTable ? (
        <div className="table-wrap" id={`${id}-table`} style={{ marginTop: 8, maxHeight: 360 }}>
          <table>
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">{S.costs.day}</th>
                {keys.map((k) => (
                  <th key={k} scope="col" className="num">
                    {k}
                  </th>
                ))}
                <th scope="col" className="num">
                  {S.costs.total}
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d}>
                  <th scope="row" className="rowhead">
                    {d}
                  </th>
                  {keys.map((k) => (
                    <td key={k} className="num">
                      {formatUsdPrecise(series[k]?.[i] ?? 0)}
                    </td>
                  ))}
                  <td className="num">{formatUsdPrecise(totals[i] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}

/** Rect path with only the top corners rounded (data end), anchored flat on the baseline. */
function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return "";
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
