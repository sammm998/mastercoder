"use client";

import { useState } from "react";
import { useT } from "@/i18n/client";

export function CopyField({ label, value, hint, multiline = false }: { label: string; value: string; hint?: string; multiline?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const id = `copy-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row" style={{ flexWrap: "nowrap", gap: 6, alignItems: "stretch" }}>
        {multiline ? <textarea id={id} className="textarea mono" readOnly rows={2} value={value} style={{ fontSize: "0.78rem" }} /> : <input id={id} className="input mono" readOnly value={value} style={{ fontSize: "0.78rem" }} />}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            })
          }
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
