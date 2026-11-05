import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { usePreventRemove, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import { trpc } from "../../src/api";
import { PauseIcon, RecordDot, StopIcon } from "../../src/components/icons";
import { Body, Button, Caption, Card, Checkbox, Chip, Display, ErrorBanner, Field, Heading, Row, Screen, Small } from "../../src/components/ui";
import { useWorkspace } from "../../src/hooks/useWorkspace";
import { useI18n } from "../../src/i18n";
import { formatBytes, formatDuration } from "../../src/lib/format";
import { colors, space } from "../../src/theme";
import { useUploads } from "../../src/uploads";

const KEEP_AWAKE_TAG = "forge-meeting";

/** Speech-tuned AAC: mono, 96 kbps (~43 MB/hour), written to the document directory so the OS won't purge it. */
const OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 96_000 };

function mimeFor(uri: string, fallback: string): string {
  const ext = uri.split("?")[0]?.split(".").pop()?.toLowerCase();
  return ({ m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", webm: "audio/webm", wav: "audio/wav", "3gp": "audio/3gpp", caf: "audio/x-caf" } as Record<string, string>)[ext ?? ""] ?? fallback;
}

async function fileInfo(uri: string): Promise<{ size: number; mimeType: string }> {
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    return { size: blob.size, mimeType: blob.type || "audio/webm" };
  }
  const f = new File(uri);
  return { size: f.size, mimeType: mimeFor(uri, "audio/mp4") };
}

export default function RecordMeeting() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const ws = useWorkspace();
  const uploads = useUploads();
  const workspaceId = ws.current?.id ?? "";
  const projects = trpc.project.list.useQuery({ workspaceId }, { enabled: !!workspaceId });

  const [title, setTitle] = useState("");
  const [lang, setLang] = useState<"sv" | "en">(locale);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [started, setStarted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const savedRef = useRef(false);
  const [saved, setSaved] = useState(false);
  /** Navigation to run once the screen is no longer guarded (after the save re-render). */
  const afterSave = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (saved && afterSave.current) {
      const go = afterSave.current;
      afterSave.current = null;
      go();
    }
  }, [saved]);

  const recorder = useAudioRecorder(OPTIONS);
  const state = useAudioRecorderState(recorder, 500);
  const active = started && !saved;

  const start = async () => {
    setError(null);
    setPermissionDenied(false);
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) return setPermissionDenied(true);
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true, shouldPlayInBackground: true });
      await recorder.prepareToRecordAsync({ ...OPTIONS, directory: "document", fileName: `meeting-${Date.now()}` });
      recorder.record();
      setStarted(true);
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    } catch (e) {
      setError(t("record.failedToStart", { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const stopAndSave = useCallback(async (): Promise<boolean> => {
    if (savedRef.current) return true;
    setSaving(true);
    try {
      const durationMs = recorder.getStatus().durationMillis;
      await recorder.stop();
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      const uri = recorder.uri;
      if (!uri) throw new Error("no recording file");
      const info = await fileInfo(uri);
      await uploads.saveRecording({
        fileUri: uri,
        totalSize: info.size,
        mimeType: info.mimeType,
        workspaceId,
        projectId: projectId ?? undefined,
        title: title.trim() || t("record.title"),
        language: lang,
        durationMs,
      });
      savedRef.current = true;
      setSaved(true);
      return true;
    } catch (e) {
      setError(t("record.saveFailed", { message: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      setSaving(false);
    }
  }, [recorder, uploads, workspaceId, projectId, title, lang, t]);

  usePreventRemove(active, ({ repeat }) => {
    Alert.alert(t("record.leaveTitle"), t("record.leaveBody"), [
      { text: t("record.keepRecording"), style: "cancel" },
      {
        text: t("record.stopAndLeave"),
        style: "destructive",
        onPress: () => {
          afterSave.current = repeat;
          void stopAndSave().then((ok) => {
            if (!ok) afterSave.current = null;
          });
        },
      },
    ]);
  });

  const finish = async () => {
    afterSave.current = () => router.replace("/meetings");
    if (!(await stopAndSave())) afterSave.current = null;
  };

  if (!started)
    return (
      <Screen>
        <Card accent="warning">
          <Heading>{t("record.consentTitle")}</Heading>
          <Body>{t("record.consentBody")}</Body>
          <Checkbox label={t("record.consentCheck")} checked={consent} onChange={setConsent} />
        </Card>
        <Field label={t("record.meetingTitle")} value={title} onChangeText={setTitle} placeholder={t("record.meetingTitlePlaceholder")} maxLength={200} />
        <View style={{ gap: space.sm }}>
          <Caption>{t("record.language")}</Caption>
          <Row>
            <Chip label={t("settings.swedish")} selected={lang === "sv"} onPress={() => setLang("sv")} />
            <Chip label={t("settings.english")} selected={lang === "en"} onPress={() => setLang("en")} />
          </Row>
        </View>
        <View style={{ gap: space.sm }}>
          <Caption>
            {t("record.project")} ({t("common.optional")})
          </Caption>
          <Row>
            <Chip label={t("record.noProject")} selected={projectId === null} onPress={() => setProjectId(null)} />
            {(projects.data ?? []).map((p) => (
              <Chip key={p.id} label={p.name} selected={projectId === p.id} onPress={() => setProjectId(p.id)} />
            ))}
          </Row>
        </View>
        {permissionDenied ? (
          <>
            <ErrorBanner message={t("record.permissionDenied")} />
            <Button label={t("voice.openSettings")} variant="secondary" onPress={() => void Linking.openSettings()} />
          </>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <Button label={t("record.start")} onPress={() => void start()} disabled={!consent || !workspaceId} icon={<RecordDot color={colors.onAccent} />} />
      </Screen>
    );

  const recording = state.isRecording;
  return (
    <Screen>
      <View style={styles.center} accessible accessibilityLabel={`${recording ? t("record.recording") : t("record.paused")}, ${formatDuration(state.durationMillis)}`}>
        <Row>
          <RecordDot color={recording ? colors.danger : colors.faint} size={18} />
          <Caption style={{ color: recording ? colors.danger : colors.muted }}>{recording ? t("record.recording") : t("record.paused")}</Caption>
        </Row>
        <Display style={styles.timer}>{formatDuration(state.durationMillis)}</Display>
        {state.fileSize ? <Small>{t("record.size", { size: formatBytes(state.fileSize, locale) })}</Small> : null}
      </View>
      <Small style={{ textAlign: "center" }}>{t("record.keepOpen")}</Small>
      {error ? <ErrorBanner message={error} /> : null}
      <Row style={{ justifyContent: "center" }} gap={space.xl}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recording ? t("record.pause") : t("record.resume")}
          onPress={() => (recording ? recorder.pause() : recorder.record())}
          disabled={saving}
          style={({ pressed }) => [styles.round, pressed && { opacity: 0.8 }]}
        >
          {recording ? <PauseIcon size={30} /> : <RecordDot size={30} />}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("record.stop")}
          accessibilityState={{ busy: saving }}
          onPress={() => void finish()}
          disabled={saving}
          style={({ pressed }) => [styles.round, styles.stop, pressed && { opacity: 0.8 }]}
        >
          <StopIcon size={30} color={colors.onAccent} />
        </Pressable>
      </Row>
      <Button label={t("record.stop")} onPress={() => void finish()} busy={saving} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: space.sm, paddingTop: space.xxl },
  timer: { fontSize: 64, lineHeight: 72, fontVariant: ["tabular-nums"] },
  round: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  stop: { backgroundColor: colors.accent, borderColor: colors.accent },
});
