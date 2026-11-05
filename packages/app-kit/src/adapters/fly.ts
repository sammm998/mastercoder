import { z } from "zod";
import { ForgeError } from "@forge/shared";
import { spawnRunner, type CommandRunner } from "../deploy/command.js";
import { runtimeConfig } from "../deploy/project-config.js";
import {
  DeployInputSchema,
  HostnameSchema,
  deploymentTag,
  isProductionBranch,
  labelSlug,
  type DeployInput,
  type DeployProvider,
  type DeployResult,
  type DnsRecord,
  type DomainStatus,
  type TlsStatus,
} from "../deploy/types.js";

/** Fly.io regions inside the EU that Forge deploys to (Stockholm, Amsterdam, Frankfurt, Paris). */
export const FLY_EU_REGIONS = ["arn", "ams", "fra", "cdg"] as const;
export type FlyEuRegion = (typeof FLY_EU_REGIONS)[number];

export interface FlyOptions {
  token?: string;
  org?: string;
  region?: string;
  machinesUrl?: string;
  graphqlUrl?: string;
  logsUrl?: string;
  fetch?: typeof fetch;
  runner?: CommandRunner;
  docker?: string;
}

const MachineSchema = z.object({ id: z.string(), state: z.string().optional(), region: z.string().optional(), config: z.object({ image: z.string().optional() }).passthrough().optional() });
const CertificateSchema = z.object({
  id: z.string().optional(),
  hostname: z.string(),
  clientStatus: z.string().nullish(),
  configured: z.boolean().nullish(),
  acmeDnsConfigured: z.boolean().nullish(),
  dnsValidationHostname: z.string().nullish(),
  dnsValidationTarget: z.string().nullish(),
});
type Certificate = z.infer<typeof CertificateSchema>;
const CERT_FIELDS = "id hostname clientStatus configured acmeDnsConfigured dnsValidationHostname dnsValidationTarget";

/**
 * Fly.io deployer: Machines REST API (https://fly.io/docs/machines/api/) for apps and machines,
 * GraphQL API (https://api.fly.io/graphql) for public IPs and custom-domain certificates
 * (automatic Let's Encrypt TLS). Images built from a directory are pushed to registry.fly.io with
 * the local docker CLI. One Fly app per project+branch: `forge-<project>` (main) or
 * `forge-<project>-<branch>` (preview). deploymentId = `<app>@<tag>` or `<app>@img:<base64url>`.
 */
export class FlyDeployProvider implements DeployProvider {
  readonly name = "fly";
  readonly isMock = false;
  private readonly token: string;
  private readonly org: string;
  readonly region: FlyEuRegion;
  private readonly machinesUrl: string;
  private readonly graphqlUrl: string;
  private readonly logsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly run: CommandRunner;
  private readonly docker: string;

  constructor(opts: FlyOptions = {}) {
    const token = opts.token ?? process.env.FLY_API_TOKEN;
    if (!token) throw new ForgeError("BAD_INPUT", "FLY_API_TOKEN is required for DEPLOY_PROVIDER=fly");
    this.token = token;
    this.org = opts.org ?? process.env.FLY_ORG ?? "personal";
    const region = opts.region ?? process.env.FLY_REGION ?? "arn";
    if (!(FLY_EU_REGIONS as readonly string[]).includes(region)) throw new ForgeError("BAD_INPUT", `FLY_REGION must be an EU region (${FLY_EU_REGIONS.join(", ")}), got ${region}`);
    this.region = region as FlyEuRegion;
    this.machinesUrl = (opts.machinesUrl ?? "https://api.machines.dev/v1").replace(/\/$/, "");
    this.graphqlUrl = opts.graphqlUrl ?? "https://api.fly.io/graphql";
    this.logsUrl = (opts.logsUrl ?? "https://api.fly.io/api/v1").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.run = opts.runner ?? spawnRunner;
    this.docker = opts.docker ?? "docker";
  }

  appName(projectId: string, branch: string): string {
    const base = `forge-${labelSlug(projectId, 30)}`;
    return isProductionBranch(branch) ? base : `${base}-${labelSlug(branch, 20)}`;
  }

