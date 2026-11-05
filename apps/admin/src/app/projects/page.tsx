import type { Metadata } from "next";
import { ProjectsView } from "@/components/views/ProjectsView";
import { S } from "@/lib/strings";

export const metadata: Metadata = { title: S.nav.projects };

export default function Page() {
  return <ProjectsView />;
}
