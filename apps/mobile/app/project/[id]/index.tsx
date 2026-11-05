import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Switch, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorText, trpc } from "../../../src/api";
import { TimelineItemView, type TimelineActions } from "../../../src/components/TimelineItemView";
import { Body, Button, ErrorBanner, Loading, Pill, Small } from "../../../src/components/ui";
import { useProjectTimeline } from "../../../src/hooks/useProjectTimeline";
import { useI18n } from "../../../src/i18n";
import { addUserPrompt, answerQuestion, dropUserPrompt, type TimelineItem } from "../../../src/lib/events";
import { MicIcon } from "../../../src/components/icons";
import { MIN_TOUCH, colors, radius, space, type } from "../../../src/theme";

export default function ProjectChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = String(id ?? "");
  const router = useRouter();
  const { t, locale } = useI18n();
  const project = trpc.project.get.useQuery({ projectId }, { enabled: !!projectId });
  const { timeline, update, connection, historyLoading } = useProjectTimeline(projectId);
  const [text, setText] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const listRef = useRef<FlatList<TimelineItem>>(null);

  const createTask = trpc.task.create.useMutation();
  const answer = trpc.task.answerClarification.useMutation();
  const approve = trpc.task.approvePlan.useMutation({ onSettled: () => setApproving(null) });

  const awaiting = timeline.awaitingAnswer;
  const send = useCallback(() => {
    const prompt = text.trim();
    if (!prompt) return;
    const now = new Date().toISOString();
    if (awaiting) {
      update((tl) => answerQuestion(tl, { id: `local_${Date.now()}`, text: prompt, at: now }));
      answer.mutate({ taskId: awaiting.taskId, answer: prompt });
    } else {
      const localId = `local_${Date.now()}`;
      update((tl) => addUserPrompt(tl, { id: localId, text: prompt, source: "typed", at: now }));
      createTask.mutate(
        { projectId, prompt, source: "typed", planMode },
        {
          onError: () => {
            update((tl) => dropUserPrompt(tl, localId));
            setText((cur) => cur || prompt);
          },
        },
      );
    }
    setText("");
  }, [text, awaiting, update, answer, createTask, projectId, planMode]);

  const actions: TimelineActions = useMemo(
    () => ({
      canAnswer: !!awaiting,
      onAnswer: (option) => {
        if (!awaiting) return;
        update((tl) => answerQuestion(tl, { id: `local_${Date.now()}`, text: option, at: new Date().toISOString() }));
        answer.mutate({ taskId: awaiting.taskId, answer: option });
      },
      onApprovePlan: (taskId) => {
        setApproving(taskId);
        approve.mutate({ taskId });
      },
      onOpenPreview: () => router.push({ pathname: "/project/[id]/preview", params: { id: projectId } }),
      approvingTaskId: approving,
    }),
    [awaiting, update, answer, approve, router, projectId, approving],
  );

  const error = createTask.error ?? answer.error ?? approve.error;
  const conn =
    connection === "open" ? (
      <Pill tone="success" label={t("chat.live")} />
    ) : connection === "failed" || connection === "closed" ? (
      <Pill tone="danger" label={t("chat.disconnected")} />
    ) : (
      <Pill tone="warning" label={connection === "reconnecting" ? t("chat.reconnecting") : t("chat.connecting")} />
    );

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: project.data?.name ?? "",
          headerRight: () =>
            timeline.previewUrl ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t("chat.preview")} hitSlop={12} onPress={actions.onOpenPreview} style={styles.headerBtn}>
                <Small style={{ color: colors.accent }}>{t("chat.preview")}</Small>
              </Pressable>
            ) : null,
        }}
      />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}>
        <View style={styles.status} accessibilityLiveRegion="polite">
          {conn}
        </View>
        <FlatList
          ref={listRef}
          data={timeline.items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={historyLoading ? <Loading label={t("common.loading")} /> : <Body style={styles.empty}>{t("chat.empty")}</Body>}
          renderItem={({ item }) => <TimelineItemView item={item} t={t} locale={locale} actions={actions} />}
        />
        {error ? (
          <View style={{ paddingHorizontal: space.lg }}>
            <ErrorBanner message={errorText(error, t)} />
          </View>
        ) : null}
        <View style={styles.composer}>
          {!awaiting ? (
            <View style={styles.planRow}>
              <Switch
                value={planMode}
                onValueChange={setPlanMode}
                accessibilityLabel={t("chat.planMode")}
                accessibilityHint={t("chat.planModeHint")}
                trackColor={{ true: colors.accent, false: colors.surface2 }}
                thumbColor={colors.text}
              />
              <Small>{t("chat.planMode")}</Small>
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={awaiting ? t("chat.answerPlaceholder") : t("chat.placeholder")}
              placeholderTextColor={colors.faint}
              accessibilityLabel={awaiting ? t("chat.answerPlaceholder") : t("chat.placeholder")}
              multiline
              maxLength={20000}
              style={styles.input}
              selectionColor={colors.accent}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chat.voice")}
              onPress={() => router.push({ pathname: "/project/[id]/voice", params: { id: projectId } })}
              style={({ pressed }) => [styles.mic, pressed && { opacity: 0.8 }]}
            >
              <MicIcon />
            </Pressable>
          </View>
          <Button
            label={createTask.isPending || answer.isPending ? t("chat.sending") : awaiting ? t("chat.answer") : t("chat.send")}
            onPress={send}
            disabled={!text.trim()}
            busy={createTask.isPending || answer.isPending}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  status: { paddingHorizontal: space.lg, paddingBottom: space.xs, flexDirection: "row" },
  list: { padding: space.lg, gap: space.md, flexGrow: 1 },
  empty: { color: colors.muted, paddingVertical: space.xl },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, padding: space.md, gap: space.sm, backgroundColor: colors.bg },
  planRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  input: {
    ...type.body,
    flex: 1,
    minHeight: MIN_TOUCH,
    maxHeight: 160,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  mic: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: MIN_TOUCH / 2, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  headerBtn: { paddingHorizontal: space.sm, minHeight: 44, justifyContent: "center" },
});
