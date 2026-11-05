"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

export type Definition = Record<string, unknown>;

const KNOWN = ["instructions", "description", "tools", "integrations", "trigger", "schedule", "cron", "memory", "costCapUsd", "maxCostUsd", "approvals", "approvalRules", "requireApproval", "model", "evals", "channels"] as const;
const ORDER = new Map<string, number>(KNOWN.map((k, i) => [k, i]));

type FieldKind = "text" | "longtext" | "number" | "boolean" | "list" | "json";

/** How a definition value is edited (pure; unit-tested). */
export function fieldKind(key: string, v: unknown): FieldKind {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return key === "instructions" || key === "description" || v.length > 80 || v.includes("\n") ? "longtext" : "text";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return "list";
  return "json";
}

export function orderedKeys(def: Definition): string[] {
  return Object.keys(def).sort((a, b) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99) || a.localeCompare(b));
}

/**
 * Review/edit an agent definition of any shape: known fields get friendly labels; strings, numbers,
 * booleans and string lists get native inputs; nested objects (trigger, memory, approval rules) get
 * a JSON editor. The full JSON is also editable. Server-side `validate` has the final word.
 */
export function DefinitionForm({ value, onChange, onValidity }: { value: Definition; onChange: (d: Definition) => void; onValidity?: (ok: boolean) => void }) {
  const t = useT();
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  const [rawError, setRawError] = useState(false);
  const [bad, setBad] = useState<Set<string>>(new Set());
  const rawFocused = useRef(false);

  useEffect(() => {
    if (!rawFocused.current) setRaw(JSON.stringify(value, null, 2));
  }, [value]);
  useEffect(() => onValidity?.(bad.size === 0 && !rawError), [bad, rawError, onValidity]);

  const label = (k: string) => (ORDER.has(k) ? t(`agents.fields.${k}` as MessageKey) : k);
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });

  return (
    <div className="stack">
      {orderedKeys(value).map((k) => {
        const v = value[k];
        const kind = fieldKind(k, v);
        const id = `def-${k}`;
        if (kind === "boolean")
          return (
            <label key={k} className="switch">
              <input type="checkbox" checked={v as boolean} onChange={(e) => set(k, e.target.checked)} />
              {label(k)}
            </label>
          );
        return (
          <div key={k} className="field">
            <label htmlFor={id}>{label(k)}</label>
            {kind === "text" && <input id={id} className="input" value={v as string} onChange={(e) => set(k, e.target.value)} />}
            {kind === "longtext" && <textarea id={id} className="textarea" rows={k === "instructions" ? 7 : 3} value={v as string} onChange={(e) => set(k, e.target.value)} />}
            {kind === "number" && <input id={id} className="input" type="number" step="any" value={v as number} onChange={(e) => set(k, e.target.value === "" ? 0 : Number(e.target.value))} style={{ maxWidth: 200 }} />}
            {kind === "list" && (
              <>
                <textarea
                  id={id}
                  className="textarea mono"
                  rows={Math.min(8, Math.max(2, (v as string[]).length + 1))}
                  value={(v as string[]).join("\n")}
                  onChange={(e) =>
                    set(
                      k,
                      e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                />
                <p className="hint">{t("agents.listHint")}</p>
              </>
            )}
            {kind === "json" && (
              <>
                <textarea
                  id={id}
                  className="textarea mono"
                  rows={Math.min(12, (jsonDrafts[k] ?? JSON.stringify(v, null, 2)).split("\n").length + 1)}
                  value={jsonDrafts[k] ?? JSON.stringify(v, null, 2)}
                  aria-invalid={bad.has(k)}
                  onChange={(e) => {
                    const text = e.target.value;
                    setJsonDrafts((d) => ({ ...d, [k]: text }));
                    try {
                      const parsed = JSON.parse(text) as unknown;
                      setBad((b) => new Set([...b].filter((x) => x !== k)));
                      set(k, parsed);
                    } catch {
                      setBad((b) => new Set([...b, k]));
                    }
                  }}
                />
                {bad.has(k) && <p className="hint" style={{ color: "var(--danger)" }}>{t("agents.invalidJson")}</p>}
              </>
            )}
          </div>
        );
      })}
      <details>
        <summary className="label" style={{ cursor: "pointer" }}>
          {t("agents.rawJson")}
        </summary>
        <label htmlFor="def-raw" className="sr-only">
          {t("agents.rawJson")}
        </label>
        <textarea
          id="def-raw"
          className="textarea mono"
          rows={16}
          value={raw}
          aria-invalid={rawError}
          onFocus={() => (rawFocused.current = true)}
          onBlur={() => (rawFocused.current = false)}
          onChange={(e) => {
            setRaw(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value) as unknown;
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
              setRawError(false);
              setJsonDrafts({});
              setBad(new Set());
              onChange(parsed as Definition);
            } catch {
              setRawError(true);
            }
          }}
        />
        {rawError && <p className="hint" style={{ color: "var(--danger)" }}>{t("agents.invalidJson")}</p>}
      </details>
    </div>
  );
}
