import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { ForgeError } from "@forge/shared";
import { BranchNameSchema, type DbBranch, type DbBranchProvider } from "../db-branch/types.js";

export interface PgCloneOptions {
  /** Superuser/CREATEDB connection to a maintenance database (never one of the project DBs). */
  adminUrl?: string;
}

const DB_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const BRANCH_SEP = "__br_";

function assertIdent(name: string, what: string): void {
  if (!DB_IDENT.test(name)) throw new ForgeError("BAD_INPUT", `Invalid ${what} "${name}" (lowercase letters, digits, _; max 63)`);
}

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Real database branching for development and self-hosted installs on plain Postgres:
 * a branch is `CREATE DATABASE <branch> TEMPLATE <source>` (a full physical copy), restore swaps
 * the project's main database for a fresh copy of the branch. Connections to the source are
 * terminated first because Postgres refuses to copy a database that is in use.
 */
export class PgCloneBranchProvider implements DbBranchProvider {
  readonly name = "pgclone";
  readonly isMock = false;
  private readonly adminUrl: string;
  private sqlClient: postgres.Sql | null = null;

  constructor(opts: PgCloneOptions = {}) {
    this.adminUrl = opts.adminUrl ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "postgres://forge:forge@localhost:5432/forge";
  }

  private get sql(): postgres.Sql {
    if (!this.sqlClient) this.sqlClient = postgres(this.adminUrl, { max: 1, onnotice: () => undefined });
    return this.sqlClient;
  }

  async close(): Promise<void> {
    await this.sqlClient?.end({ timeout: 5 });
    this.sqlClient = null;
  }

