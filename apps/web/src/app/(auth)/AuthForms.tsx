"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useT, useLocale } from "@/i18n/client";
import { useTRPC } from "@/lib/trpc";
import { oauthStartUrl, safeNext } from "@/lib/env";
import { ErrorNotice } from "@/components/Feedback";
import { rich, slot } from "@/i18n/rich";

function OAuthButtons({ next }: { next: string }) {
  const t = useT();
  return (
    <div className="oauth">
      <a className="btn" href={oauthStartUrl("google", next)}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.1 14.7 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7H12z" />
        </svg>
        {t("auth.google")}
      </a>
      <a className="btn" href={oauthStartUrl("microsoft", next)}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
          <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
          <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
          <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
        </svg>
        {t("auth.microsoft")}
      </a>
    </div>
  );
}

export function LoginForm({ next: rawNext, oauthError }: { next?: string; oauthError?: string }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const next = safeNext(rawNext);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries();
        router.push(next);
      },
    }),
  );
  const magic = useMutation(trpc.auth.requestMagicLink.mutationOptions());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };
  return (
    <div className="auth-card">
      <header className="stack" style={{ gap: 8 }}>
        <h1>{t("auth.loginTitle")}</h1>
        <p className="muted">{t("auth.loginLede")}</p>
      </header>
      {oauthError && <div className="notice notice-bad" role="alert">{oauthError}</div>}
      <form className="stack" onSubmit={submit} noValidate={false}>
        <div className="field">
          <label htmlFor="login-email">{t("auth.email")}</label>
          <input id="login-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">{t("auth.password")}</label>
          <input id="login-password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorNotice error={login.error} compact />
        <button type="submit" className="btn btn-primary btn-lg" disabled={login.isPending}>
          {login.isPending ? t("auth.signingIn") : t("auth.login")}
        </button>
      </form>
      <div className="divider">{t("auth.or")}</div>
      {magic.isSuccess ? (
        <div className="notice notice-ok" role="status">
          {t("auth.magicSent", { email })}
        </div>
      ) : (
        <button type="button" className="btn" disabled={!email || magic.isPending} onClick={() => magic.mutate({ email, locale })}>
          {t("auth.magicLink")}
        </button>
      )}
      <ErrorNotice error={magic.error} compact />
      <OAuthButtons next={next} />
      <p className="muted">
        {t("auth.noAccount")} <Link href={`/signup${rawNext ? `?next=${encodeURIComponent(next)}` : ""}`}>{t("auth.createOne")}</Link>
      </p>
    </div>
  );
}

export function SignupForm({ next: rawNext }: { next?: string }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const next = safeNext(rawNext);
  const openedAt = useRef<number>(0);
  const [form, setForm] = useState({ name: "", email: "", password: "", website: "" });
  const signup = useMutation(
    trpc.auth.signup.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries();
        router.push(next);
      },
    }),
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const onFocus = () => {
    if (!openedAt.current) openedAt.current = performance.now();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signup.mutate({
      name: form.name,
      email: form.email,
      password: form.password,
      locale,
      website: form.website || undefined,
      elapsedMs: openedAt.current ? Math.round(performance.now() - openedAt.current) : undefined,
    });
  };
  return (
    <div className="auth-card">
      <header className="stack" style={{ gap: 8 }}>
        <h1>{t("auth.signupTitle")}</h1>
        <p className="muted">{t("auth.signupLede")}</p>
      </header>
      <OAuthButtons next={next} />
      <div className="divider">{t("auth.or")}</div>
      <form className="stack" onSubmit={submit} onFocus={onFocus}>
        <div className="field">
          <label htmlFor="su-name">{t("auth.name")}</label>
          <input id="su-name" className="input" autoComplete="name" value={form.name} onChange={set("name")} maxLength={100} />
        </div>
        <div className="field">
          <label htmlFor="su-email">{t("auth.email")}</label>
          <input id="su-email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
        </div>
        <div className="field">
          <label htmlFor="su-password">{t("auth.password")}</label>
          <input id="su-password" className="input" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set("password")} aria-describedby="su-password-hint" />
          <p id="su-password-hint" className="hint">
            {t("auth.passwordHint")}
          </p>
        </div>
        <div className="hp" aria-hidden="true">
          <label htmlFor="su-website">{t("auth.website")}</label>
          <input id="su-website" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
        </div>
        <ErrorNotice error={signup.error} compact />
        <button type="submit" className="btn btn-primary btn-lg" disabled={signup.isPending}>
          {signup.isPending ? t("auth.creating") : t("auth.signup")}
        </button>
        <p className="hint">
          {rich(t("auth.terms", { terms: slot("terms"), privacy: slot("privacy") }), {
            terms: <Link href="/legal/terms">{t("auth.termsLink")}</Link>,
            privacy: <Link href="/legal/privacy">{t("auth.privacyLink")}</Link>,
          })}
        </p>
      </form>
      <p className="muted">
        {t("auth.haveAccount")} <Link href={`/login${rawNext ? `?next=${encodeURIComponent(next)}` : ""}`}>{t("auth.loginInstead")}</Link>
      </p>
    </div>
  );
}
