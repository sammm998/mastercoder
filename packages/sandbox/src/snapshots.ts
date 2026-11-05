import { z } from "zod";
import { ForgeError, LocalObjectStore, newId, type ObjectStore } from "@forge/shared";
import { safeName } from "./adapters/docker/cli.js";

export const SnapshotMetaSchema = z.object({
  snapshotId: z.string(),
  projectId: z.string(),
  sandboxId: z.string(),
  provider: z.string(),
  label: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

const SNAPSHOT_ID = /^snap_[a-z0-9]{8,64}$/;

/** Workspace tarballs (`tar -czf` of /workspace) keyed by project + snapshotId in an ObjectStore. */
export class SnapshotStore {
  constructor(readonly store: ObjectStore, private readonly prefix = "sandbox-snapshots") {}

  private key(projectId: string, snapshotId: string, ext: "tar.gz" | "json"): string {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new ForgeError("BAD_INPUT", `invalid snapshotId ${snapshotId}`);
    return `${this.prefix}/${safeName(projectId)}/${snapshotId}.${ext}`;
  }

  newId(): string {
    return newId("snap");
  }

  async save(meta: Omit<SnapshotMeta, "sizeBytes" | "createdAt">, tarball: Uint8Array): Promise<SnapshotMeta> {
    const full: SnapshotMeta = { ...meta, sizeBytes: tarball.byteLength, createdAt: new Date().toISOString() };
    await this.store.put(this.key(meta.projectId, meta.snapshotId, "tar.gz"), tarball, { contentType: "application/gzip" });
    await this.store.put(this.key(meta.projectId, meta.snapshotId, "json"), JSON.stringify(full), { contentType: "application/json" });
    return full;
  }

  async load(projectId: string, snapshotId: string): Promise<Uint8Array> {
    const key = this.key(projectId, snapshotId, "tar.gz");
    if (!(await this.store.exists(key))) throw new ForgeError("NOT_FOUND", `snapshot ${snapshotId} not found for project ${projectId}`);
    return this.store.get(key);
  }

  async meta(projectId: string, snapshotId: string): Promise<SnapshotMeta | null> {
    const key = this.key(projectId, snapshotId, "json");
    if (!(await this.store.exists(key))) return null;
    return SnapshotMetaSchema.parse(JSON.parse(Buffer.from(await this.store.get(key)).toString("utf8")));
  }
}

export function defaultSnapshotStore(): SnapshotStore {
  return new SnapshotStore(new LocalObjectStore(process.env.SANDBOX_SNAPSHOT_DIR || ".data/sandbox-snapshots"));
}
