import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { lookup } from "node:dns/promises";
import { ForgeError, createLogger } from "@forge/shared";
import { spawnRunner, type CommandRunner } from "../deploy/command.js";
import { runtimeConfig } from "../deploy/project-config.js";
import {
  DeployInputSchema,
  HostnameSchema,
  deploymentTag,
  labelSlug,
  type DeployInput,
  type DeployProvider,
  type DeployResult,
  type DomainStatus,
} from "../deploy/types.js";

export interface LocalDeployOptions {
  docker?: string;
  /** Host name used in preview URLs. */
  host?: string;
  runner?: CommandRunner;
  /** Extra root CA passed to `docker build` as secret "ca" (see template Dockerfiles). */
  buildCaFile?: string;
  /** Max wait for the health check after `docker run`. */
  healthTimeoutMs?: number;
  /** Docker image repository prefix. */
  repo?: string;
}

const log = createLogger({ component: "local-deploy" });

/**
 * Real local deployer for development: `docker build` the project's Dockerfile and `docker run` it on
 * this host with a mapped port. Every branch gets a stable preview URL http://<host>:<port>; a
 * redeploy reuses the port. Images are kept per deployment, so rollback re-runs a previous tag.
 * deploymentId = `<project>--<branch>--<tag>`.
 */
export class LocalDeployProvider implements DeployProvider {
  readonly name = "local";
  readonly isMock = false;
  private readonly docker: string;
  private readonly host: string;
  private readonly run: CommandRunner;
  private readonly buildCaFile?: string;
  private readonly healthTimeoutMs: number;
  private readonly repo: string;
  private readonly domains = new Map<string, Set<string>>();

  constructor(opts: LocalDeployOptions = {}) {
    this.docker = opts.docker ?? "docker";
    this.host = opts.host ?? "localhost";
    this.run = opts.runner ?? spawnRunner;
    const ca = opts.buildCaFile ?? process.env.DEPLOY_BUILD_CA_FILE ?? process.env.NODE_EXTRA_CA_CERTS;
    this.buildCaFile = ca && existsSync(ca) ? ca : undefined;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 60_000;
    this.repo = opts.repo ?? "forge-local";
  }

