import { and, asc, eq, uploadChunks, type Db } from "@forge/db";
import type { ChunkRecord, ChunkRepo } from "./upload.js";

/** ChunkRepo on the `upload_chunks` table (primary key upload_id + index). */
export class DrizzleChunkRepo implements ChunkRepo {
  constructor(private readonly db: Db) {}

  async insertIfAbsent(c: ChunkRecord): Promise<{ row: ChunkRecord; inserted: boolean }> {
    const inserted = await this.db
      .insert(uploadChunks)
      .values({ uploadId: c.uploadId, index: c.index, storageKey: c.storageKey, size: c.size, sha256: c.sha256 })
      .onConflictDoNothing()
      .returning();
    if (inserted.length) return { row: toRecord(inserted[0] as typeof uploadChunks.$inferSelect), inserted: true };
    const existing = await this.db
      .select()
      .from(uploadChunks)
      .where(and(eq(uploadChunks.uploadId, c.uploadId), eq(uploadChunks.index, c.index)));
    return { row: toRecord(existing[0] as typeof uploadChunks.$inferSelect), inserted: false };
  }

  async list(uploadId: string): Promise<ChunkRecord[]> {
    const rows = await this.db.select().from(uploadChunks).where(eq(uploadChunks.uploadId, uploadId)).orderBy(asc(uploadChunks.index));
    return rows.map(toRecord);
  }

  async deleteUpload(uploadId: string): Promise<void> {
    await this.db.delete(uploadChunks).where(eq(uploadChunks.uploadId, uploadId));
  }
}

function toRecord(r: typeof uploadChunks.$inferSelect): ChunkRecord {
  return { uploadId: r.uploadId, index: r.index, storageKey: r.storageKey, size: r.size, sha256: r.sha256 };
}
