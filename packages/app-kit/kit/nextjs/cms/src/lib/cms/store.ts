import "server-only";
import { eq } from "drizzle-orm";
import seed from "@/content/site.json";
import { db } from "@/db/client";
import { cmsContent } from "@/db/cms-schema";
import { SiteContentSchema, type SiteContent } from "./schema";

const KEY = "site";

/** Saved content, or the seed in src/content/site.json before the first save. */
export async function getSiteContent(): Promise<SiteContent> {
  const rows = await db.select().from(cmsContent).where(eq(cmsContent.key, KEY)).limit(1);
  const parsed = SiteContentSchema.safeParse(rows[0]?.data ?? seed);
  return parsed.success ? parsed.data : SiteContentSchema.parse(seed);
}

export async function saveSiteContent(content: SiteContent, userId: string): Promise<void> {
  const data = SiteContentSchema.parse(content);
  await db
    .insert(cmsContent)
    .values({ key: KEY, data, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: cmsContent.key, set: { data, updatedBy: userId, updatedAt: new Date() } });
}
