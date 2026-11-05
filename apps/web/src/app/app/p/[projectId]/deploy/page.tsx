"use client";

import { use } from "react";
import "@/styles/workspace.css";
import { ProjectWorkspace } from "@/features/project/ProjectWorkspace";

/** Deep link to the deploy panel of a project workspace. */
export default function ProjectDeployPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return <ProjectWorkspace projectId={projectId} initialTab="deploy" />;
}
