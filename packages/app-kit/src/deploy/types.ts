import { z } from "zod";
import { ForgeError } from "@forge/shared";

export interface DeployInput {
  projectId: string;
  /** Directory with a Dockerfile (built by the provider). One of `dir` / `image` is required. */
  dir?: string;
  /** Prebuilt OCI image reference. */
  image?: string;
  /** Git branch; `main` is production, anything else gets its own preview URL. */
  branch: string;
  env?: Record<string, string>;
  /** Port the container listens on. Defaults to forge.json `containerPort ?? port`, else 3000. */
  port?: number;
  /** HTTP path that returns 2xx when the app is healthy. Defaults to forge.json `healthPath`, else "/". */
  healthPath?: string;
}

export interface DeployResult {
  deploymentId: string;
  url: string;
  region: string;
  image: string;
  createdAt: string;
}

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME" | "TXT";
  name: string;
  value: string;
  /** routing = points traffic at the app; verification = proves ownership / ACME challenge. */
  purpose: "routing" | "verification";
}

export type TlsStatus = "pending" | "issued" | "failed" | "not_applicable";

export interface DomainStatus {
  hostname: string;
  verification: DnsRecord[];
  tlsStatus: TlsStatus;
  /** DNS points at the app. */
  configured: boolean;
}

export interface DeployProvider {
  readonly name: string;
  readonly isMock: boolean;
  deploy(input: DeployInput): Promise<DeployResult>;
  /** Re-activate a previous deployment (same branch) without rebuilding. */
  rollback(projectId: string, deploymentId: string): Promise<DeployResult>;
  addDomain(projectId: string, hostname: string): Promise<DomainStatus>;
  checkDomain(projectId: string, hostname: string): Promise<DomainStatus>;
  removeDomain(projectId: string, hostname: string): Promise<void>;
  /** Recent log lines of a deployment. */
  logs(deploymentId: string): Promise<string[]>;
}

export const DeployInputSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    dir: z.string().min(1).optional(),
    image: z.string().regex(/^[\w./:@-]+$/).optional(),
    branch: z.string().min(1).max(100),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env keys must be identifiers"), z.string()).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthPath: z.string().startsWith("/").optional(),
  })
  .refine((v) => Boolean(v.dir) !== Boolean(v.image), "exactly one of dir or image is required");

export const HostnameSchema = z
  .string()
  .max(253)
  .transform((s) => s.toLowerCase().replace(/\.$/, ""))
  .refine((s) => /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(s), "invalid hostname");

/** DNS-label-safe slug (lowercase, digits, dashes). */
export function labelSlug(s: string, max = 30): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  if (!out) throw new ForgeError("BAD_INPUT", `Cannot derive a name from "${s}"`);
  return out;
}

export function isProductionBranch(branch: string): boolean {
  return branch === "main" || branch === "master" || branch === "production";
}

/** Unique, sortable deployment tag. */
export function deploymentTag(now = Date.now()): string {
  return `v${now.toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0")}`;
}
