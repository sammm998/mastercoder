import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { site } from "../src/lib/site";
import { colorsFor } from "../src/theme/tokens";

export default function RootLayout() {
  const colors = colorsFor(useColorScheme());
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          title: site.name,
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  );
}
