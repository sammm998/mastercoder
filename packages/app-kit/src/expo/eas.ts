import QRCode from "qrcode";
import { z } from "zod";
import { ForgeError } from "@forge/shared";

/** eas-cli version Forge pins inside sandboxes (npm view eas-cli version, 2026-11). */
export const EAS_CLI_VERSION = "27.4.1";

export const EasBuildInputSchema = z.object({
  platform: z.enum(["ios", "android", "all"]),
  /** Build profile from eas.json (development | preview | production | custom). */
  profile: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "invalid profile name"),
  /** Wait for the build to finish (blocks the sandbox) instead of returning after queueing. */
  wait: z.boolean().default(false),
  message: z.string().max(200).optional(),
  autoSubmit: z.boolean().default(false),
  cwd: z.string().default("/workspace"),
});
export type EasBuildInput = z.input<typeof EasBuildInputSchema>;

export interface EasBuildCommand {
  /** argv form (no shell). */
  argv: string[];
  /** Same command, shell-quoted, for `sandbox.exec(cmd)`. */
  command: string;
  cwd: string;
  /** Env names the sandbox must provide (values come from the vault, never from here). */
  requiredEnv: string[];
  env: Record<string, string>;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Command to run an EAS cloud build non-interactively inside a sandbox. Requires EXPO_TOKEN in the
 * sandbox env. `--json` prints build metadata (ids, artifact URLs) for the caller to parse.
 */
export function easBuild(input: EasBuildInput): EasBuildCommand {
  const v = EasBuildInputSchema.parse(input);
  const argv = ["npx", "--yes", `eas-cli@${EAS_CLI_VERSION}`, "build", "--platform", v.platform, "--profile", v.profile, "--non-interactive", "--json"];
  if (!v.wait) argv.push("--no-wait");
  if (v.message) argv.push("--message", v.message);
  if (v.autoSubmit) argv.push("--auto-submit");
  return {
    argv,
    command: argv.map(shellQuote).join(" "),
    cwd: v.cwd,
    requiredEnv: ["EXPO_TOKEN"],
    env: { EAS_NO_VCS: "1", CI: "1", EXPO_NO_TELEMETRY: "1" },
  };
}

const EasBuildJsonSchema = z.array(
  z
    .object({
      id: z.string(),
      platform: z.string(),
      status: z.string(),
      artifacts: z.object({ buildUrl: z.string().nullish(), applicationArchiveUrl: z.string().nullish() }).partial().nullish(),
    })
    .passthrough(),
);

/** Parse `eas build --json` output into build ids, statuses and artifact URLs. */
export function parseEasBuildOutput(stdout: string): Array<{ id: string; platform: string; status: string; artifactUrl?: string }> {
  const start = stdout.indexOf("[");
  if (start === -1) throw new ForgeError("PROVIDER_ERROR", "eas build printed no JSON");
  const builds = EasBuildJsonSchema.parse(JSON.parse(stdout.slice(start)));
  return builds.map((b) => ({ id: b.id, platform: b.platform, status: b.status, artifactUrl: b.artifacts?.buildUrl ?? b.artifacts?.applicationArchiveUrl ?? undefined }));
}

/** SVG QR code for an Expo preview URL (exp://, exps://, https://). Scan with Expo Go / camera. */
export async function expoPreviewQr(url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ForgeError("BAD_INPUT", `Invalid preview URL: ${url}`);
  }
  if (!["exp:", "exps:", "https:", "http:"].includes(u.protocol)) throw new ForgeError("BAD_INPUT", `Unsupported preview URL scheme ${u.protocol}`);
  return QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#000000", light: "#ffffff" } });
}
