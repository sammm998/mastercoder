import type { EntityModel } from "./model.js";
import { entityModels } from "./model.js";
import { detectRules, streakTest, streakTs, progressTest, progressTs, type DomainRules } from "./domain.js";
import { TS_HEADER, jsxText, q } from "./names.js";
import { formLibTs } from "./web-shared.js";
import { entityTests, entityTs, repositoryTs, storageTs } from "./gen-web-local.js";
import { ZOD_VERSION } from "./gen-nextjs-auth.js";
import { emptyProject, type GenerateContext, type GeneratedProject } from "./types.js";

/**
 * Expo (React Native) generator: typed, zod-validated logic modules shared with the web generators,
 * a home screen built only from the template's theme tokens, domain logic (streaks / progress) and
 * vitest logic tests. Persistence: localStorage on Expo web, in memory on native (stated in the UI).
 */

function inputTs(): string {
  return `${TS_HEADER}
import type { FieldKind } from "./form";

/** Typed values from text inputs and switches: blank → missing, numeric fields → number. */
export function valuesFromInputs(kinds: Record<string, FieldKind>, text: Record<string, string>, toggles: Record<string, boolean> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(kinds)) {
    if (kind === "boolean") {
      out[name] = toggles[name] === true;
      continue;
    }
    const raw = (text[name] ?? "").trim();
    if (raw === "") continue;
    out[name] = kind === "number" ? Number(raw.replace(",", ".")) : raw;
  }
  return out;
}
`;
}

