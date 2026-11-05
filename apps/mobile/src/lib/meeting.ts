/**
 * Lenient view model for a processed meeting (meetings.get): the extraction/spec JSON is produced by
 * @forge/meetings, so we accept the common shapes and keep the raw JSON for anything else.
 */

export interface MeetingView {
  summary: string | null;
  requirements: Array<{ text: string; priority?: string }>;
  decisions: string[];
  actionItems: Array<{ text: string; owner?: string }>;
  spec: { title: string | null; buildPrompt: string | null; features: string[]; raw: Record<string, unknown> | null };
  canApprove: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function textOf(v: unknown): string | null {
  if (typeof v === "string") return str(v);
  if (isObj(v)) return str(v.text) ?? str(v.title) ?? str(v.description) ?? str(v.name) ?? str(v.summary);
  return null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function meetingView(m: { status: string; extraction?: unknown; spec?: unknown }): MeetingView {
  const ex = isObj(m.extraction) ? m.extraction : {};
  const spec = isObj(m.spec) ? m.spec : null;
  const summary = str(ex.summary) ?? textOf(ex.summary) ?? (spec ? str(spec.summary) : null);
  const requirements = list(ex.requirements ?? spec?.requirements)
    .map((r) => {
      const text = textOf(r);
      if (!text) return null;
      const priority = isObj(r) ? (str(r.priority) ?? str(r.moscow) ?? undefined) : undefined;
      return priority ? { text, priority } : { text };
    })
    .filter((x): x is { text: string; priority?: string } => x !== null);
  const decisions = list(ex.decisions)
    .map(textOf)
    .filter((x): x is string => !!x);
  const actionItems = list(ex.actionItems ?? ex.action_items ?? ex.todos)
    .map((a) => {
      const text = textOf(a);
      if (!text) return null;
      const owner = isObj(a) ? (str(a.owner) ?? str(a.assignee) ?? undefined) : undefined;
      return owner ? { text, owner } : { text };
    })
    .filter((x): x is { text: string; owner?: string } => x !== null);
  const features = list(spec?.features ?? spec?.pages ?? spec?.screens)
    .map(textOf)
    .filter((x): x is string => !!x);
  return {
    summary,
    requirements,
    decisions,
    actionItems,
    spec: {
      title: spec ? (str(spec.title) ?? str(spec.name)) : null,
      buildPrompt: spec ? str(spec.buildPrompt) : null,
      features,
      raw: spec,
    },
    canApprove: m.status === "ready" && !!spec,
  };
}

export const MEETING_STATUSES = ["scheduled", "joining", "recording", "processing", "ready", "failed", "deleted"] as const;
