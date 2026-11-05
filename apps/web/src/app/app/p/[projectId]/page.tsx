"use client";

import { use } from "react";
import "@/styles/workspace.css";
import { ProjectWorkspace } from "@/features/project/ProjectWorkspace";

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return <ProjectWorkspace projectId={projectId} />;
}
