import type { Metadata } from "next";
import { isCmsAdmin } from "@/lib/cms/admin";
import { getSiteContent } from "@/lib/cms/store";
import { requireUser } from "@/lib/session";
import { ContentEditor } from "./content-editor";

export const metadata: Metadata = { title: "Edit content", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireUser("/admin");
  if (!isCmsAdmin(user.email)) {
    return (
      <section className="container" aria-labelledby="admin-title" style={{ paddingBlock: "var(--space-16)" }}>
        <h1 id="admin-title">No access</h1>
        <p>{user.email} is not an editor of this site. Ask the site owner to add you.</p>
      </section>
    );
  }
  const content = await getSiteContent();
  return (
    <section className="container" aria-labelledby="admin-title" style={{ paddingBlock: "var(--space-12)", maxWidth: "48rem" }}>
      <h1 id="admin-title">Edit content</h1>
      <ContentEditor initial={content} />
    </section>
  );
}
