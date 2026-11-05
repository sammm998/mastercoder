import { and, eq, abuseReports, deployments, type Db } from "@forge/db";
import { newId } from "@forge/shared";
import { scanForAbuse, type ScanInput, type ScanResult } from "./scanner.js";
import { extractUrls, type UrlReputation } from "./reputation.js";

export interface DeploymentScanOutcome extends ScanResult {
  reportId?: string;
  reputationHits: Array<{ url: string; threats: string[] }>;
  action: "none" | "queued_for_review" | "taken_down";
}

/**
 * Scan a deployment, file an abuse report for the admin queue, and take malicious deployments offline
 * immediately (an admin can restore by dismissing the report).
 */
export async function scanDeployment(
  db: Db,
  rep: UrlReputation,
  input: ScanInput & { projectId: string; deploymentId?: string; autoTakedown?: boolean },
): Promise<DeploymentScanOutcome> {
  const result = scanForAbuse(input);
  let reputationHits: Array<{ url: string; threats: string[] }> = [];
  try {
    reputationHits = await rep.check(extractUrls(input.files));
  } catch {
    reputationHits = [];
  }
  const score = Math.min(100, result.score + reputationHits.length * 40);
  const verdict = score >= 60 ? "malicious" : score >= 30 ? "suspicious" : "clean";
  if (verdict === "clean") return { ...result, score, verdict, reputationHits, action: "none" };
  const top = [...result.findings].sort((a, b) => b.weight - a.weight)[0];
  const reportId = newId("abr");
  await db.insert(abuseReports).values({
    id: reportId,
    projectId: input.projectId,
    deploymentId: input.deploymentId ?? null,
    source: "scan",
    category: top?.category ?? "malware",
    evidence: { score, verdict, findings: result.findings, reputationHits },
  });
  let action: DeploymentScanOutcome["action"] = "queued_for_review";
  if (verdict === "malicious" && (input.autoTakedown ?? true) && input.deploymentId) {
    await db.update(deployments).set({ status: "taken_down" }).where(and(eq(deployments.id, input.deploymentId), eq(deployments.projectId, input.projectId)));
    action = "taken_down";
  }
  return { ...result, score, verdict, reportId, reputationHits, action };
}
