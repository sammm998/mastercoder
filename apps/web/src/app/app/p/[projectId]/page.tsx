"use client";

import { use } from "react";
import "@/styles/workspace.css";
import { ProjectWorkspace, isTab } from "@/features/project/ProjectWorkspace";

export default function ProjectPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = use(params);
  const { tab } = use(searchParams);
  return <ProjectWorkspace projectId={projectId} initialTab={isTab(tab) ? tab : undefined} />;
}
