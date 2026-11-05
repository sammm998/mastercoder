import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { trpc, useSession } from "../../src/api";
import { Button, ErrorBanner, Loading, Screen } from "../../src/components/ui";
import { useI18n } from "../../src/i18n";
import { extractMagicToken } from "../../src/lib/auth";

/** Deep link target: forge://auth/magic?token=… (or the web app's /auth/magic link opened in the app). */
export default function MagicLink() {
  const { t, locale } = useI18n();
  const params = useLocalSearchParams<{ token?: string }>();
  const router = useRouter();
  const session = useSession();
  const verify = trpc.auth.verifyMagicLink.useMutation({
    onSuccess: async (r) => {
      await session.signIn(r.token);
      router.replace("/");
    },
  });
  const started = useRef(false);
  const token = extractMagicToken(String(params.token ?? ""));

  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    verify.mutate({ token, locale });
  }, [token, locale, verify]);

  return (
    <Screen>
      {!token || verify.isError ? (
        <>
          <ErrorBanner message={t("signIn.linkFailed")} />
          <Button label={t("signIn.title")} onPress={() => router.replace("/sign-in")} variant="secondary" />
        </>
      ) : (
        <Loading label={t("signIn.verifying")} />
      )}
    </Screen>
  );
}
