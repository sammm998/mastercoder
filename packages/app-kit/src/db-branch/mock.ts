import { ForgeError } from "@forge/shared";
import { BranchNameSchema, type DbBranch, type DbBranchProvider } from "./types.js";

interface MockDb {
  branches: Map<string, DbBranch & { data: Map<string, unknown> }>;
  main: Map<string, unknown>;
}

/**
 * MOCK database branching: in-memory key/value "databases" so callers can exercise the
 * branch → mutate → restore flow in unit tests. Connection URLs use the `mock://` scheme and do
 * not point at any real database.
 */
export class MockDbBranchProvider implements DbBranchProvider {
  readonly name = "mock";
  readonly isMock = true;
  private readonly projects = new Map<string, MockDb>();
  private seq = 0;

  private project(root: string): MockDb {
    let p = this.projects.get(root);
    if (!p) {
      p = { branches: new Map(), main: new Map() };
      this.projects.set(root, p);
    }
    return p;
  }

  /** Main database contents of a mock project (tests mutate this directly). */
  mainData(projectRoot: string): Map<string, unknown> {
    return this.project(projectRoot).main;
  }

  async createBranch(projectRoot: string, name: string, fromBranch?: string): Promise<{ branchId: string; connectionUrl: string }> {
    BranchNameSchema.parse(name);
    const p = this.project(projectRoot);
    const source = fromBranch ? p.branches.get(fromBranch)?.data : p.main;
    if (!source) throw new ForgeError("NOT_FOUND", `Branch ${fromBranch} not found`);
    const branchId = `mockbr_${++this.seq}`;
    const connectionUrl = `mock://${projectRoot}/${branchId}`;
    p.branches.set(branchId, { branchId, name, connectionUrl, parentId: fromBranch, createdAt: new Date().toISOString(), data: new Map(source) });
    return { branchId, connectionUrl };
  }

  async restoreBranch(projectRoot: string, branchId: string): Promise<void> {
    const p = this.project(projectRoot);
    const b = p.branches.get(branchId);
    if (!b) throw new ForgeError("NOT_FOUND", `Branch ${branchId} not found`);
    p.main.clear();
    for (const [k, v] of b.data) p.main.set(k, v);
  }

  async deleteBranch(projectRoot: string, branchId: string): Promise<void> {
    this.project(projectRoot).branches.delete(branchId);
  }

  async listBranches(projectRoot: string): Promise<DbBranch[]> {
    return [...this.project(projectRoot).branches.values()].map(({ data: _data, ...b }) => b);
  }
}