function screenTsx(ctx: GenerateContext, models: EntityModel[], rules: DomainRules): string {
  const st = rules.streak;
  const main = st?.parent ?? models.find((m) => !m.fields.some((f) => f.type === "reference")) ?? models[0]!;
  const editable = main.fields.filter((f) => f.type !== "reference");
  const toggles = editable.filter((f) => f.type === "boolean");
  const texts = editable.filter((f) => f.type !== "boolean" && f.type !== "enum");
  const enums = editable.filter((f) => f.type === "enum");
  const progress = rules.progress.find((p) => p.entity.name === main.name);
  const title = main.displayField ?? main.fields[0]?.name ?? "id";
  const lines: string[] = [];
  lines.push(`${TS_HEADER}
import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, ${toggles.length ? "Switch, " : ""}Text, TextInput, useColorScheme, View } from "react-native";
${st ? `import { currentStreak, hasCheckIn, toIsoDate } from "../src/lib/domain/streak";\n` : ""}${progress ? `import { progressPercent } from "../src/lib/domain/progress";\n` : ""}import { valuesFromInputs } from "../src/lib/input";
import { ${main.camel}Fields, ${main.camel}Repository } from "../src/lib/${main.kebab}";
${st ? `import { ${st.entity.camel}Repository } from "../src/lib/${st.entity.kebab}";\n` : ""}import { site } from "../src/lib/site";
import { colorsFor, fontSize, radius, space } from "../src/theme/tokens";

const TEXT_FIELDS = [
${texts.map((f) => `  { name: ${q(f.name)}, label: ${q(f.label)}, numeric: ${f.kind === "number"}, required: ${f.required}${f.pattern ? `, hint: ${q(f.pattern.message)}` : ""} },`).join("\n")}
] as const;

export default function HomeScreen() {
  const colors = colorsFor(useColorScheme());
  const items = useSyncExternalStore(${main.camel}Repository.subscribe, ${main.camel}Repository.list, ${main.camel}Repository.serverList);
${st ? `  const checkIns = useSyncExternalStore(${st.entity.camel}Repository.subscribe, ${st.entity.camel}Repository.list, ${st.entity.camel}Repository.serverList);\n  const today = toIsoDate(new Date());\n` : ""}  const [text, setText] = useState<Record<string, string>>({});
${toggles.length ? "  const [toggles, setToggles] = useState<Record<string, boolean>>({});\n" : ""}${enums.length ? `  const [choices, setChoices] = useState<Record<string, string>>({ ${enums.map((f) => `${f.name}: ${q(f.enumValues[0] ?? "")}`).join(", ")} });\n` : ""}  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState("");

  function add() {
    const values = { ...valuesFromInputs(${main.camel}Fields, text${toggles.length ? ", toggles" : ""})${enums.length ? ", ...choices" : ""} };
    const result = ${main.camel}Repository.create(values);
    if (!result.ok) {
      setErrors(result.errors);
      setStatus("Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setText({});
    setStatus(${q(`${main.label} added.`)});
  }
${
  st
    ? `
  function checkIn(id: string) {
    const dates = checkIns.filter((c) => c.${st.parentField.name} === id).map((c) => c.${st.date.name});
    if (hasCheckIn(dates, today)) return;
    ${st.entity.camel}Repository.create({ ${st.parentField.name}: id, ${st.date.name}: today });
  }
`
    : ""
}
  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: colors.bg }]} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
        {site.name}
      </Text>
      <Text style={[styles.lead, { color: colors.muted }]}>${jsxText(ctx.spec.summary.slice(0, 160))}</Text>
      <Text style={[styles.note, { color: colors.muted }]}>Saved on this device only (browser storage on the web, memory on iOS/Android until the app restarts).</Text>

      <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text accessibilityRole="header" style={[styles.h2, { color: colors.text }]}>
          New ${jsxText(main.label.toLowerCase())}
        </Text>
        {TEXT_FIELDS.map((f) => (
          <View key={f.name} style={styles.field}>
            <Text nativeID={\`label-\${f.name}\`} style={{ color: colors.text }}>
              {f.label}
              {f.required ? " *" : ""}
            </Text>
            <TextInput
              accessibilityLabel={f.label}
              aria-labelledby={\`label-\${f.name}\`}
              value={text[f.name] ?? ""}
              onChangeText={(v) => setText((t) => ({ ...t, [f.name]: v }))}
              keyboardType={f.numeric ? "numeric" : "default"}
              placeholder={"hint" in f ? f.hint : undefined}
              placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.text, borderColor: errors[f.name] ? colors.accent : colors.border }]}
            />
            {errors[f.name] ? (
              <Text accessibilityLiveRegion="polite" style={{ color: colors.accent }}>
                {errors[f.name]?.join(" ")}
              </Text>
            ) : null}
          </View>
        ))}
${toggles
  .map(
    (f) => `        <View style={[styles.field, styles.row]}>
          <Switch accessibilityLabel=${q(f.label)} value={toggles[${q(f.name)}] === true} onValueChange={(v) => setToggles((t) => ({ ...t, ${f.name}: v }))} />
          <Text style={{ color: colors.text }}>${jsxText(f.label)}</Text>
        </View>`,
  )
  .join("\n")}
${enums
  .map(
    (f) => `        <View style={[styles.field, styles.row]} accessibilityRole="radiogroup" accessibilityLabel=${q(f.label)}>
          {[${f.enumValues.map(q).join(", ")}].map((v) => (
            <Pressable key={v} accessibilityRole="radio" accessibilityState={{ selected: choices.${f.name} === v }} onPress={() => setChoices((c) => ({ ...c, ${f.name}: v }))} style={[styles.chip, { borderColor: colors.border, backgroundColor: choices.${f.name} === v ? colors.accent : colors.surface }]}>
              <Text style={{ color: choices.${f.name} === v ? colors.accentContrast : colors.text }}>{v}</Text>
            </Pressable>
          ))}
        </View>`,
  )
  .join("\n")}
        <Pressable accessibilityRole="button" onPress={add} style={({ pressed }) => [styles.button, { backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={[styles.buttonText, { color: colors.accentContrast }]}>Add ${jsxText(main.label.toLowerCase())}</Text>
        </Pressable>
        <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>
          {status}
        </Text>
      </View>

      {items.length === 0 ? <Text style={{ color: colors.muted }}>No ${jsxText(main.labelPlural.toLowerCase())} yet.</Text> : null}
      {items.map((item) => {
${st ? `        const dates = checkIns.filter((c) => c.${st.parentField.name} === item.id).map((c) => c.${st.date.name});\n        const done = hasCheckIn(dates, today);\n` : ""}        return (
          <View key={item.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.h2, { color: colors.text }]}>{String(item.${title} ?? "")}</Text>
${st ? `            <Text style={{ color: colors.muted }}>Streak: {currentStreak(dates, today)} day(s)</Text>\n` : ""}${progress ? `            <Text style={{ color: colors.muted }}>Progress: {progressPercent(item.${progress.current.name}, item.${progress.target.name})}%</Text>\n` : ""}            <View style={styles.row}>
${st ? `              <Pressable accessibilityRole="button" accessibilityState={{ disabled: done }} disabled={done} onPress={() => checkIn(item.id)} style={[styles.button, { backgroundColor: done ? colors.border : colors.accent }]}>\n                <Text style={[styles.buttonText, { color: done ? colors.text : colors.accentContrast }]}>{done ? "Checked in today" : "Check in today"}</Text>\n              </Pressable>\n` : ""}              <Pressable accessibilityRole="button" accessibilityLabel={\`Delete \${String(item.${title} ?? "")}\`} onPress={() => ${main.camel}Repository.remove(item.id)} style={[styles.button, { borderColor: colors.border, borderWidth: 1 }]}>
                <Text style={[styles.buttonText, { color: colors.text }]}>Delete</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: space[6], paddingTop: space[12], gap: space[4] },
  title: { fontSize: fontSize.h1, fontWeight: "700" },
  lead: { fontSize: fontSize.lead },
  note: { fontSize: fontSize.body },
  h2: { fontSize: fontSize.lead, fontWeight: "600" },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[3] },
  field: { gap: space[1] },
  row: { flexDirection: "row", alignItems: "center", gap: space[3], flexWrap: "wrap" },
  input: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: fontSize.body },
  chip: { minHeight: 44, paddingHorizontal: space[4], borderWidth: 1, borderRadius: radius.full, justifyContent: "center" },
  button: { minHeight: 48, paddingHorizontal: space[6], borderRadius: radius.full, justifyContent: "center", alignItems: "center" },
  buttonText: { fontSize: fontSize.body, fontWeight: "600" },
});
`);
  return lines.join("");
}

