import { and, eq, checkpoints, projects, projectFiles, type Db } from "@forge/db";
import { newId } from "@forge/shared";
import type { SandboxPort } from "@forge/agent-core";
import { PgCloneBranchProvider, type DbBranchProvider } from "@forge/app-kit";

/**
 * Checkpoints = git commit (in the sandbox) + sandbox snapshot + database branch of the generated
 * app's database. Restore puts both code and data back.
 */
export function createCheckpointing(db: Db, dbBranches: DbBranchProvider) {
  async function ensureProjectDb(projectId: string): Promise<string | null> {
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (p?.dbBranchRoot) return p.dbBranchRoot;
    if (!(dbBranches instanceof PgCloneBranchProvider)) return null;
    const root = `app_${projectId.replace(/[^a-z0-9]/g, "_")}`.slice(0, 40);
    if (!(await dbBranches.exists(root))) await dbBranches.createDatabase(root);
    await db.update(projects).set({ dbBranchRoot: root }).where(eq(projects.id, projectId));
    return root;
  }

  /** Durable copy of source files for the editor, remix and export. */
  async function mirrorFiles(sandbox: SandboxPort, projectId: string) {
    const files = (await sandbox.listFiles(".", { recursive: true })).filter((f) => !/(^|\/)(node_modules|\.git|\.next|dist|\.venv|__pycache__)(\/|$)/.test(f)).slice(0, 2000);
    for (const path of files) {
      const content = await sandbox.readFile(path).catch(() => null);
      if (content === null || content.length > 500_000 || content.includes("\u0000")) continue;
      await db.insert(projectFiles).values({ projectId, path, content }).onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: { content, updatedAt: new Date() } });
    }
  }

  async function create(i: { sandbox: SandboxPort; projectId: string; taskId?: string; label: string }) {
    const git = `git -c user.email=agent@forge.local -c user.name=Forge`;
    await i.sandbox.exec(`(git rev-parse --git-dir >/dev/null 2>&1 || git init -q) && ${git} add -A && ${git} commit -qm ${JSON.stringify(`checkpoint: ${i.label}`)} --allow-empty`, { timeoutMs: 60_000 });
    const commit = (await i.sandbox.exec("git rev-parse HEAD")).stdout.trim() || "unknown";
    const { snapshotId } = await i.sandbox.snapshot(i.label);
    const root = await ensureProjectDb(i.projectId);
    const dbBranchId = root ? (await dbBranches.createBranch(root, `cp_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`)).branchId : undefined;
    const id = newId("cp");
    await db.insert(checkpoints).values({ id, projectId: i.projectId, taskId: i.taskId ?? null, label: i.label, commitSha: commit, sandboxSnapshotId: snapshotId, dbBranchId });
    await mirrorFiles(i.sandbox, i.projectId);
    return { checkpointId: id, commit, snapshotId, dbBranchId };
  }

  async function restore(i: { sandbox: SandboxPort; projectId: string; checkpointId: string }) {
    const [cp] = await db.select().from(checkpoints).where(and(eq(checkpoints.id, i.checkpointId), eq(checkpoints.projectId, i.projectId)));
    if (!cp) throw new Error("Checkpoint not found");
    if (cp.sandboxSnapshotId) await i.sandbox.restore(cp.sandboxSnapshotId);
    const [p] = await db.select().from(projects).where(eq(projects.id, i.projectId));
    if (cp.dbBranchId && p?.dbBranchRoot) await dbBranches.restoreBranch(p.dbBranchRoot, cp.dbBranchId);
    await mirrorFiles(i.sandbox, i.projectId);
    return cp;
  }

  return { create, restore, ensureProjectDb, mirrorFiles };
}
