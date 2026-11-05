import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorText, trpc } from "../src/api";
import { Body, Button, Caption, Chip, ErrorBanner, Field, Heading, Loading, Pill, Row, Small, Title } from "../src/components/ui";
import { useWorkspace } from "../src/hooks/useWorkspace";
import { useI18n } from "../src/i18n";
import { colors, radius, space } from "../src/theme";
import { useUploads } from "../src/uploads";

export default function Projects() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const ws = useWorkspace();
  const uploads = useUploads();
  const workspaceId = ws.current?.id ?? "";
  const projects = trpc.project.list.useQuery({ workspaceId }, { enabled: !!workspaceId });
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const create = trpc.project.create.useMutation({
    onSuccess: async (r) => {
      setName("");
      await utils.project.list.invalidate({ workspaceId });
      router.push({ pathname: "/project/[id]", params: { id: r.id } });
    },
  });
  const pendingUploads = uploads.uploads.filter((u) => u.status !== "done").length;
  const dateFmt = new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", { dateStyle: "medium" });

  const header = (
    <View style={styles.header}>
      {ws.workspaces.length > 1 ? (
        <View style={{ gap: space.sm }}>
          <Caption>{t("projects.workspace")}</Caption>
          <Row>
            {ws.workspaces.map((w) => (
              <Chip key={w.id} label={w.name} selected={w.id === workspaceId} onPress={() => ws.select(w.id)} />
            ))}
          </Row>
        </View>
      ) : null}
      <Row>
        <Button label={t("projects.meetings")} variant="secondary" onPress={() => router.push("/meetings")} accessibilityHint={pendingUploads ? t("meetings.uploadQueued") : undefined} style={styles.flex} />
        <Button label={t("meetings.record")} variant="secondary" onPress={() => router.push("/meetings/record")} style={styles.flex} />
      </Row>
      {pendingUploads > 0 ? <Pill tone="accent" label={`${t("meetings.uploads")}: ${pendingUploads}`} /> : null}
      <View style={styles.newRow}>
        <View style={styles.flex}>
          <Field label={t("projects.newName")} value={name} onChangeText={setName} placeholder={t("projects.newPlaceholder")} maxLength={100} returnKeyType="done" onSubmitEditing={() => name.trim() && workspaceId && create.mutate({ workspaceId, name: name.trim() })} />
        </View>
        <Button label={create.isPending ? t("projects.creating") : t("projects.create")} onPress={() => create.mutate({ workspaceId, name: name.trim() })} disabled={!name.trim() || !workspaceId} busy={create.isPending} style={styles.createBtn} />
      </View>
      {create.error ? <ErrorBanner message={errorText(create.error, t)} /> : null}
      {ws.error ? <ErrorBanner message={errorText(ws.error, t)} onRetry={() => void ws.refetch()} retryLabel={t("common.retry")} /> : null}
      {projects.error ? <ErrorBanner message={errorText(projects.error, t)} onRetry={() => void projects.refetch()} retryLabel={t("common.retry")} /> : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel={t("projects.settings")} onPress={() => router.push("/settings")} hitSlop={12} style={styles.headerBtn}>
              <Small style={{ color: colors.text }}>{t("projects.settings")}</Small>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={projects.data ?? []}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl tintColor={colors.accent} refreshing={projects.isRefetching} onRefresh={() => void projects.refetch()} />}
        ListEmptyComponent={
          ws.isLoading || projects.isLoading ? (
            <Loading label={t("common.loading")} />
          ) : !ws.current ? (
            <Body style={styles.empty}>{t("projects.noWorkspace")}</Body>
          ) : (
            <Body style={styles.empty}>{t("projects.empty")}</Body>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("projects.openProject", { name: item.name })}
            onPress={() => router.push({ pathname: "/project/[id]", params: { id: item.id } })}
            style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors.surface2 }]}
          >
            <View style={styles.flex}>
              <Title style={styles.itemTitle}>{item.name}</Title>
              <Small>
                {[item.template, dateFmt.format(new Date(item.createdAt))].filter(Boolean).join(" · ")}
              </Small>
            </View>
            {item.isPublic ? <Pill label={t("projects.public")} /> : null}
            <Heading style={{ color: colors.faint }}>›</Heading>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  list: { padding: space.lg, gap: space.sm, paddingBottom: space.xxxl },
  header: { gap: space.lg, marginBottom: space.md },
  newRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  createBtn: { minWidth: 96 },
  empty: { color: colors.muted, paddingVertical: space.xl },
  item: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  itemTitle: { fontSize: 20, lineHeight: 26 },
  headerBtn: { paddingHorizontal: space.sm, minHeight: 44, justifyContent: "center" },
});
