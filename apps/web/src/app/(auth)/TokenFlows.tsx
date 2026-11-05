"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { useTRPC } from "@/lib/trpc";
import { ErrorNotice, Spinner } from "@/components/Feedback";

export function MagicVerify({ token }: { token?: string }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const verify = useMutation(
    trpc.auth.verifyMagicLink.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries();
        router.replace("/app");
      },
    }),
  );
  const started = useRef(false);
  useEffect(() => {
    // Magic links are single-use: guard against React strict-mode double effects.
    if (!token || started.current) return;
    started.current = true;
    verify.mutate({ token, locale });
  }, [token, locale, verify]);
  return (
    <div className="auth-card">
      <h1>{t("auth.loginTitle")}</h1>
      {!token && <div className="notice notice-bad">{t("auth.magicMissing")}</div>}
      {token && verify.isPending && <Spinner label={t("auth.magicVerifying")} />}
      {verify.isError && (
        <>
          <div className="notice notice-bad" role="alert">
            {t("auth.magicFailed")}
          </div>
          <Link className="btn" href="/login">
            {t("auth.login")}
          </Link>
        </>
      )}
    </div>
  );
}

export function InviteAccept({ token }: { token?: string }) {
  const t = useT();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const me = useQuery(trpc.auth.me.queryOptions());
  const accept = useMutation(
    trpc.workspace.acceptInvite.mutationOptions({
      onSuccess: async (r) => {
        try {
          localStorage.setItem("forge_ws", r.workspaceId);
        } catch {
          /* storage unavailable */
        }
        await qc.invalidateQueries();
        router.push("/app");
      },
    }),
  );
  const here = `/invite?token=${encodeURIComponent(token ?? "")}`;
  return (
    <div className="auth-card">
      <header className="stack" style={{ gap: 8 }}>
        <h1>{t("auth.inviteTitle")}</h1>
        <p className="muted">{t("auth.inviteLede")}</p>
      </header>
      {!token ? (
        <div className="notice notice-bad">{t("auth.inviteMissing")}</div>
      ) : me.isPending ? (
        <Spinner label={t("common.loading")} />
      ) : !me.data ? (
        <>
          <p>{t("auth.inviteSignIn")}</p>
          <div className="row">
            <Link className="btn btn-primary" href={`/login?next=${encodeURIComponent(here)}`}>
              {t("auth.login")}
            </Link>
            <Link className="btn" href={`/signup?next=${encodeURIComponent(here)}`}>
              {t("auth.createOne")}
            </Link>
          </div>
        </>
      ) : accept.isSuccess ? (
        <div className="notice notice-ok" role="status">
          {t("auth.inviteAccepted")}
        </div>
      ) : (
        <>
          <p className="muted">{me.data.email}</p>
          <ErrorNotice error={accept.error} />
          <button type="button" className="btn btn-primary btn-lg" disabled={accept.isPending} onClick={() => accept.mutate({ token })} data-testid="accept-invite">
            {accept.isPending ? t("auth.inviteAccepting") : t("auth.inviteAccept")}
          </button>
        </>
      )}
    </div>
  );
}
