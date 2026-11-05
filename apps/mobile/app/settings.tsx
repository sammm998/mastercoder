import Constants from "expo-constants";
import { trpc, useSession } from "../src/api";
import { Body, Button, Caption, Card, Chip, Mono, Row, Screen, Small } from "../src/components/ui";
import { API_URL } from "../src/config";
import { useI18n } from "../src/i18n";

export default function Settings() {
  const { t, pref, setPref } = useI18n();
  const session = useSession();
  const me = trpc.auth.me.useQuery();
  return (
    <Screen>
      <Card>
        <Caption>{t("settings.language")}</Caption>
        <Row>
          <Chip label={t("settings.system")} selected={pref === "system"} onPress={() => setPref("system")} />
          <Chip label={t("settings.swedish")} selected={pref === "sv"} onPress={() => setPref("sv")} />
          <Chip label={t("settings.english")} selected={pref === "en"} onPress={() => setPref("en")} />
        </Row>
      </Card>
      <Card>
        <Caption>{t("settings.account")}</Caption>
        {me.data ? <Body>{t("settings.signedInAs", { email: me.data.email })}</Body> : null}
        <Button label={t("settings.signOut")} variant="danger" onPress={() => void session.signOut()} />
      </Card>
      <Card>
        <Caption>{t("settings.server")}</Caption>
        <Mono>{API_URL}</Mono>
        <Small>{t("settings.version", { version: Constants.expoConfig?.version ?? "0.1.0" })}</Small>
      </Card>
    </Screen>
  );
}