  private async docker$(args: string[], opts: { cwd?: string; timeoutMs?: number; allowFail?: boolean } = {}): Promise<string> {
    const r = await this.run(this.docker, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 120_000 });
    if (r.code !== 0 && !opts.allowFail) throw new ForgeError("PROVIDER_ERROR", `docker ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).slice(-4000)}`);
    return r.stdout.trim();
  }

  private names(projectId: string, branch: string, tag: string) {
    const project = labelSlug(projectId);
    const br = labelSlug(branch, 20);
    return {
      project,
      branch: br,
      container: `forge-${project}-${br}`,
      image: `${this.repo}/${project}:${br}-${tag}`,
      deploymentId: `${project}--${br}--${tag}`,
    };
  }

  static parseDeploymentId(id: string): { project: string; branch: string; tag: string } {
    const m = /^([a-z0-9-]+?)--([a-z0-9-]+?)--(v[a-z0-9]+)$/.exec(id);
    if (!m) throw new ForgeError("BAD_INPUT", `Invalid local deployment id "${id}"`);
    return { project: m[1] as string, branch: m[2] as string, tag: m[3] as string };
  }

  private async existingHostPort(container: string): Promise<number | undefined> {
    const out = await this.docker$(["inspect", "--format", "{{json .HostConfig.PortBindings}}", container], { allowFail: true });
    const m = /"HostPort":"(\d+)"/.exec(out);
    return m ? Number(m[1]) : undefined;
  }

  private async containerLabel(container: string, label: string): Promise<string | undefined> {
    const out = await this.docker$(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, container], { allowFail: true });
    return out && out !== "<no value>" ? out : undefined;
  }

  private freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "0.0.0.0", () => {
        const addr = srv.address();
        srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
      });
    });
  }

  private async waitHealthy(url: string): Promise<boolean> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async start(n: ReturnType<LocalDeployProvider["names"]>, cfg: { port: number; healthPath: string }, env: Record<string, string>): Promise<DeployResult> {
    const hostPort = (await this.existingHostPort(n.container)) ?? (await this.freePort());
    const previousImage = await this.containerLabel(n.container, "forge.image");
    await this.docker$(["rm", "-f", n.container], { allowFail: true });
    const envArgs = Object.entries({ PORT: String(cfg.port), ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const runArgs = (image: string, deploymentId: string) => [
      "run", "-d", "--name", n.container, "--restart", "unless-stopped",
      "--label", `forge.project=${n.project}`, "--label", `forge.branch=${n.branch}`,
      "--label", `forge.deployment=${deploymentId}`, "--label", `forge.image=${image}`,
      "--label", `forge.port=${cfg.port}`, "--label", `forge.health=${cfg.healthPath}`,
      "-p", `${hostPort}:${cfg.port}`, ...envArgs, image,
    ];
    await this.docker$(runArgs(n.image, n.deploymentId));
    const url = `http://${this.host}:${hostPort}`;
    if (!(await this.waitHealthy(`${url}${cfg.healthPath}`))) {
      const logs = await this.docker$(["logs", "--tail", "80", n.container], { allowFail: true });
      await this.docker$(["rm", "-f", n.container], { allowFail: true });
      if (previousImage) {
        const prev = await this.docker$(["image", "inspect", "--format", '{{index .Config.Labels "forge.deployment"}}', previousImage], { allowFail: true });
        log.warn("health check failed, restoring previous deployment", { container: n.container, previousImage });
        await this.docker$(runArgs(previousImage, prev || n.deploymentId), { allowFail: true });
      }
      throw new ForgeError("PROVIDER_ERROR", `Deployment ${n.deploymentId} failed its health check at ${cfg.healthPath}:\n${logs.slice(-3000)}`);
    }
    return { deploymentId: n.deploymentId, url, region: "local", image: n.image, createdAt: new Date().toISOString() };
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const v = DeployInputSchema.parse(input);
    const n = this.names(v.projectId, v.branch, deploymentTag());
    const cfg = await runtimeConfig(v.dir, v);
    const labels = ["--label", `forge.project=${n.project}`, "--label", `forge.branch=${n.branch}`, "--label", `forge.deployment=${n.deploymentId}`, "--label", `forge.port=${cfg.port}`, "--label", `forge.health=${cfg.healthPath}`];
    if (v.dir) {
      const args = ["build", "-t", n.image, ...labels];
      // Builds reach registries through the host's egress proxy when one is configured.
      const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
      if (proxy) args.push("--network", "host", "--build-arg", `HTTPS_PROXY=${proxy}`, "--build-arg", `https_proxy=${proxy}`);
      if (this.buildCaFile) args.push("--secret", `id=ca,src=${this.buildCaFile}`);
      args.push(v.dir);
      await this.docker$(args, { timeoutMs: 900_000 });
    } else {
      await this.docker$(["pull", v.image as string], { allowFail: true, timeoutMs: 600_000 });
      // Re-tag (with labels) so rollback can find this deployment's image locally.
      const df = `FROM ${v.image}\n${labels.filter((_, i) => i % 2 === 1).map((l) => `LABEL ${l.replace("=", '="')}"`).join("\n")}\n`;
      const r = await this.run(this.docker, ["build", "-t", n.image, "-"], { input: df, timeoutMs: 300_000 });
      if (r.code !== 0) throw new ForgeError("PROVIDER_ERROR", `docker build (retag) failed: ${r.stderr.slice(-2000)}`);
    }
    return this.start(n, cfg, v.env ?? {});
  }

  async rollback(projectId: string, deploymentId: string): Promise<DeployResult> {
    const p = LocalDeployProvider.parseDeploymentId(deploymentId);
    if (p.project !== labelSlug(projectId)) throw new ForgeError("FORBIDDEN", `Deployment ${deploymentId} does not belong to ${projectId}`);
    const n = this.names(projectId, p.branch, p.tag);
    const meta = await this.docker$(["image", "inspect", "--format", '{{index .Config.Labels "forge.port"}} {{index .Config.Labels "forge.health"}}', n.image], { allowFail: true });
    if (!meta) throw new ForgeError("NOT_FOUND", `Image for deployment ${deploymentId} no longer exists`);
    const [port, health] = meta.split(" ");
    // Keep the env of the running container (secrets are not stored in images).
    const envOut = await this.docker$(["inspect", "--format", "{{json .Config.Env}}", n.container], { allowFail: true });
    const env: Record<string, string> = {};
    try {
      for (const kv of JSON.parse(envOut || "[]") as string[]) {
        const i = kv.indexOf("=");
        const k = kv.slice(0, i);
        if (!["PATH", "NODE_VERSION", "YARN_VERSION", "HOSTNAME", "HOME", "PORT"].includes(k)) env[k] = kv.slice(i + 1);
      }
    } catch {
      // no running container: start without extra env
    }
    return this.start(n, { port: Number(port) || 3000, healthPath: health && health !== "<no value>" ? health : "/" }, env);
  }

  /** Deployments (newest first) of a project, from image labels. */
  async listDeployments(projectId: string): Promise<Array<{ deploymentId: string; image: string }>> {
    const out = await this.docker$(["images", "--filter", `label=forge.project=${labelSlug(projectId)}`, "--format", '{{.Repository}}:{{.Tag}} {{.CreatedAt}}']);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[0] as string)
      .map((image) => {
        const [, tagPart = ""] = image.split(":");
        const m = /^(.+)-(v[a-z0-9]+)$/.exec(tagPart);
        return { image, deploymentId: m ? `${labelSlug(projectId)}--${m[1]}--${m[2]}` : image };
      })
      .sort((a, b) => b.deploymentId.localeCompare(a.deploymentId));
  }

  /** Stop and remove a project's containers and images (all branches). */
  async destroy(projectId: string): Promise<void> {
    const project = labelSlug(projectId);
    const ids = await this.docker$(["ps", "-aq", "--filter", `label=forge.project=${project}`], { allowFail: true });
    if (ids) await this.docker$(["rm", "-f", ...ids.split("\n").filter(Boolean)], { allowFail: true });
    const imgs = await this.docker$(["images", "-q", "--filter", `label=forge.project=${project}`], { allowFail: true });
    if (imgs) await this.docker$(["rmi", "-f", ...new Set(imgs.split("\n").filter(Boolean))], { allowFail: true });
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainStatus> {
    const h = HostnameSchema.parse(hostname);
    const set = this.domains.get(projectId) ?? new Set<string>();
    set.add(h);
    this.domains.set(projectId, set);
    return this.checkDomain(projectId, h);
  }

  async checkDomain(projectId: string, hostname: string): Promise<DomainStatus> {
    const h = HostnameSchema.parse(hostname);
    if (!this.domains.get(projectId)?.has(h)) throw new ForgeError("NOT_FOUND", `Domain ${h} is not attached to ${projectId}`);
    let configured = false;
    try {
      const addrs = await lookup(h, { all: true });
      configured = addrs.some((a) => a.address === "127.0.0.1" || a.address === "::1");
    } catch {
      configured = false;
    }
    // Local deploys serve plain HTTP on a mapped port; TLS does not apply.
    return { hostname: h, configured, tlsStatus: "not_applicable", verification: [{ type: "A", name: h, value: "127.0.0.1", purpose: "routing" }] };
  }

  async removeDomain(projectId: string, hostname: string): Promise<void> {
    this.domains.get(projectId)?.delete(HostnameSchema.parse(hostname));
  }

  async logs(deploymentId: string): Promise<string[]> {
    LocalDeployProvider.parseDeploymentId(deploymentId);
    const ids = await this.docker$(["ps", "-aq", "--filter", `label=forge.deployment=${deploymentId}`], { allowFail: true });
    const id = ids.split("\n").find(Boolean);
    if (!id) return [];
    const r = await this.run(this.docker, ["logs", "--tail", "500", "--timestamps", id], { timeoutMs: 30_000 });
    return `${r.stdout}${r.stderr}`.split("\n").filter(Boolean);
  }
}
