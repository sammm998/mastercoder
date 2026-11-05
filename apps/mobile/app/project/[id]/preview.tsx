import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { trpc } from "../../../src/api";
import { QrCode } from "../../../src/components/QrCode";
import { WebPreview } from "../../../src/components/WebPreview";
import { Body, Button, Card, ErrorBanner, Heading, Loading, Mono, Row, Screen, Small } from "../../../src/components/ui";
import { useProjectTimeline } from "../../../src/hooks/useProjectTimeline";
import { useI18n } from "../../../src/i18n";
import { classifyPreview } from "../../../src/lib/preview";
import { colors, space } from "../../../src/theme";

/** Expo projects: QR + "Open in Expo Go" (exp:// from preview.ready). Web projects: in-app WebView. */
export default function Preview() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = String(id ?? "");
  const { t } = useI18n();
  const project = trpc.project.get.useQuery({ projectId }, { enabled: !!projectId });
  const { timeline, historyLoading } = useProjectTimeline(projectId);
  const [reloadKey, setReloadKey] = useState(0);
  const [expoGoMissing, setExpoGoMissing] = useState(false);
  const target = classifyPreview(timeline.previewUrl, project.data?.template);

  if (historyLoading || project.isLoading)
    return (
      <Screen>
        <Loading label={t("common.loading")} />
      </Screen>
    );

  if (!target)
    return (
      <Screen>
        <Body style={{ color: colors.muted }}>{t("preview.none")}</Body>
      </Screen>
    );

  if (target.kind === "expo") {
    const openExpoGo = async () => {
      setExpoGoMissing(false);
      try {
        await Linking.openURL(target.expoUrl);
      } catch {
        setExpoGoMissing(true);
      }
    };
    return (
      <Screen>
        <Card>
          <Heading>{t("preview.expoTitle")}</Heading>
          <Small>{t("preview.expoLead")}</Small>
          <View style={styles.qr}>
            <QrCode value={target.expoUrl} label={t("preview.qrLabel", { url: target.expoUrl })} size={260} />
          </View>
          <Mono selectable>{target.expoUrl}</Mono>
          <Button label={t("preview.openExpoGo")} onPress={() => void openExpoGo()} />
          {expoGoMissing ? <ErrorBanner message={t("preview.noExpoGo")} /> : null}
        </Card>
      </Screen>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <View style={styles.bar}>
        <Mono numberOfLines={1} style={styles.flex}>
          {target.url}
        </Mono>
        <Row>
          <Button label={t("preview.reload")} variant="secondary" compact onPress={() => setReloadKey((k) => k + 1)} />
          <Button label={t("preview.openBrowser")} variant="ghost" compact onPress={() => void Linking.openURL(target.url)} />
        </Row>
      </View>
      <View style={styles.web}>
        <WebPreview url={target.url} reloadKey={reloadKey} labels={{ loading: t("common.loading"), blocked: t("preview.blocked"), failed: t("preview.loadFailed") }} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  qr: { alignItems: "center", paddingVertical: space.md },
  bar: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  web: { flex: 1, paddingHorizontal: space.sm, paddingBottom: space.sm },
});
