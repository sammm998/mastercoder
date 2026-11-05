import { useEffect, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from "react-native";
import { site } from "../src/lib/site";
import { useReducedMotion } from "../src/lib/motion";
import { colorsFor, duration, fontSize, radius, space } from "../src/theme/tokens";

export default function HomeScreen() {
  const colors = colorsFor(useColorScheme());
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: reduced ? 0 : duration.slow, useNativeDriver: true }).start();
  }, [opacity, reduced]);

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: colors.bg }]}>
      <Animated.View style={{ opacity }}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {site.name}
        </Text>
        <Text style={[styles.lead, { color: colors.muted }]}>{site.description}</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Shows how to edit this screen"
            style={({ pressed }) => [styles.button, { backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={[styles.buttonText, { color: colors.accentContrast }]}>Get started</Text>
          </Pressable>
        </View>
        <Text style={[styles.body, { color: colors.text }]}>
          Edit app/index.tsx to change this screen. Colours and spacing come from src/theme/tokens.ts.
        </Text>
      </Animated.View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: space[6], paddingTop: space[12] },
  title: { fontSize: fontSize.h1, fontWeight: "700", marginBottom: space[4] },
  lead: { fontSize: fontSize.lead, marginBottom: space[8] },
  actions: { flexDirection: "row", marginBottom: space[8] },
  button: { minHeight: 48, paddingHorizontal: space[6], borderRadius: radius.full, justifyContent: "center" },
  buttonText: { fontSize: fontSize.body, fontWeight: "600" },
  body: { fontSize: fontSize.body, lineHeight: 24 },
});
