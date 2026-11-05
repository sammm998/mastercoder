"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

type Status = { kind: "idle" | "busy" | "error" | "sent"; message?: string };

const PROVIDER_LABEL: Record<"google" | "microsoft", string> = { google: "Continue with Google", microsoft: "Continue with Microsoft" };

export function SignInForm({ providers, callbackURL }: { providers: Array<"google" | "microsoft">; callbackURL: string }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "busy" });
    const { error } =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password, callbackURL })
        : await authClient.signUp.email({ email, password, name: name || email.split("@")[0] || email, callbackURL });
    if (error) setStatus({ kind: "error", message: error.message ?? "That did not work. Check your details and try again." });
    else window.location.assign(callbackURL);
  }

  async function onMagicLink() {
    if (!email) {
      setStatus({ kind: "error", message: "Enter your email address first." });
      return;
    }
    setStatus({ kind: "busy" });
    const { error } = await authClient.signIn.magicLink({ email, callbackURL });
    setStatus(error ? { kind: "error", message: error.message ?? "Could not send the link." } : { kind: "sent", message: "Check your inbox for a sign-in link." });
  }

  return (
    <>
      <form onSubmit={onSubmit} aria-describedby="auth-status" noValidate={false}>
        {mode === "sign-up" && (
          <div className="field">
            <label htmlFor="auth-name">Name</label>
            <input id="auth-name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            name="password"
            type="password"
            minLength={10}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <p style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <button className="button" type="submit" disabled={busy}>
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
          <button className="button" data-variant="ghost" type="button" onClick={onMagicLink} disabled={busy}>
            Email me a sign-in link
          </button>
        </p>
      </form>
      {providers.length > 0 && (
        <p style={{ display: "grid", gap: "var(--space-2)" }}>
          {providers.map((p) => (
            <button key={p} className="button" data-variant="ghost" type="button" disabled={busy} onClick={() => authClient.signIn.social({ provider: p, callbackURL })}>
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </p>
      )}
      <p>
        <button className="button" data-variant="ghost" type="button" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
          {mode === "sign-in" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      </p>
      <p id="auth-status" role="status" aria-live="polite" style={{ color: status.kind === "error" ? "var(--color-accent)" : "var(--color-muted)" }}>
        {status.kind === "busy" ? "Working…" : status.message}
      </p>
    </>
  );
}
