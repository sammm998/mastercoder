"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "@/i18n/client";
import { useTRPC } from "@/lib/trpc";
import { LogoMark } from "@/components/Logo";
import { Icon, type IconName } from "@/components/Icon";
import { LocaleSwitcher, ThemeToggle } from "@/components/Preferences";
import { ErrorNotice, LoadingBlock } from "@/components/Feedback";
import type { MessageKey } from "@/i18n/translate";
import { WorkspaceProvider, useWorkspaceSelection, useWorkspacesQuery } from "./workspace-context";

const NAV: Array<{ href: string; label: MessageKey; icon: IconName }> = [
  { href: "/app", label: "nav.dashboard", icon: "home" },
  { href: "/app/agents", label: "nav.agents", icon: "agent" },
  { href: "/app/meetings", label: "nav.meetings", icon: "meeting" },
  { href: "/app/integrations", label: "nav.integrations", icon: "plug" },
  { href: "/app/billing", label: "nav.billing", icon: "card" },
  { href: "/app/settings", label: "nav.settings", icon: "settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const trpc = useTRPC();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const me = useQuery(trpc.auth.me.queryOptions());
  const workspaces = useWorkspacesQuery(!!me.data);
  const { current, set } = useWorkspaceSelection(workspaces.data);
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = pathname.startsWith("/app/p/");
  const logout = useMutation(
    trpc.auth.logout.mutationOptions({
      onSettled: () => {
        qc.clear();
        router.replace("/login");
      },
    }),
  );
  const createWs = useMutation(
    trpc.workspace.create.mutationOptions({
      onSuccess: async (r) => {
        await qc.invalidateQueries({ queryKey: trpc.workspace.list.queryKey() });
        set(r.id);
      },
    }),
  );

  useEffect(() => {
    if (me.isSuccess && !me.data) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.isSuccess, me.data, pathname, router]);

  useEffect(() => setMenuOpen(false), [pathname]);

  if (me.isError) {
    return (
      <div className="container" style={{ paddingBlock: 80 }}>
        <ErrorNotice error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data || !current) {
    return (
      <div className="app-loading" aria-busy="true">
        <div className="container" style={{ paddingBlock: 80, maxWidth: 720 }}>
          {workspaces.isError ? <ErrorNotice error={workspaces.error} onRetry={() => void workspaces.refetch()} /> : <LoadingBlock rows={4} />}
        </div>
      </div>
    );
  }

  const isActive = (href: string) => (href === "/app" ? pathname === "/app" : pathname.startsWith(href));

  return (
    <WorkspaceProvider user={me.data} workspaces={workspaces.data ?? []} workspace={current} setWorkspaceId={set}>
      <div className="shell" data-compact={compact} data-menu-open={menuOpen}>
        <header className="shell-mobilebar">
          <Link href="/app" className="wordmark" aria-label={t("nav.dashboard")}>
            <LogoMark />
            <img src="/brand/scoutr-logo.webp" width={84} height={28} alt="" className="wordmark-img" />
          </Link>
          <button type="button" className="btn btn-ghost btn-icon" aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen((o) => !o)} aria-label={menuOpen ? t("nav.closeMenu") : t("nav.openMenu")}>
            <Icon name={menuOpen ? "x" : "menu"} />
          </button>
        </header>
        <aside id="app-sidebar" className="sidebar" aria-label={t("nav.app")}>
          <Link href="/app" className="sidebar-brand wordmark" aria-label={t("nav.dashboard")}>
            <LogoMark size={32} />
            <img src="/brand/scoutr-logo.webp" width={84} height={28} alt="" aria-hidden="true" className="wordmark-img sidebar-label" />
          </Link>
          <div className="sidebar-ws">
            <label htmlFor="ws-switch" className="eyebrow sidebar-label">
              {t("nav.workspace")}
            </label>
            <select
              id="ws-switch"
              className="select"
              value={current.id}
              aria-label={t("nav.switchWorkspace")}
              data-testid="workspace-switcher"
              onChange={(e) => {
                if (e.target.value === "__new") {
                  const name = window.prompt(t("nav.newWorkspace"));
                  if (name?.trim()) createWs.mutate({ name: name.trim() });
                  return;
                }
                set(e.target.value);
              }}
            >
              {workspaces.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
              <option value="__new">+ {t("nav.newWorkspace")}</option>
            </select>
          </div>
          <nav className="sidebar-nav" aria-label={t("nav.app")}>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="sidebar-link" aria-current={isActive(n.href) ? "page" : undefined} data-tip={compact ? t(n.label) : undefined} data-tip-side="right" aria-label={compact ? t(n.label) : undefined}>
                <Icon name={n.icon} />
                <span className="sidebar-label">{t(n.label)}</span>
              </Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="sidebar-user sidebar-label">
              <span className="avatar" aria-hidden="true">
                {(me.data.name || me.data.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="grow" style={{ overflow: "hidden" }}>
                <span className="sidebar-user-name">{me.data.name || me.data.email}</span>
                <span className="subtle sidebar-user-mail">{me.data.email}</span>
              </span>
            </div>
            <div className="row sidebar-prefs">
              <LocaleSwitcher />
              <ThemeToggle tipSide={compact ? "right" : undefined} />
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => logout.mutate()} aria-label={t("nav.logout")} data-tip={t("nav.logout")} data-tip-side={compact ? "right" : undefined}>
                <Icon name="logout" />
              </button>
            </div>
          </div>
        </aside>
        <main className="shell-main" id="main">
          {children}
        </main>
      </div>
    </WorkspaceProvider>
  );
}
