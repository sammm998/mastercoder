"use client";

import type { ReactNode } from "react";
import { useT } from "@/i18n/client";
import { errorInfo } from "@/lib/errors";
import { avatarSrc, type CrewId } from "@/lib/crew";

/** Explains an API error. "Not configured" services get a calm, specific message instead of a crash. */
export function ErrorNotice({ error, service, onRetry, compact = false }: { error: unknown; service?: string; onRetry?: () => void; compact?: boolean }) {
  const t = useT();
  if (!error) return null;
  const info = errorInfo(error);
  const serviceName = service ?? /^(\w[\w-]*) is not configured/i.exec(info.message)?.[1] ?? "";
  let title: string;
  let body: string | null = info.message;
  let tone = "notice-bad";
  switch (info.kind) {
    case "not_configured":
      title = t("errors.notConfigured");
      body = t("errors.notConfiguredBody", { service: serviceName || "—" });
      tone = "notice-warn";
      break;
    case "spend_cap":
      title = t("errors.spendCap");
      body = `${t("errors.spendCapBody")} (${info.message})`;
      tone = "notice-warn";
      break;
    case "blocked":
      title = t("errors.blocked");
      tone = "notice-warn";
      break;
    case "unauthorized":
      title = t("errors.unauthorized");
      break;
    case "forbidden":
      title = t("errors.forbidden");
      break;
    case "not_found":
      title = t("errors.notFound");
      break;
    case "rate_limited":
      title = t("errors.rateLimited");
      break;
    case "network":
      title = t("errors.network");
      body = null;
      break;
    case "bad_input":
      title = info.message;
      body = null;
      break;
    default:
      title = t("errors.unknown");
  }
  return (
    <div className={`notice ${tone}`} role="alert" data-error-kind={info.kind} style={compact ? { padding: "10px 14px" } : undefined}>
      <div className="grow">
        <strong>{title}</strong>
        {body && <span style={{ opacity: 0.9 }}>{body}</span>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

export function Skeleton({ height = 18, width = "100%", style }: { height?: number | string; width?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height, width, ...style }} aria-hidden="true" />;
}

export function LoadingBlock({ rows = 3, label }: { rows?: number; label?: string }) {
  const t = useT();
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className="sr-only">{label ?? t("common.loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 28 : 18} width={i === 0 ? "40%" : `${90 - i * 12}%`} />
      ))}
    </div>
  );
}

/** Empty states get a glowing orb with one of the crew mascots. */
export function EmptyState({ title, body, action, icon, crew = "scoutr" }: { title: string; body?: string; action?: ReactNode; icon?: ReactNode; crew?: CrewId }) {
  return (
    <div className="empty">
      {icon ?? (
        <span className="orb empty-orb" aria-hidden="true">
          <img src={avatarSrc(crew)} alt="" width={72} height={72} className="orb-mascot" loading="lazy" />
        </span>
      )}
      <h3>{title}</h3>
      {body && <p className="muted">{body}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="row" style={{ gap: 8 }}>
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}
