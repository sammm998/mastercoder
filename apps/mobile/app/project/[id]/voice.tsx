import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream, type AudioStreamBuffer } from "expo-audio";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, TextInput, View } from "react-native";
import { errorText, trpc, useSession } from "../../../src/api";
import { MicIcon, StopIcon } from "../../../src/components/icons";
import { Body, Button, Caption, Chip, ErrorBanner, ProgressBar, Row, Screen, Small, Title } from "../../../src/components/ui";
import { API_URL } from "../../../src/config";
import { useI18n } from "../../../src/i18n";
import { AudioStreamSession, emptyTranscript, parseAudioServerMessage, peakLevel, reduceTranscript, transcriptText, type TranscriptState } from "../../../src/lib/audio-protocol";
import { formatDuration } from "../../../src/lib/format";
import { audioUrl } from "../../../src/lib/ws";
import { colors, radius, space, type } from "../../../src/theme";

type Phase = "idle" | "connecting" | "listening" | "finishing" | "done";

/**
 * Voice prompt: 16 kHz mono int16 PCM from expo-audio's useAudioStream is streamed over /ws/audio/:projectId
 * and the transcript appears while speaking. The (editable) transcript is sent as a task with source "voice".
 */
export default function VoicePrompt() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = String(id ?? "");
  const router = useRouter();
  const { t, locale } = useI18n();
  const session = useSession();
  const [lang, setLang] = useState<"sv" | "en">(locale);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [edited, setEdited] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState<"permission" | "unavailable" | { message: string } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<AudioStreamSession | null>(null);
  const startedAt = useRef(0);
  const lastLevelAt = useRef(0);
  const stopping = useRef(false);

  const onBuffer = useCallback((b: AudioStreamBuffer) => {
    sessionRef.current?.push(b.data, { sampleRate: b.sampleRate, channels: b.channels });
    const now = Date.now();
    if (now - lastLevelAt.current > 120) {
      lastLevelAt.current = now;
      setLevel(peakLevel(b.data));
    }
  }, []);
  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: "int16", onBuffer });

  const createTask = trpc.task.create.useMutation({ onSuccess: () => router.back() });

  useEffect(() => {
    if (phase !== "listening") return;
    const h = setInterval(() => setElapsed(Date.now() - startedAt.current), 500);
    return () => clearInterval(h);
  }, [phase]);

  const closeSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= 1) ws.close(1000, "done");
  }, []);

  useEffect(
    () => () => {
      try {
        stream.stop();
      } catch {
        /* not started */
      }
      closeSocket();
    },
    [stream, closeSocket],
  );

  const start = useCallback(async () => {
    setProblem(null);
    setTranscript(emptyTranscript);
    setEdited(null);
    stopping.current = false;
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return setProblem("permission");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

    setPhase("connecting");
    const ws = new WebSocket(audioUrl(API_URL, projectId, lang, session.getToken()));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const audio = new AudioStreamSession({ isOpen: () => ws.readyState === 1, send: (d) => ws.send(d) }, lang);
    sessionRef.current = audio;
    ws.onopen = () => {
      audio.flush();
      setPhase((p) => (p === "connecting" ? "listening" : p));
    };
    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (typeof ev.data !== "string") return;
      const m = parseAudioServerMessage(ev.data);
      if (!m) return;
      if (m.type === "error") setProblem({ message: m.message });
      else if (m.type === "done") {
        setPhase("done");
        closeSocket();
      } else {
        setTranscript((s) => reduceTranscript(s, m));
        if (m.isFinal && stopping.current) {
          setPhase("done");
          closeSocket();
        }
      }
    };
    ws.onclose = (ev: WebSocketCloseEvent) => {
      if (ev.code === 4501) setProblem("unavailable");
      else if (!stopping.current && ev.code !== 1000) setProblem({ message: ev.reason || `code ${ev.code ?? "?"}` });
      try {
        stream.stop();
      } catch {
        /* already stopped */
      }
      setPhase((p) => (p === "idle" ? p : "done"));
    };

    try {
      await stream.start();
      startedAt.current = Date.now();
      setElapsed(0);
    } catch (e) {
      closeSocket();
      setPhase("idle");
      setProblem({ message: e instanceof Error ? e.message : String(e) });
    }
  }, [lang, projectId, session, stream, closeSocket]);

  const stop = useCallback(() => {
    stopping.current = true;
    try {
      stream.stop();
    } catch {
      /* already stopped */
    }
    sessionRef.current?.stop();
    setLevel(0);
    setPhase("finishing");
    // Wait briefly for the final transcript, then close.
    setTimeout(() => {
      if (wsRef.current) {
        closeSocket();
        setPhase("done");
      }
    }, 4000);
  }, [stream, closeSocket]);

  const live = transcriptText(transcript);
  const text = edited ?? live;
  const recording = phase === "connecting" || phase === "listening";

  return (
    <Screen>
      <Title>{t("voice.title")}</Title>
      <Small>{t("voice.lead")}</Small>

      <View style={{ gap: space.sm }}>
        <Caption>{t("voice.language")}</Caption>
        <Row>
          <Chip label={t("settings.swedish")} selected={lang === "sv"} onPress={() => !recording && setLang("sv")} />
          <Chip label={t("settings.english")} selected={lang === "en"} onPress={() => !recording && setLang("en")} />
        </Row>
      </View>

      <View style={styles.center}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recording ? t("voice.stop") : t("voice.start")}
          accessibilityState={{ busy: phase === "finishing" }}
          onPress={recording ? stop : () => void start()}
          disabled={phase === "finishing"}
          style={({ pressed }) => [styles.recordBtn, recording && styles.recordBtnActive, pressed && { transform: [{ scale: 0.97 }] }]}
        >
          {recording ? <StopIcon size={36} color={colors.onAccent} /> : <MicIcon size={40} color={colors.onAccent} />}
        </Pressable>
        <Body accessibilityLiveRegion="polite" style={{ color: colors.muted }}>
          {phase === "connecting" ? t("voice.connecting") : phase === "listening" ? t("voice.listening") : recording ? "" : " "}
        </Body>
        {recording ? (
          <View style={styles.meter}>
            <ProgressBar value={level} label={t("voice.level")} />
            <Small accessibilityLabel={`${t("voice.elapsed")} ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</Small>
          </View>
        ) : null}
      </View>

      {problem === "permission" ? (
        <>
          <ErrorBanner message={t("voice.permissionDenied")} />
          <Button label={t("voice.openSettings")} variant="secondary" onPress={() => void Linking.openSettings()} />
        </>
      ) : problem === "unavailable" ? (
        <ErrorBanner message={t("voice.unavailable")} />
      ) : problem ? (
        <ErrorBanner message={t("voice.failed", { message: problem.message })} />
      ) : null}

      <View style={{ gap: space.sm }}>
        <Caption>{t("voice.transcript")}</Caption>
        <TextInput
          value={text}
          onChangeText={setEdited}
          editable={!recording}
          multiline
          placeholder={t("voice.transcriptPlaceholder")}
          placeholderTextColor={colors.faint}
          accessibilityLabel={t("voice.transcript")}
          accessibilityLiveRegion="polite"
          style={styles.transcript}
          selectionColor={colors.accent}
        />
      </View>

      {createTask.error ? <ErrorBanner message={errorText(createTask.error, t)} /> : null}
      <Button
        label={createTask.isPending ? t("voice.sending") : t("voice.send")}
        onPress={() => createTask.mutate({ projectId, prompt: text.trim(), source: "voice", planMode: false })}
        disabled={!text.trim() || recording || phase === "finishing"}
        busy={createTask.isPending}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: space.md, paddingVertical: space.xl },
  recordBtn: { width: 120, height: 120, borderRadius: 60, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  recordBtnActive: { backgroundColor: colors.danger },
  meter: { alignSelf: "stretch", gap: space.xs, alignItems: "center" },
  transcript: {
    ...type.body,
    minHeight: 140,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    textAlignVertical: "top",
  },
});
