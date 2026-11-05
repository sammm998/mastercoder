import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { CHROME_MAX_SCALE, MIN_TOUCH, colors, radius, space, type } from "../theme";

export function Screen({ children, scroll = true, edges = ["bottom"], contentStyle }: { children: ReactNode; scroll?: boolean; edges?: Edge[]; contentStyle?: StyleProp<ViewStyle> }) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView contentContainerStyle={[styles.content, contentStyle]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

type TextProps = { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number; accessibilityLabel?: string; selectable?: boolean; accessibilityLiveRegion?: "none" | "polite" | "assertive" };

export function Display(p: TextProps) {
  return (
    <Text accessibilityRole="header" style={[type.display, p.style]} numberOfLines={p.numberOfLines}>
      {p.children}
    </Text>
  );
}
export function Title(p: TextProps) {
  return (
    <Text accessibilityRole="header" style={[type.title, p.style]} numberOfLines={p.numberOfLines}>
      {p.children}
    </Text>
  );
}
export function Heading(p: TextProps) {
  return (
    <Text accessibilityRole="header" style={[type.heading, p.style]} numberOfLines={p.numberOfLines}>
      {p.children}
    </Text>
  );
}
export function Body(p: TextProps) {
  return (
    <Text style={[type.body, p.style]} numberOfLines={p.numberOfLines} accessibilityLabel={p.accessibilityLabel} selectable={p.selectable} accessibilityLiveRegion={p.accessibilityLiveRegion}>
      {p.children}
    </Text>
  );
}
export function Small(p: TextProps) {
  return (
    <Text style={[type.small, p.style]} numberOfLines={p.numberOfLines} accessibilityLabel={p.accessibilityLabel} selectable={p.selectable} accessibilityLiveRegion={p.accessibilityLiveRegion}>
      {p.children}
    </Text>
  );
}
export function Caption(p: TextProps) {
  return (
    <Text style={[type.caption, p.style]} maxFontSizeMultiplier={CHROME_MAX_SCALE} numberOfLines={p.numberOfLines}>
      {p.children}
    </Text>
  );
}
export function Mono(p: TextProps) {
  return (
    <Text style={[type.mono, p.style]} selectable numberOfLines={p.numberOfLines}>
      {p.children}
    </Text>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  icon,
  accessibilityLabel,
  accessibilityHint,
  style,
  compact,
}: {
  label: string;
  onPress: PressableProps["onPress"];
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={compact ? 8 : 0}
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, variantStyle[variant], pressed && !inactive && styles.pressed, inactive && styles.disabled, style]}
    >
      {busy ? <ActivityIndicator color={variant === "primary" ? colors.onAccent : colors.text} /> : icon}
      <Text style={[styles.buttonText, variant === "primary" && { color: colors.onAccent }, variant === "danger" && { color: colors.danger }]} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        {label}
      </Text>
    </Pressable>
  );
}

const variantStyle: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.surface2, borderColor: colors.borderStrong },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  danger: { backgroundColor: colors.dangerWash, borderColor: colors.danger },
};

export function Field({ label, error, hint, style, ...rest }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={colors.faint}
        selectionColor={colors.accent}
        style={[styles.input, error ? { borderColor: colors.danger } : null, style]}
        {...rest}
      />
      {hint && !error ? <Small>{hint}</Small> : null}
      {error ? (
        <Text style={[type.small, { color: colors.danger }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Card({ children, style, accent }: { children: ReactNode; style?: StyleProp<ViewStyle>; accent?: "accent" | "success" | "danger" | "warning" }) {
  const accentColor = accent ? { accent: colors.accent, success: colors.success, danger: colors.danger, warning: colors.warning }[accent] : null;
  return <View style={[styles.card, accentColor ? { borderLeftColor: accentColor, borderLeftWidth: 3 } : null, style]}>{children}</View>;
}

export function Chip({ label, selected, onPress, accessibilityLabel }: { label: string; selected?: boolean; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, selected && { color: colors.onAccent }]} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={label} onPress={() => onChange(!checked)} style={styles.checkRow}>
      <View style={[styles.checkBox, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>{checked ? <Text style={styles.checkMark}>✓</Text> : null}</View>
      <Body style={styles.flex}>{label}</Body>
    </Pressable>
  );
}

export function ProgressBar({ value, label, tone = "accent" }: { value: number | null; label: string; tone?: "accent" | "success" }) {
  const v = value === null ? null : Math.max(0, Math.min(1, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={v === null ? { text: label } : { min: 0, max: 100, now: Math.round(v * 100) }}
      style={styles.track}
    >
      <View style={[styles.bar, { width: `${Math.round((v ?? 0.15) * 100)}%`, backgroundColor: tone === "success" ? colors.success : colors.accent }, v === null && { opacity: 0.5 }]} />
    </View>
  );
}

export function Pill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "accent" | "success" | "danger" | "warning" }) {
  const map = {
    neutral: [colors.surface2, colors.muted],
    accent: [colors.accentWash, colors.accent],
    success: [colors.successWash, colors.success],
    danger: [colors.dangerWash, colors.danger],
    warning: [colors.warningWash, colors.warning],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <Text style={[styles.pillText, { color: fg }]} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        {label}
      </Text>
    </View>
  );
}

export function ErrorBanner({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <View style={styles.errorBanner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Body style={{ color: colors.text }}>{message}</Body>
      {onRetry && retryLabel ? <Button label={retryLabel} onPress={onRetry} variant="secondary" compact /> : null}
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.accent} />
      <Small>{label}</Small>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Row({ children, style, gap = space.sm }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxxl },
  button: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  buttonCompact: { minHeight: 40, paddingVertical: space.sm, paddingHorizontal: space.md },
  buttonText: { ...type.heading, fontSize: 16, color: colors.text, textAlign: "center" },
  pressed: { opacity: 0.8, transform: [{ scale: 0.99 }] },
  disabled: { opacity: 0.45 },
  field: { gap: space.xs },
  fieldLabel: { ...type.small, color: colors.text, fontWeight: "600" },
  input: {
    ...type.body,
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  chip: { minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, justifyContent: "center", backgroundColor: colors.surface },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { ...type.small, color: colors.text, fontWeight: "600" },
  checkRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: MIN_TOUCH },
  checkBox: { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkMark: { color: colors.onAccent, fontWeight: "800", fontSize: 16 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" },
  bar: { height: 6, borderRadius: 3 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 13, fontWeight: "600" },
  errorBanner: { backgroundColor: colors.dangerWash, borderColor: colors.danger, borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
  loading: { alignItems: "center", gap: space.sm, padding: space.xl },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
});
