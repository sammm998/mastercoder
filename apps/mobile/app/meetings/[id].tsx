import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { errorText, trpc } from "../../src/api";
import { Body, Button, Caption, Card, Chip, ErrorBanner, Field, Heading, Loading, Mono, Pill, Row, Screen, Small, Title } from "../../src/components/ui";
import { useI18n } from "../../src/i18n";
import { meetingView } from "../../src/lib/meeting";
import { colors, space } from "../../src/theme";
import { statusLabel } from "../../src/components/meetingStatus";

const POLL_STATUSES = new Set(["scheduled", "joining", "recording", "processing"]);

export default function MeetingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const meetingId = String(id ?? "");
  const router = useRouter();
  const { t, locale } = useI18n();
  const meeting = trpc.meetings.get.useQuery({ meetingId }, { enabled: !!meetingId, refetchInterval: (q) => (q.state.data && POLL_STATUSES.has(q.state.data.status) ? 5000 : false) });
  const m = meeting.data;
  const projects = trpc.project.list.useQuery({ workspaceId: m?.workspaceId ?? "" }, { enabled: !!m?.workspaceId });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (m?.projectId && projectId === null) setProjectId(m.projectId);
  }, [m?.projectId, projectId]);

  const approve = trpc.meetings.approveSpec.useMutation({
    onSuccess: (_r, vars) => router.replace({ pathname: "/project/[id]", params: { id: vars.projectId } }),
  });
  const del = trpc.meetings.delete.useMutation({
    onSuccess: async () => {
      await utils.meetings.list.invalidate();
      router.back();
    },
  });

  if (meeting.isLoading)
    return (
      <Screen>
        <Loading label={t("common.loading")} />
      </Screen>
    );
  if (meeting.error || !m)
    return (
      <Screen>
        <ErrorBanner message={errorText(meeting.error, t)} onRetry={() => void meeting.refetch()} retryLabel={t("common.retry")} />
      </Screen>
    );

  const v = meetingView(m);
  const buildPrompt = prompt ?? v.spec.buildPrompt ?? "";
  const dateFmt = new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", { dateStyle: "long", timeStyle: "short" });
  const nothing = !v.summary && !v.requirements.length && !v.decisions.length && !v.actionItems.length && !v.spec.raw;

  return (
    <Screen>
      <View style={{ gap: space.sm }}>
        <Title>{m.title ?? t("meeting.title")}</Title>
        <Row>
          <Pill tone={m.status === "ready" ? "success" : m.status === "failed" ? "danger" : "accent"} label={statusLabel(t, m.status)} />
          <Small>{dateFmt.format(new Date(m.createdAt))}</Small>
        </Row>
      </View>

      {POLL_STATUSES.has(m.status) ? <Card accent="accent"><Small accessibilityLiveRegion="polite">{t("meeting.processing")}</Small></Card> : null}
      {m.status === "failed" ? <ErrorBanner message={t("meeting.failed")} /> : null}
      {m.status === "ready" && nothing ? <Body style={{ color: colors.muted }}>{t("meeting.nothing")}</Body> : null}

      {v.summary ? (
        <Card>
          <Caption>{t("meeting.summary")}</Caption>
          <Body selectable>{v.summary}</Body>
        </Card>
      ) : null}

      {v.requirements.length ? (
        <Card>
          <Caption>{t("meeting.requirements")}</Caption>
          {v.requirements.map((r, i) => (
            <Row key={i} style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
              <Body style={{ color: colors.accent }}>•</Body>
              <Body style={{ flex: 1 }}>{r.text}</Body>
              {r.priority ? <Pill label={r.priority} /> : null}
            </Row>
          ))}
        </Card>
      ) : null}

      {v.decisions.length ? (
        <Card>
          <Caption>{t("meeting.decisions")}</Caption>
          {v.decisions.map((d, i) => (
            <Body key={i}>— {d}</Body>
          ))}
        </Card>
      ) : null}

      {v.actionItems.length ? (
        <Card>
          <Caption>{t("meeting.actionItems")}</Caption>
          {v.actionItems.map((a, i) => (
            <View key={i}>
              <Body>☐ {a.text}</Body>
              {a.owner ? <Small>{t("meeting.owner", { owner: a.owner })}</Small> : null}
            </View>
          ))}
        </Card>
      ) : null}

      {v.spec.raw ? (
        <Card accent="warning">
          <Caption>{t("meeting.spec")}</Caption>
          {v.spec.title ? <Heading>{v.spec.title}</Heading> : null}
          {v.spec.features.length ? (
            <>
              <Small>{t("meeting.features")}</Small>
              <Row>
                {v.spec.features.map((f) => (
                  <Pill key={f} label={f} />
                ))}
              </Row>
            </>
          ) : null}
          <Field label={t("meeting.buildPrompt")} hint={t("meeting.buildPromptHint")} value={buildPrompt} onChangeText={setPrompt} multiline style={{ minHeight: 120, textAlignVertical: "top" }} />
          <Button label={t("meeting.rawSpec")} variant="ghost" compact onPress={() => setShowRaw((s) => !s)} />
          {showRaw ? <Mono>{JSON.stringify(v.spec.raw, null, 2)}</Mono> : null}
        </Card>
      ) : null}

      {v.canApprove ? (
        <Card>
          <Heading>{t("meeting.chooseProject")}</Heading>
          <Small>{t("meeting.chooseProjectHint")}</Small>
          {projects.data && projects.data.length === 0 ? <Body style={{ color: colors.muted }}>{t("meeting.noProjects")}</Body> : null}
          <Row>
            {(projects.data ?? []).map((p) => (
              <Chip key={p.id} label={p.name} selected={projectId === p.id} onPress={() => setProjectId(p.id)} />
            ))}
          </Row>
          {approve.error ? <ErrorBanner message={errorText(approve.error, t)} /> : null}
          <Button
            label={approve.isPending ? t("meeting.approving") : t("meeting.approve")}
            busy={approve.isPending}
            disabled={!projectId}
            onPress={() => projectId && approve.mutate({ meetingId, projectId, prompt: buildPrompt.trim() || undefined })}
          />
        </Card>
      ) : null}

      {del.error ? <ErrorBanner message={errorText(del.error, t)} /> : null}
      <Button
        label={t("meeting.delete")}
        variant="danger"
        busy={del.isPending}
        onPress={() =>
          Alert.alert(t("meeting.delete"), t("meeting.deleteConfirm"), [
            { text: t("common.cancel"), style: "cancel" },
            { text: t("common.delete"), style: "destructive", onPress: () => del.mutate({ meetingId }) },
          ])
        }
      />
    </Screen>
  );
}
