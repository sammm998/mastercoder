import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ForgeError } from "@forge/shared";
import type { KeyValueStore } from "../lib/kv.js";
import type { ApiConfig } from "../deps.js";

export type OAuthProviderId = "google" | "microsoft";

interface ProviderEndpoints {
  authorize: string;
  token: string;
  scope: string;
}

function endpoints(id: OAuthProviderId, cfg: ApiConfig): ProviderEndpoints {
  if (id === "google") {
    return { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "openid email profile" };
  }
  const tenant = cfg.oauth.microsoft?.tenant || "common";
  return {
    authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope: "openid email profile",
  };
}

const b64url = (b: Buffer) => b.toString("base64url");

const IdTokenClaims = z.object({
  email: z.string().email().optional(),
  preferred_username: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

/** OIDC authorization-code flow with PKCE for Google and Microsoft (platform sign-in, SSO-ready). */
export class OAuthService {
  constructor(
    private readonly cfg: ApiConfig,
    private readonly kv: KeyValueStore,
  ) {}

  private creds(id: OAuthProviderId) {
    const c = id === "google" ? this.cfg.oauth.google : this.cfg.oauth.microsoft;
    if (!c) throw new ForgeError("BAD_INPUT", `${id} sign-in is not configured`);
    return c;
  }

  redirectUri(id: OAuthProviderId): string {
    return `${this.cfg.apiUrl}/auth/oauth/${id}/callback`;
  }

  async start(id: OAuthProviderId, returnTo: string): Promise<string> {
    const c = this.creds(id);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    await this.kv.set(`oauth:${state}`, JSON.stringify({ id, verifier, returnTo }), 600);
    const e = endpoints(id, this.cfg);
    const url = new URL(e.authorize);
    url.search = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: this.redirectUri(id),
      response_type: "code",
      scope: e.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  async callback(id: OAuthProviderId, code: string, state: string): Promise<{ email: string; name: string; returnTo: string }> {
    const raw = await this.kv.get(`oauth:${state}`);
    if (!raw) throw new ForgeError("UNAUTHORIZED", "OAuth state expired");
    await this.kv.del(`oauth:${state}`);
    const saved = JSON.parse(raw) as { id: string; verifier: string; returnTo: string };
    if (saved.id !== id) throw new ForgeError("UNAUTHORIZED", "OAuth state mismatch");
    const c = this.creds(id);
    const res = await fetch(endpoints(id, this.cfg).token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code,
        code_verifier: saved.verifier,
        grant_type: "authorization_code",
        redirect_uri: this.redirectUri(id),
      }),
    });
    if (!res.ok) throw new ForgeError("UNAUTHORIZED", `Token exchange failed (${res.status})`);
    const tok = (await res.json()) as { id_token?: string };
    if (!tok.id_token) throw new ForgeError("UNAUTHORIZED", "No id_token returned");
    // The id_token came directly from the provider's token endpoint over TLS (OIDC core 3.1.3.7), so
    // signature verification is not required for this code flow; we still validate claims shape.
    const payload = tok.id_token.split(".")[1];
    if (!payload) throw new ForgeError("UNAUTHORIZED", "Malformed id_token");
    const claims = IdTokenClaims.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const email = claims.email ?? claims.preferred_username;
    if (!email) throw new ForgeError("UNAUTHORIZED", "Provider did not return an email");
    if (id === "google" && claims.email_verified === false) throw new ForgeError("UNAUTHORIZED", "Email not verified with Google");
    return { email, name: claims.name ?? "", returnTo: saved.returnTo };
  }
}
