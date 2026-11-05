"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { S } from "@/lib/strings";
import { errorCode, errorMessage } from "@/lib/trpc";

export type Tone = "good" | "warning" | "critical" | "neutral";

/** Status pill: a colored dot plus a text label, so state is never conveyed by color alone. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children ? <div className="toolbar">{children}</div> : null}
    </div>
  );
}

/** Loading / error states for a query. Forbidden errors are surfaced as the admins-only notice. */
export function QueryState({ isLoading, error, onRetry }: { isLoading: boolean; error: unknown; onRetry?: () => void }) {
  if (isLoading)
    return (
      <p className="muted" role="status">
        {S.common.loading}
      </p>
    );
  if (error) {
    const forbidden = errorCode(error) === "FORBIDDEN";
    return (
      <div className="alert critical" role="alert">
        <strong>{forbidden ? S.auth.adminsOnlyTitle : S.common.error}</strong>
        <p>{errorMessage(error)}</p>
        {onRetry && !forbidden ? (
          <button type="button" onClick={onRetry}>
            {S.common.retry}
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const relFmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "–";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "–" : `${dateFmt.format(date)} UTC`;
}

export function relativeTime(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "–";
  const t = (typeof d === "string" ? new Date(d) : d).getTime();
  const sec = Math.round((t - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return relFmt.format(sec, "second");
  if (abs < 3600) return relFmt.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return relFmt.format(Math.round(sec / 3600), "hour");
  return relFmt.format(Math.round(sec / 86400), "day");
}

export function Time({ value }: { value: Date | string | null | undefined }) {
  if (!value) return <span className="muted">–</span>;
  const iso = (typeof value === "string" ? new Date(value) : value).toISOString();
  return (
    <time dateTime={iso} title={formatDate(value)}>
      {relativeTime(value)}
    </time>
  );
}

/** Modal confirmation built on <dialog> (focus trap + Esc handled by the browser). */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { open, onCancel } = props;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onClose = () => {
      if (open) onCancel();
    };
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, [open, onCancel]);
  return (
    <dialog ref={ref} aria-labelledby="confirm-title" aria-describedby="confirm-body">
      <h2 id="confirm-title">{props.title}</h2>
      <p id="confirm-body">{props.body}</p>
      <div className="dialog-actions">
        <button type="button" onClick={props.onCancel} autoFocus>
          {S.common.cancel}
        </button>
        <button type="button" className={props.danger ? "danger" : "primary"} onClick={props.onConfirm} disabled={props.busy}>
          {props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
