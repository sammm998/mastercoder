import { useRouter } from "expo-router";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorText, trpc } from "../../src/api";
import { RecordDot } from "../../src/components/icons";
import { Body, Button, Caption, Card, ErrorBanner, Heading, Loading, Pill, ProgressBar, Row, Small } from "../../src/components/ui";
import { useWorkspace } from "../../src/hooks/useWorkspace";
import { useI18n } from "../../src/i18n";
import type { PendingUpload, UploadProgress } from "../../src/lib/chunks";
import { formatBytes, formatDuration, formatPercent } from "../../src/lib/format";
import type { TFunction } from "../../src/lib/i18n";
import { STATUS_TONE, statusLabel } from "../../src/components/meetingStatus";
import { colors, radius, space } from "../../src/theme";
import { useUploads } from "../../src/uploads";

function uploadLine(t: TFunction, locale: string, u: PendingUpload, p: UploadProgress | undefined): string {
  switch (u.status) {
    case "local":
      return t("meetings.uploadLocal");
    case "uploading":
      return t("meetings.uploading", { percent: formatPercent(p?.fraction ?? 0, locale) });
    case "completing":
      return t("meetings.uploadCompleting");
    case "done":
      return t("meetings.uploadDone");
    case "expired":
      return t("meetings.uploadExpired");
    case "failed":
      return t("meetings.uploadFailed", { error: u.error ?? "" });
  }
}

export default function Meetings() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const ws = useWorkspace();
  const uploads = useUploads();
  const workspaceId = ws.current?.id ?? "";
  const list = trpc.meetings.list.useQuery({ workspaceId }, { enabled: !!workspaceId, refetchInterval: 15_000 });
  const dateFmt = new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });

  const confirmRemove = (u: PendingUpload) =>
    Alert.alert(t("meetings.remove"), t("meetings.removeConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: () => void uploads.remove(u.id) },
    ]);

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl tintColor={colors.accent} refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />}>
        <Button label={t("meetings.record")} onPress={() => router.push("/meetings/record")} icon={<RecordDot color={colors.onAccent} />} />

        {uploads.authBlocked ? <ErrorBanner message={t("meetings.signInToUpload")} /> : null}

        {uploads.uploads.length ? (
          <View style={styles.section}>
            <Caption>{t("meetings.uploads")}</Caption>
            {uploads.uploads.map((u) => {
              const p = uploads.progress[u.id];
              const line = uploadLine(t, locale, u, p);
              return (
                <Card key={u.id} accent={u.status === "failed" || u.status === "expired" ? "danger" : u.status === "done" ? "success" : "accent"}>
                  <Heading>{u.title}</Heading>
                  <Small>
                    {[dateFmt.format(new Date(u.createdAt)), u.durationMs ? formatDuration(u.durationMs) : null, formatBytes(u.totalSize, locale)].filter(Boolean).join(" · ")}
                  </Small>
                  {u.status === "uploading" || u.status === "completing" ? <ProgressBar value={p?.fraction ?? 0} label={line} /> : null}
                  <Small accessibilityLiveRegion="polite">{line}</Small>
                  <Row>
                    {u.status === "local" || u.status === "uploading" ? <Button compact variant="secondary" label={t("meetings.resume")} onPress={() => uploads.resume(u.id)} /> : null}
                    {u.status === "expired" || u.status === "failed" ? <Button compact variant="secondary" label={t("meetings.uploadAgain")} onPress={() => uploads.restart(u.id)} /> : null}
                    {u.status !== "done" && u.status !== "completing" ? <Button compact variant="ghost" label={t("meetings.remove")} onPress={() => confirmRemove(u)} /> : null}
                    {u.meetingId && u.status === "done" ? <Button compact variant="ghost" label={t("common.open")} onPress={() => router.push({ pathname: "/meetings/[id]", params: { id: u.meetingId as string } })} /> : null}
                  </Row>
                </Card>
              );
            })}
          </View>
        ) : null}

        <View style={styles.section}>
          <Caption>{t("meetings.title")}</Caption>
          {list.error ? <ErrorBanner message={errorText(list.error, t)} onRetry={() => void list.refetch()} retryLabel={t("common.retry")} /> : null}
          {list.isLoading ? <Loading label={t("common.loading")} /> : null}
          {list.data && list.data.length === 0 ? <Body style={{ color: colors.muted }}>{t("meetings.empty")}</Body> : null}
          {(list.data ?? []).map((m) => (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              accessibilityLabel={`${m.title ?? t("meeting.title")}, ${statusLabel(t, m.status)}`}
              onPress={() => router.push({ pathname: "/meetings/[id]", params: { id: m.id } })}
              style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.surface2 }]}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Heading>{m.title ?? t("meeting.title")}</Heading>
                <Small>{dateFmt.format(new Date(m.createdAt))}</Small>
              </View>
              <Pill tone={STATUS_TONE[m.status] ?? "neutral"} label={statusLabel(t, m.status)} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl },
  section: { gap: space.sm },
  item: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
});