  /**
   * A login role that owns the app's database and nothing else (no superuser, no BYPASSRLS), so the
   * generated app connects with least privilege. Idempotent; also re-applied after a branch restore.
   * Returns the app's connection URL.
   */
  async ensureAppRole(database: string, role: string, password: string): Promise<string> {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role) || !/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error("Invalid role or database name");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(password)) throw new Error("Invalid password");
    const exists = await this.sql`select 1 from pg_roles where rolname = ${role}`;
    if (!exists.length) await this.sql.unsafe(`create role "${role}" login nosuperuser nocreatedb nocreaterole nobypassrls password '${password}'`);
    else await this.sql.unsafe(`alter role "${role}" with login nosuperuser nobypassrls password '${password}'`);
    if (!(await this.exists(database))) await this.createDatabase(database);
    await this.sql.unsafe(`alter database "${database}" owner to "${role}"`);
    await this.sql.unsafe(`revoke connect on database "${database}" from public`);
    await this.sql.unsafe(`grant connect on database "${database}" to "${role}"`);
    const u = new URL(this.adminUrl);
    u.username = role;
    u.password = password;
    u.pathname = `/${database}`;
    return u.toString();
  }

  /** Connection URL for a database on the same server as the admin connection. */
  urlFor(database: string): string {
    const u = new URL(this.adminUrl);
    u.pathname = `/${database}`;
    return u.toString();
  }

  private branchDbName(root: string, name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "branch";
    const suffix = randomBytes(3).toString("hex");
    let id = `${root}${BRANCH_SEP}${slug}_${suffix}`;
    if (id.length > 63) {
      const h = createHash("sha256").update(id).digest("hex").slice(0, 8);
      id = `${root.slice(0, 40)}${BRANCH_SEP}${h}_${suffix}`.slice(0, 63);
    }
    return id;
  }

  private assertBranchOf(root: string, branchId: string): void {
    assertIdent(branchId, "branch id");
    if (!branchId.startsWith(`${root}${BRANCH_SEP}`)) throw new ForgeError("FORBIDDEN", `Branch ${branchId} does not belong to ${root}`);
  }

  async exists(database: string): Promise<boolean> {
    const rows = await this.sql`select 1 from pg_database where datname = ${database}`;
    return rows.length > 0;
  }

  /** Create an empty database (a project's main DB). No-op when it exists. */
  async createDatabase(database: string): Promise<string> {
    assertIdent(database, "database name");
    if (!(await this.exists(database))) await this.sql`create database ${this.sql(database)}`;
    return this.urlFor(database);
  }

  /** Drop a project's main database and all its branches. */
  async dropProject(root: string): Promise<void> {
    assertIdent(root, "project database");
    for (const b of await this.listBranches(root)) await this.deleteBranch(root, b.branchId);
    await this.sql.unsafe(`drop database if exists "${root}" with (force)`);
  }

  private async terminate(database: string): Promise<void> {
    await this.sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`;
  }

  /** CREATE DATABASE ... TEMPLATE, retrying while stray connections to the source get terminated. */
  private async copy(source: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.terminate(source);
      try {
        await this.sql`create database ${this.sql(target)} template ${this.sql(source)}`;
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt >= 5 || !/being accessed by other users/.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  async createBranch(projectRoot: string, name: string, fromBranch?: string): Promise<{ branchId: string; connectionUrl: string }> {
    assertIdent(projectRoot, "project database");
    BranchNameSchema.parse(name);
    const source = fromBranch ?? projectRoot;
    if (fromBranch) this.assertBranchOf(projectRoot, fromBranch);
    if (!(await this.exists(source))) throw new ForgeError("NOT_FOUND", `Database ${source} does not exist`);
    const branchId = this.branchDbName(projectRoot, name);
    await this.copy(source, branchId);
    const meta = JSON.stringify({ name, parentId: fromBranch ?? null, createdAt: new Date().toISOString() });
    await this.sql.unsafe(`comment on database "${branchId}" is ${literal(meta)}`);
    return { branchId, connectionUrl: this.urlFor(branchId) };
  }

  async restoreBranch(projectRoot: string, branchId: string): Promise<void> {
    assertIdent(projectRoot, "project database");
    this.assertBranchOf(projectRoot, branchId);
    if (!(await this.exists(branchId))) throw new ForgeError("NOT_FOUND", `Branch ${branchId} does not exist`);
    // Keep the current main DB aside until the copy succeeded, so a failed restore loses nothing.
    const aside = `${projectRoot.slice(0, 40)}__restore_${randomBytes(3).toString("hex")}`;
    const hadMain = await this.exists(projectRoot);
    if (hadMain) {
      await this.terminate(projectRoot);
      await this.sql.unsafe(`alter database "${projectRoot}" rename to "${aside}"`);
    }
    try {
      await this.copy(branchId, projectRoot);
    } catch (e) {
      if (hadMain) await this.sql.unsafe(`alter database "${aside}" rename to "${projectRoot}"`);
      throw e;
    }
    if (hadMain) await this.sql.unsafe(`drop database if exists "${aside}" with (force)`);
  }

  async deleteBranch(projectRoot: string, branchId: string): Promise<void> {
    this.assertBranchOf(projectRoot, branchId);
    await this.sql.unsafe(`drop database if exists "${branchId}" with (force)`);
  }

  async listBranches(projectRoot: string): Promise<DbBranch[]> {
    assertIdent(projectRoot, "project database");
    const prefix = `${projectRoot}${BRANCH_SEP}`.replace(/_/g, "\\_");
    const rows = await this.sql<Array<{ datname: string; comment: string | null }>>`
      select datname, shobj_description(oid, 'pg_database') as comment
      from pg_database where datname like ${`${prefix}%`} order by datname`;
    return rows.map((r) => {
      let meta: { name?: string; parentId?: string | null; createdAt?: string } = {};
      try {
        meta = r.comment ? (JSON.parse(r.comment) as typeof meta) : {};
      } catch {
        meta = {};
      }
      return {
        branchId: r.datname,
        name: meta.name ?? r.datname,
        connectionUrl: this.urlFor(r.datname),
        parentId: meta.parentId ?? undefined,
        createdAt: meta.createdAt ?? "",
      };
    });
  }
}
