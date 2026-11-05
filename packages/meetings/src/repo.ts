import { ForgeError } from "@forge/shared";
import type { MeetingRecord, MeetingRepo } from "./types.js";

/** In-process MeetingRepo (tests, single-node dev). The API wires a DB-backed repo on the `meetings` table. */
export class InMemoryMeetingRepo implements MeetingRepo {
  private rows = new Map<string, MeetingRecord>();
  async create(m: MeetingRecord): Promise<MeetingRecord> {
    if (this.rows.has(m.id)) throw new ForgeError("BAD_INPUT", `Meeting ${m.id} exists`);
    this.rows.set(m.id, structuredClone(m));
    return structuredClone(m);
  }
  async get(id: string): Promise<MeetingRecord | null> {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async update(id: string, patch: Partial<MeetingRecord>): Promise<MeetingRecord> {
    const r = this.rows.get(id);
    if (!r) throw new ForgeError("NOT_FOUND", `Meeting ${id} not found`);
    const next = { ...r, ...structuredClone(patch) } as MeetingRecord;
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
    this.rows.set(id, next);
    return structuredClone(next);
  }
  async findByBotId(botId: string): Promise<MeetingRecord | null> {
    for (const r of this.rows.values()) if (r.externalBotId === botId) return structuredClone(r);
    return null;
  }
  async listExpired(now: Date): Promise<MeetingRecord[]> {
    const t = now.getTime();
    const due = (iso?: string) => iso !== undefined && Date.parse(iso) <= t;
    return [...this.rows.values()]
      .filter((r) => (due(r.retention.audio) && r.audioKey) || (due(r.retention.transcript) && r.transcript) || (due(r.retention.extraction) && (r.extraction || r.spec)))
      .map((r) => structuredClone(r));
  }
}
