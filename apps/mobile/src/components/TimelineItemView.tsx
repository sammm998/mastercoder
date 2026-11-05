import { memo } from "react";
import { Linking, StyleSheet, View } from "react-native";
import type { TimelineItem } from "../lib/events";
import { formatUsd, formatUsdRange } from "../lib/format";
import type { Locale, TFunction, TKey } from "../lib/i18n";
import { colors, radius, space } from "../theme";
import { Body, Button, Caption, Card, Chip, Mono, Pill, ProgressBar, Row, Small } from "./ui";

const PHASES = new Set(["plan", "design", "build", "verify", "review", "finish", "media", "slides", "agent", "meeting", "job"]);

export interface TimelineActions {
  onAnswer(option: string): void;
  onApprovePlan(taskId: string): void;
  onOpenPreview(): void;
  approvingTaskId: string | null;
  canAnswer: boolean;
}

function phaseLabel(t: TFunction, phase: string): string {
  return PHASES.has(phase) ? t(`chat.phase.${phase}` as TKey) : phase;
}

/** One entry in the project chat. Every row carries a spoken label so VoiceOver/TalkBack read it as a unit. */
export const TimelineItemView = memo(function TimelineItemView({ item, t, locale, actions }: { item: TimelineItem; t: TFunction; locale: Locale; actions: TimelineActions }) {
  switch (item.kind) {
    case "user":
      return (
        <View style={[styles.bubble, styles.user, item.pending && { opacity: 0.7 }]} accessible accessibilityLabel={`${t("chat.you")}${item.source === "voice" ? ` (${t("chat.voiceTag")})` : ""}: ${item.text}`}>
          {item.source === "voice" ? <Caption style={{ color: colors.onAccent }}>{t("chat.voiceTag")}</Caption> : null}
          <Body style={{ color: colors.onAccent }} selectable>
            {item.text}
          </Body>
        </View>
      );
    case "message":
      return (
        <View style={[styles.bubble, styles.assistant]} accessible accessibilityLabel={`${item.role === "assistant" ? t("chat.forge") : t("chat.system")}: ${item.text}`}>
          <Caption>{item.role === "assistant" ? t("chat.forge") : t("chat.system")}</Caption>
          <Body selectable>{item.text}</Body>
        </View>
      );
    case "intents":
      return (
        <View style={styles.meta} accessible accessibilityLabel={`${t("chat.intents")}: ${item.intents.map((i) => i.summary).join(", ")}`}>
          <Caption>{t("chat.intents")}</Caption>
          <Row>
            {item.intents.map((i, idx) => (
              <Pill key={`${i.kind}-${idx}`} tone="accent" label={`${i.kind} · ${i.summary}`} />
            ))}
          </Row>
        </View>
      );
    case "estimate": {
      const range = formatUsdRange(item.lowUsd, item.highUsd, locale);
      return (
        <View style={styles.meta} accessible accessibilityLabel={`${t("chat.estimate")}: ${range}`}>
          <Caption>{t("chat.estimate")}</Caption>
          <Body style={styles.money}>{t("chat.estimateRange", { range })}</Body>
          {item.breakdown.length ? <Small>{item.breakdown.map((b) => `${b.label} ${formatUsd(b.usd, locale)}`).join(" · ")}</Small> : null}
        </View>
      );
    }
    case "question":
      return (
        <Card accent="accent">
          <Caption style={{ color: colors.accent }}>{item.answered ? t("chat.answered") : t("chat.question")}</Caption>
          <Body>{item.question}</Body>
          {!item.answered && item.options.length ? (
            <Row>
              {item.options.map((o) => (
                <Chip key={o} label={o} onPress={() => actions.canAnswer && actions.onAnswer(o)} />
              ))}
            </Row>
          ) : null}
        </Card>
      );
    case "progress": {
      const label = `${phaseLabel(t, item.phase)}${item.label ? ` · ${item.label}` : ""}`;
      return (
        <View style={styles.meta} accessible accessibilityLabel={item.done ? `${label}: ${t("chat.done")}` : label}>
          <Row style={{ justifyContent: "space-between" }}>
            <Small style={{ color: item.done ? colors.muted : colors.text }}>{label}</Small>
            {item.done ? <Small style={{ color: colors.success }}>✓ {t("chat.done")}</Small> : null}
          </Row>
          {!item.done ? <ProgressBar value={item.progress ?? null} label={label} /> : null}
        </View>
      );
    }
    case "plan":
      return (
        <Card accent="warning">
          <Caption style={{ color: colors.warning }}>{t("chat.plan")}</Caption>
          <Mono numberOfLines={12}>{summariseSpec(item.spec)}</Mono>
          {item.requiresApproval && item.taskId ? (
            <Button label={t("chat.approvePlan")} onPress={() => actions.onApprovePlan(item.taskId as string)} busy={actions.approvingTaskId === item.taskId} />
          ) : null}
        </Card>
      );
    case "checkpoint":
      return (
        <View style={styles.meta} accessible accessibilityLabel={t("chat.checkpoint", { label: item.label })}>
          <Small>◆ {t("chat.checkpoint", { label: item.label })}</Small>
          <Mono>{item.commit.slice(0, 10)}</Mono>
        </View>
      );
    case "artifact":
      return (
        <Card>
          <Caption>{t("chat.artifact", { kind: item.artifactKind })}</Caption>
          <Button label={t("chat.openArtifact", { kind: item.artifactKind })} variant="secondary" onPress={() => void Linking.openURL(item.url)} />
        </Card>
      );
    case "approval":
      return (
        <Card accent="warning">
          <Caption style={{ color: colors.warning }}>{t("chat.approval", { action: item.action })}</Caption>
          <Small>{t("chat.approvalHint")}</Small>
        </Card>
      );
    case "gate":
      return (
        <View style={styles.meta} accessible accessibilityLabel={item.passed ? t("chat.gatePassed", { gate: item.gate }) : `${t("chat.gateFailed", { gate: item.gate })}: ${item.details}`}>
          <Small style={{ color: item.passed ? colors.success : colors.danger }}>
            {item.passed ? "✓" : "✕"} {item.passed ? t("chat.gatePassed", { gate: item.gate }) : t("chat.gateFailed", { gate: item.gate })}
          </Small>
          {!item.passed ? <Small numberOfLines={4}>{item.details}</Small> : null}
        </View>
      );
    case "result":
      return (
        <Card accent="success">
          <Caption style={{ color: colors.success }}>{t("chat.result")}</Caption>
          <Body selectable>{item.summary}</Body>
          <Small>{t("chat.charged", { amount: formatUsd(item.chargedUsd, locale) })}</Small>
        </Card>
      );
    case "failure":
      return (
        <Card accent="danger">
          <Caption style={{ color: colors.danger }}>{t("chat.failed")}</Caption>
          <Body selectable>{item.reason}</Body>
          {!item.charged ? <Small>{t("chat.notCharged")}</Small> : null}
        </Card>
      );
    case "preview":
      return (
        <Card accent="accent">
          <Caption style={{ color: colors.accent }}>{t("chat.previewReady")}</Caption>
          <Mono numberOfLines={1}>{item.url}</Mono>
          <Button label={t("chat.openPreview")} onPress={actions.onOpenPreview} />
        </Card>
      );
    case "deploy":
      return (
        <View style={styles.meta}>
          <Small>{t("chat.deploy", { status: item.status })}</Small>
          {item.url ? <Mono>{item.url}</Mono> : null}
        </View>
      );
  }
});

function summariseSpec(spec: unknown): string {
  if (typeof spec === "string") return spec;
  try {
    return JSON.stringify(spec, null, 2).slice(0, 1500);
  } catch {
    return String(spec);
  }
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.lg, padding: space.md, gap: space.xs, maxWidth: "88%" },
  user: { alignSelf: "flex-end", backgroundColor: colors.accent, borderBottomRightRadius: radius.sm },
  assistant: { alignSelf: "flex-start", backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderBottomLeftRadius: radius.sm },
  meta: { gap: space.xs, paddingHorizontal: space.xs },
  money: { fontVariant: ["tabular-nums"] },
});
