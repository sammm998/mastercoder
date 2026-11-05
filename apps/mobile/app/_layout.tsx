import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiProvider, useSession } from "../src/api";
import { Loading, Screen } from "../src/components/ui";
import { I18nProvider, useT } from "../src/i18n";
import { colors, fonts } from "../src/theme";
import { UploadsProvider } from "../src/uploads";

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg, text: colors.text, border: colors.border, primary: colors.accent, notification: colors.accent },
};

function RootStack() {
  const session = useSession();
  const t = useT();
  if (session.status === "loading")
    return (
      <Screen scroll={false} contentStyle={{ justifyContent: "center" }}>
        <Loading label={t("common.loading")} />
      </Screen>
    );
  const signedIn = session.status === "signedIn";
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.display, color: colors.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" options={{ title: t("projects.title"), headerLargeTitle: true }} />
        <Stack.Screen name="project/[id]/index" options={{ title: "" }} />
        <Stack.Screen name="project/[id]/voice" options={{ title: t("voice.title"), presentation: "modal" }} />
        <Stack.Screen name="project/[id]/preview" options={{ title: t("preview.title") }} />
        <Stack.Screen name="meetings/index" options={{ title: t("meetings.title") }} />
        <Stack.Screen name="meetings/record" options={{ title: t("record.title") }} />
        <Stack.Screen name="meetings/[id]" options={{ title: t("meeting.title") }} />
        <Stack.Screen name="settings" options={{ title: t("settings.title") }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Screen name="auth/magic" options={{ title: t("signIn.title") }} />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.bg);
  }, []);
  return (
    <SafeAreaProvider>
      <ThemeProvider value={navTheme}>
        <I18nProvider>
          <ApiProvider>
            <UploadsProvider>
              <StatusBar style="light" />
              <RootStack />
            </UploadsProvider>
          </ApiProvider>
        </I18nProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