function inputTest(): string {
  return `${TS_HEADER}
import { describe, expect, it } from "vitest";
import { valuesFromInputs } from "../src/lib/input";

describe("input conversion", () => {
  it("turns text inputs into typed values", () => {
    expect(valuesFromInputs({ name: "text", count: "number", on: "boolean" }, { name: " Run ", count: "2,5" }, { on: true })).toEqual({ name: "Run", count: 2.5, on: true });
    expect(valuesFromInputs({ name: "text" }, { name: "  " })).toEqual({});
  });
});
`;
}

export function generateExpo(ctx: GenerateContext): GeneratedProject {
  const out = emptyProject("expo");
  const models = entityModels(ctx.spec);
  const rules = detectRules(ctx.spec, models);
  const f = out.files;
  f["src/lib/form.ts"] = formLibTs();
  f["src/lib/storage.ts"] = storageTs();
  f["src/lib/repository.ts"] = repositoryTs();
  f["src/lib/input.ts"] = inputTs();
  for (const m of models) f[`src/lib/${m.kebab}.ts`] = entityTs(m, models);
  if (rules.streak) {
    f["src/lib/domain/streak.ts"] = streakTs();
    f["test/streak.test.ts"] = streakTest("../src/lib/domain/streak");
  }
  if (rules.progress.length) {
    f["src/lib/domain/progress.ts"] = progressTs();
    f["test/progress.test.ts"] = progressTest("../src/lib/domain/progress");
  }
  f["app/index.tsx"] = screenTsx(ctx, models, rules);
  f["test/entities.test.ts"] = entityTests(models, (m) => `../src/lib/${m}`);
  f["test/input.test.ts"] = inputTest();
  out.setup.push(`npm install --no-audit --no-fund zod@${ZOD_VERSION}`);
  out.verify.push("npm run typecheck", "npm run lint");
  out.autofix = "npx eslint . --fix";
  out.notes.push("Persistence: browser storage on Expo web, in memory on iOS/Android (lost when the app restarts); a native storage adapter (e.g. expo-sqlite) is not installed.");
  if (/remind|notification|påminn/i.test(ctx.spec.userStories.join(" "))) out.notes.push("Local reminder notifications are not implemented (expo-notifications is not part of the template); reminder times are stored and validated only.");
  return out;
}
