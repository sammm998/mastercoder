import { ForgeError } from "@forge/shared";
import { DeployInputSchema, HostnameSchema, deploymentTag, labelSlug, type DeployInput, type DeployProvider, type DeployResult, type DomainStatus } from "./types.js";

interface MockDeployment extends DeployResult {
  projectId: string;
  branch: string;
}

/**
 * MOCK deployer: records deployments in memory and returns `*.mock.forge.invalid` URLs (the
 * `.invalid` TLD never resolves). Nothing is built or run.
 */
export class MockDeployProvider implements DeployProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly deployments: MockDeployment[] = [];
  /** Active deployment per `${project}/${branch}`. */
  readonly active = new Map<string, string>();
  private readonly domains = new Map<string, DomainStatus>();

  async deploy(input: DeployInput): Promise<DeployResult> {
    const v = DeployInputSchema.parse(input);
    const project = labelSlug(v.projectId);
    const branch = labelSlug(v.branch, 20);
    const tag = deploymentTag();
    const d: MockDeployment = {
      projectId: v.projectId,
      branch,
      deploymentId: `mock--${project}--${branch}--${tag}`,
      url: `https://${branch}--${project}.mock.forge.invalid`,
      region: "mock-eu",
      image: v.image ?? `mock/${project}:${tag}`,
      createdAt: new Date().toISOString(),
    };
    this.deployments.push(d);
    this.active.set(`${project}/${branch}`, d.deploymentId);
    return strip(d);
  }

  async rollback(projectId: string, deploymentId: string): Promise<DeployResult> {
    const d = this.deployments.find((x) => x.deploymentId === deploymentId && x.projectId === projectId);
    if (!d) throw new ForgeError("NOT_FOUND", `Deployment ${deploymentId} not found`);
    this.active.set(`${labelSlug(projectId)}/${d.branch}`, d.deploymentId);
    return strip(d);
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainStatus> {
    const h = HostnameSchema.parse(hostname);
    const s: DomainStatus = {
      hostname: h,
      configured: false,
      tlsStatus: "pending",
      verification: [
        { type: "CNAME", name: h, value: `${labelSlug(projectId)}.mock.forge.invalid`, purpose: "routing" },
        { type: "TXT", name: `_forge-challenge.${h}`, value: `mock-verify-${labelSlug(projectId)}`, purpose: "verification" },
      ],
    };
    this.domains.set(`${projectId}/${h}`, s);
    return s;
  }

  async checkDomain(projectId: string, hostname: string): Promise<DomainStatus> {
    const s = this.domains.get(`${projectId}/${HostnameSchema.parse(hostname)}`);
    if (!s) throw new ForgeError("NOT_FOUND", `Domain ${hostname} not attached`);
    return s;
  }

  async removeDomain(projectId: string, hostname: string): Promise<void> {
    this.domains.delete(`${projectId}/${HostnameSchema.parse(hostname)}`);
  }

  async logs(deploymentId: string): Promise<string[]> {
    const d = this.deployments.find((x) => x.deploymentId === deploymentId);
    if (!d) throw new ForgeError("NOT_FOUND", `Deployment ${deploymentId} not found`);
    return [`[mock] deployment ${deploymentId} recorded at ${d.createdAt}; the mock deployer runs nothing`];
  }
}

function strip(d: MockDeployment): DeployResult {
  return { deploymentId: d.deploymentId, url: d.url, region: d.region, image: d.image, createdAt: d.createdAt };
}