  private async machines<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, allow404 = false): Promise<T | null> {
    const res = await this.fetchImpl(`${this.machinesUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new ForgeError(res.status === 401 ? "UNAUTHORIZED" : "PROVIDER_ERROR", `Fly ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return schema.parse(text ? JSON.parse(text) : {});
  }

  private async gql<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const res = await this.fetchImpl(this.graphqlUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
    if (!res.ok || json.errors?.length) throw new ForgeError("PROVIDER_ERROR", `Fly GraphQL: ${json.errors?.map((e) => e.message).join("; ") ?? res.status}`);
    return schema.parse(json.data);
  }

  private async ensureApp(app: string): Promise<void> {
    const existing = await this.machines("GET", `/apps/${app}`, z.object({ name: z.string().optional() }).passthrough(), undefined, true);
    if (existing) return;
    await this.machines("POST", "/apps", z.unknown(), { app_name: app, org_slug: this.org });
    // Public routing needs IPs: shared IPv4 (free) + dedicated IPv6.
    const mutation = `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }`;
    for (const type of ["shared_v4", "v6"]) await this.gql(mutation, { input: { appId: app, type } }, z.unknown());
  }

  private async pushImage(dir: string, image: string): Promise<void> {
    const login = await this.run(this.docker, ["login", "registry.fly.io", "-u", "x", "--password-stdin"], { input: this.token, timeoutMs: 60_000 });
    if (login.code !== 0) throw new ForgeError("PROVIDER_ERROR", `docker login registry.fly.io failed: ${login.stderr.slice(-500)}`);
    const build = await this.run(this.docker, ["build", "--platform", "linux/amd64", "-t", image, dir], { timeoutMs: 900_000 });
    if (build.code !== 0) throw new ForgeError("PROVIDER_ERROR", `docker build failed: ${build.stderr.slice(-3000)}`);
    const push = await this.run(this.docker, ["push", image], { timeoutMs: 900_000 });
    if (push.code !== 0) throw new ForgeError("PROVIDER_ERROR", `docker push failed: ${push.stderr.slice(-2000)}`);
  }

  private machineConfig(image: string, env: Record<string, string>, port: number, healthPath: string, production: boolean, deploymentId: string) {
    return {
      image,
      env: { ...env, PORT: String(port) },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
      services: [
        {
          protocol: "tcp",
          internal_port: port,
          autostop: "stop",
          autostart: true,
          min_machines_running: production ? 1 : 0,
          ports: [
            { port: 80, handlers: ["http"], force_https: true },
            { port: 443, handlers: ["tls", "http"] },
          ],
        },
      ],
      checks: { health: { type: "http", port, path: healthPath, interval: "15s", timeout: "5s", grace_period: "10s" } },
      metadata: { forge_deployment: deploymentId },
    };
  }

  private async rollOut(app: string, config: ReturnType<FlyDeployProvider["machineConfig"]>): Promise<void> {
    const list = (await this.machines("GET", `/apps/${app}/machines`, z.array(MachineSchema))) ?? [];
    const targets = list.length > 0 ? list : [null];
    for (const m of targets) {
      const created = m
        ? await this.machines("POST", `/apps/${app}/machines/${m.id}`, MachineSchema, { config, region: m.region ?? this.region })
        : await this.machines("POST", `/apps/${app}/machines`, MachineSchema, { config, region: this.region });
      if (!created) throw new ForgeError("PROVIDER_ERROR", "Fly returned no machine");
      await this.machines("GET", `/apps/${app}/machines/${created.id}/wait?state=started&timeout=60`, z.unknown());
    }
  }

  static parseDeploymentId(id: string): { app: string; image?: string; tag?: string } {
    const [app, rest] = id.split("@");
    if (!app || !rest || !/^[a-z0-9-]+$/.test(app)) throw new ForgeError("BAD_INPUT", `Invalid Fly deployment id "${id}"`);
    if (rest.startsWith("img:")) return { app, image: Buffer.from(rest.slice(4), "base64url").toString("utf8") };
    return { app, tag: rest };
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const v = DeployInputSchema.parse(input);
    const app = this.appName(v.projectId, v.branch);
    const cfg = await runtimeConfig(v.dir, v);
    await this.ensureApp(app);
    let image: string;
    let deploymentId: string;
    if (v.dir) {
      const tag = deploymentTag();
      image = `registry.fly.io/${app}:${tag}`;
      deploymentId = `${app}@${tag}`;
      await this.pushImage(v.dir, image);
    } else {
      image = v.image as string;
      deploymentId = `${app}@img:${Buffer.from(image).toString("base64url")}`;
    }
    await this.rollOut(app, this.machineConfig(image, v.env ?? {}, cfg.port, cfg.healthPath, isProductionBranch(v.branch), deploymentId));
    return { deploymentId, url: `https://${app}.fly.dev`, region: this.region, image, createdAt: new Date().toISOString() };
  }

  async rollback(projectId: string, deploymentId: string): Promise<DeployResult> {
    const p = FlyDeployProvider.parseDeploymentId(deploymentId);
    if (!p.app.startsWith(`forge-${labelSlug(projectId, 30)}`)) throw new ForgeError("FORBIDDEN", `Deployment ${deploymentId} does not belong to ${projectId}`);
    const image = p.image ?? `registry.fly.io/${p.app}:${p.tag}`;
    const list = (await this.machines("GET", `/apps/${p.app}/machines`, z.array(MachineSchema.extend({ config: z.record(z.unknown()).optional() })))) ?? [];
    if (list.length === 0) throw new ForgeError("NOT_FOUND", `App ${p.app} has no machines to roll back`);
    for (const m of list) {
      const config = { ...(m.config ?? {}), image, metadata: { ...((m.config?.metadata as Record<string, string> | undefined) ?? {}), forge_deployment: deploymentId } };
      await this.machines("POST", `/apps/${p.app}/machines/${m.id}`, MachineSchema, { config, region: m.region ?? this.region });
      await this.machines("GET", `/apps/${p.app}/machines/${m.id}/wait?state=started&timeout=60`, z.unknown());
    }
    return { deploymentId, url: `https://${p.app}.fly.dev`, region: this.region, image, createdAt: new Date().toISOString() };
  }

  private toStatus(app: string, cert: Certificate, ips: Array<{ address: string; type: string }>): DomainStatus {
    const host = cert.hostname;
    const apex = host.split(".").length === 2;
    const records: DnsRecord[] = apex
      ? ips.map((ip) => ({ type: ip.type.includes("v6") ? ("AAAA" as const) : ("A" as const), name: host, value: ip.address, purpose: "routing" as const }))
      : [{ type: "CNAME", name: host, value: `${app}.fly.dev`, purpose: "routing" }];
    if (cert.dnsValidationHostname && cert.dnsValidationTarget) records.push({ type: "CNAME", name: cert.dnsValidationHostname, value: cert.dnsValidationTarget, purpose: "verification" });
    const s = (cert.clientStatus ?? "").toLowerCase();
    const tlsStatus: TlsStatus = s === "ready" ? "issued" : /fail|error|invalid/.test(s) ? "failed" : "pending";
    return { hostname: host, verification: records, tlsStatus, configured: Boolean(cert.configured) };
  }

  private async ips(app: string): Promise<Array<{ address: string; type: string }>> {
    const r = await this.gql(
      `query($name: String!) { app(name: $name) { ipAddresses { nodes { address type } } } }`,
      { name: app },
      z.object({ app: z.object({ ipAddresses: z.object({ nodes: z.array(z.object({ address: z.string(), type: z.string() })) }) }) }),
    );
    return r.app.ipAddresses.nodes;
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainStatus> {
    const host = HostnameSchema.parse(hostname);
    const app = this.appName(projectId, "main");
    const r = await this.gql(
      `mutation($appId: ID!, $hostname: String!) { addCertificate(appId: $appId, hostname: $hostname) { certificate { ${CERT_FIELDS} } } }`,
      { appId: app, hostname: host },
      z.object({ addCertificate: z.object({ certificate: CertificateSchema }) }),
    );
    return this.toStatus(app, r.addCertificate.certificate, await this.ips(app));
  }

  async checkDomain(projectId: string, hostname: string): Promise<DomainStatus> {
    const host = HostnameSchema.parse(hostname);
    const app = this.appName(projectId, "main");
    const r = await this.gql(
      `query($name: String!, $hostname: String!) { app(name: $name) { certificate(hostname: $hostname) { ${CERT_FIELDS} } } }`,
      { name: app, hostname: host },
      z.object({ app: z.object({ certificate: CertificateSchema.nullable() }) }),
    );
    if (!r.app.certificate) throw new ForgeError("NOT_FOUND", `No certificate for ${host} on ${app}`);
    return this.toStatus(app, r.app.certificate, await this.ips(app));
  }

  async removeDomain(projectId: string, hostname: string): Promise<void> {
    const host = HostnameSchema.parse(hostname);
    await this.gql(
      `mutation($appId: ID!, $hostname: String!) { deleteCertificate(appId: $appId, hostname: $hostname) { app { name } } }`,
      { appId: this.appName(projectId, "main"), hostname: host },
      z.unknown(),
    );
  }

  async logs(deploymentId: string): Promise<string[]> {
    const { app } = FlyDeployProvider.parseDeploymentId(deploymentId);
    const res = await this.fetchImpl(`${this.logsUrl}/apps/${app}/logs`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new ForgeError("PROVIDER_ERROR", `Fly logs: ${res.status}`);
    const body = z
      .object({ data: z.array(z.object({ attributes: z.object({ timestamp: z.string(), message: z.string(), level: z.string().optional(), region: z.string().optional() }) })) })
      .parse(await res.json());
    return body.data.map((d) => `${d.attributes.timestamp} [${d.attributes.region ?? "?"}] ${d.attributes.level ?? "info"} ${d.attributes.message}`);
  }
}
