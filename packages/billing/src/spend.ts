import { ForgeError, round4 } from "@forge/shared";
import { users, workspaces, userAgents, eq, type Db } from "@forge/db";
import { priceFor } from "./pricing.js";
import type { UsageFilter, UsageRepo } from "./usage-repo.js";

export interface SpendSubject {
  userId?: string;
  workspaceId?: string;
  agentId?: string;
}

/** Monthly caps in USD of user-facing price; null/undefined = no cap. */
export interface SpendCaps {
  userUsd?: number | null;
  workspaceUsd?: number | null;
  agentUsd?: number | null;
}

export interface SpendCapSource {
  caps(subject: SpendSubject): Promise<SpendCaps>;
}

/** Caps from configuration (tests, env-driven defaults, admin overrides). */
export class StaticSpendCaps implements SpendCapSource {
  constructor(
    private readonly cfg: {
      users?: Record<string, number>;
      workspaces?: Record<string, number>;
      agents?: Record<string, number>;
      defaults?: SpendCaps;
    } = {},
  ) {}
  async caps(s: SpendSubject): Promise<SpendCaps> {
    const d = this.cfg.defaults ?? {};
    return {
      userUsd: (s.userId ? this.cfg.users?.[s.userId] : undefined) ?? d.userUsd ?? null,
      workspaceUsd: (s.workspaceId ? this.cfg.workspaces?.[s.workspaceId] : undefined) ?? d.workspaceUsd ?? null,
      agentUsd: (s.agentId ? this.cfg.agents?.[s.agentId] : undefined) ?? d.agentUsd ?? null,
    };
  }
}

/** Caps from Postgres: users.spend_cap_usd, workspaces.spend_cap_usd, user_agents.definition.spendCapUsd. */
export class DrizzleSpendCapSource implements SpendCapSource {
  constructor(private readonly db: Db) {}
  async caps(s: SpendSubject): Promise<SpendCaps> {
    const [u] = s.userId ? await this.db.select({ cap: users.spendCapUsd }).from(users).where(eq(users.id, s.userId)).limit(1) : [];
    const [w] = s.workspaceId ? await this.db.select({ cap: workspaces.spendCapUsd }).from(workspaces).where(eq(workspaces.id, s.workspaceId)).limit(1) : [];
    const [a] = s.agentId ? await this.db.select({ def: userAgents.definition }).from(userAgents).where(eq(userAgents.id, s.agentId)).limit(1) : [];
    const agentCap = a && typeof a.def === "object" && a.def !== null ? (a.def as { spendCapUsd?: unknown }).spendCapUsd : undefined;
    return { userUsd: u?.cap ?? null, workspaceUsd: w?.cap ?? null, agentUsd: typeof agentCap === "number" ? agentCap : null };
  }
}

/** Start of the current billing period: calendar month in UTC. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface SpendCheck {
  ok: true;
  spent: SpendCaps;
  caps: SpendCaps;
  /** Remaining headroom after the projected spend (null = uncapped). */
  remaining: SpendCaps;
}

/**
 * Enforces spending caps per user, workspace and agent before work starts. Spend = user-facing price of
 * usage metered since the period start (usage of a user = usage of tasks they created).
 */
export class SpendGuard {
  private readonly now: () => Date;
  private readonly periodStart: (now: Date) => Date;
  constructor(
    private readonly repo: UsageRepo,
    private readonly capsSource: SpendCapSource,
    opts: { now?: () => Date; periodStart?: (now: Date) => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.periodStart = opts.periodStart ?? monthStartUtc;
  }

  private async spent(f: UsageFilter): Promise<number> {
    const aggs = await this.repo.aggregate({ ...f, since: this.periodStart(this.now()) });
    return round4(aggs.reduce((s, a) => s + priceFor(a.kind, a.costUsd, a.quantity), 0));
  }

  async spentThisPeriod(subject: SpendSubject): Promise<SpendCaps> {
    const [userUsd, workspaceUsd, agentUsd] = await Promise.all([
      subject.userId ? this.spent({ userId: subject.userId }) : undefined,
      subject.workspaceId ? this.spent({ workspaceId: subject.workspaceId }) : undefined,
      subject.agentId ? this.spent({ agentId: subject.agentId }) : undefined,
    ]);
    return { userUsd, workspaceUsd, agentUsd };
  }

  /** Throws ForgeError("SPEND_CAP") when spent + projected would exceed any cap. */
  async check(subject: SpendSubject, projectedUsd: number): Promise<SpendCheck> {
    if (!Number.isFinite(projectedUsd) || projectedUsd < 0) throw new ForgeError("BAD_INPUT", "projectedUsd must be a non-negative number");
    const [caps, spent] = await Promise.all([this.capsSource.caps(subject), this.spentThisPeriod(subject)]);
    const remaining: SpendCaps = {};
    const scopes: Array<[keyof SpendCaps, string, string | undefined]> = [
      ["agentUsd", "agent", subject.agentId],
      ["userUsd", "user", subject.userId],
      ["workspaceUsd", "workspace", subject.workspaceId],
    ];
    for (const [k, label, id] of scopes) {
      const cap = caps[k];
      if (cap === null || cap === undefined || id === undefined) {
        remaining[k] = null;
        continue;
      }
      const used = spent[k] ?? 0;
      if (used + projectedUsd > cap + 1e-9) {
        throw new ForgeError("SPEND_CAP", `Spending cap reached for ${label} ${id}: $${used.toFixed(2)} spent + $${projectedUsd.toFixed(2)} projected > $${cap.toFixed(2)} cap`, {
          scope: label,
          id,
          capUsd: cap,
          spentUsd: used,
          projectedUsd,
        });
      }
      remaining[k] = round4(cap - used - projectedUsd);
    }
    return { ok: true, spent, caps, remaining };
  }
}
