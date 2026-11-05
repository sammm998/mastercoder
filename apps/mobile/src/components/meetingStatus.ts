import type { TFunction, TKey } from "../lib/i18n";
import { MEETING_STATUSES } from "../lib/meeting";

export type StatusTone = "neutral" | "accent" | "success" | "danger" | "warning";

export const STATUS_TONE: Record<string, StatusTone> = { ready: "success", failed: "danger", processing: "accent", recording: "warning", scheduled: "neutral", joining: "neutral" };

export function statusLabel(t: TFunction, status: string): string {
  return (MEETING_STATUSES as readonly string[]).includes(status) ? t(`meetings.status.${status}` as TKey) : status;
}
