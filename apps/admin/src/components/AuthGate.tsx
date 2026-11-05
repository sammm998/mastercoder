"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { S } from "@/lib/strings";
import { API_URL, errorMessage, trpc } from "@/lib/trpc";

const NAV = [
  { href: "/", label: S.nav.overview },
  { href: "/users", label: S.nav.users },
  { href: "/projects", label: S.nav.projects },
  { href: "/costs", label: S.nav.costs },
  { href: "/providers", label: S.nav.providers },
  { href: "/abuse", label: S.nav.abuse },
] as const;

/** Gate: signed out → sign-in form; signed in but not admin → admins-only notice; admin → app shell. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  if (me.isLoading)
    return (
      <div className="center-screen" role="status">
        {S.auth.checking}
      </div>
    );
  if (me.error)
    return (
      <div className="center-screen">
        <div className="alert critical signin" role="alert">
          <strong>{S.common.error}</strong>
          <p>{S.auth.apiDown(API_URL)}</p>
          <p className="muted">{errorMessage(me.error)}</p>
          <button type="button" onClick={() => void me.refetch()}>
            {S.common.retry}
          </button>
        </div>
      </div>
    );
  if (!me.data) return <SignIn />;
  if (!me.data.isAdmin) return <AdminsOnly email={me.data.email} />;
  return <Shell email={me.data.email}>{children}</Shell>;
}

function SignOutButton() {
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({ onSuccess: () => utils.invalidate() });
  return (
    <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
      {S.auth.signOut}
    </button>
  );
}

function SignIn() {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = trpc.auth.login.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };
  return (
    <main className="center-screen" id="main">
      <form className="card signin" onSubmit={submit} aria-labelledby="signin-title" noValidate={false}>
        <div>
          <h1 id="signin-title">{S.auth.title}</h1>
          <p className="muted">{S.auth.lead}</p>
        </div>
        <label className="field">
          {S.auth.email}
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          {S.auth.password}
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {login.error ? (
          <p className="error-text" role="alert">
            {errorMessage(login.error)}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={login.isPending}>
          {login.isPending ? S.auth.submitting : S.auth.submit}
        </button>
      </form>
    </main>
  );
}

function AdminsOnly({ email }: { email: string }) {
  return (
    <main className="center-screen" id="main">
      <div className="card signin" role="alert">
        <h1>{S.auth.adminsOnlyTitle}</h1>
        <p>{S.auth.adminsOnlyBody(email)}</p>
        <SignOutButton />
      </div>
    </main>
  );
}

function Shell({ email, children }: { email: string; children: ReactNode }) {
  const pathname = usePathname();
  const openAbuse = trpc.admin.stats.useQuery(undefined, { refetchInterval: 60_000 }).data?.openAbuse ?? 0;
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {S.skipToContent}
      </a>
      <aside className="sidebar">
        <div className="brand">
          Forge<small>Admin</small>
        </div>
        <nav aria-label={S.nav.label}>
          <ul className="nav">
            {NAV.map((n) => {
              const current = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              return (
                <li key={n.href}>
                  <Link href={n.href} aria-current={current ? "page" : undefined}>
                    <span>{n.label}</span>
                    {n.href === "/abuse" && openAbuse > 0 ? (
                      <span className="badge critical" aria-label={`${openAbuse} ${S.overview.openAbuse}`}>
                        {openAbuse}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="sidebar-foot">
          <span>
            {S.auth.signedInAs} <strong>{email}</strong>
          </span>
          <SignOutButton />
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
