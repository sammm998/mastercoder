import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { initKit } from "../src/kit";
import { site } from "../src/lib/site";
import { colorsFor } from "../src/theme/tokens";

initKit();

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
