"use client";

import { useLocale, useT } from "@/i18n/client";
import { formatUsd } from "@/i18n/format";
import type { Phase, StepState, TaskCost } from "@/lib/agent-run";
import { Icon } from "@/components/Icon";
import { phaseName } from "./EventCard";

/** plan → design → build → verify → review → finish. */
export function PhaseStepper({ steps }: { steps: Array<{ phase: Phase; state: StepState }> }) {
  const t = useT();
  return (
    <ol className="stepper" aria-label={t("project.stepper.label")} data-testid="phase-stepper">
      {steps.map((s) => (
        <li key={s.phase} data-state={s.state} aria-current={s.state === "active" ? "step" : undefined}>
          <span className="stepper-bar" aria-hidden="true" />
          <span className="stepper-label">
            {s.state === "done" && <Icon name="check" size={10} strokeWidth={3} />}
            {s.state === "failed" && <Icon name="x" size={10} strokeWidth={3} />}
            {phaseName(t, s.phase)}
          </span>
          <span className="sr-only">— {t(`project.stepper.${s.state}`)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Estimate vs. spent, as a pill with a tiny meter. Mock runs read "$0.00 · mock". */
export function CostMeter({ cost }: { cost: TaskCost }) {
  const t = useT();
  const locale = useLocale();
  const spent = formatUsd(cost.spentUsd, locale);
  const high = cost.highUsd ?? 0;
  const pct = high > 0 ? Math.min(100, Math.round((cost.spentUsd / high) * 100)) : 0;
  const range = cost.lowUsd !== null && cost.highUsd !== null ? `${formatUsd(cost.lowUsd, locale)}–${formatUsd(cost.highUsd, locale)}` : null;
  const title = cost.mock ? t("project.cost.mockHint") : range ? t("project.cost.meter", { spent, high: formatUsd(high, locale) }) : t("project.cost.spent", { amount: spent });
  return (
    <span className="cost-pill" title={title} data-testid="cost-pill">
      <span className="cost-text">
        <strong>{spent}</strong>
        {cost.mock ? <span className="cost-mock">· {t("project.cost.mock")}</span> : range ? <span className="cost-est">· {t("project.cost.ofEstimate", { high: formatUsd(high, locale) })}</span> : null}
      </span>
      {range && !cost.mock && (
        <span className="cost-meter" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="sr-only">{title}</span>
    </span>
  );
}
