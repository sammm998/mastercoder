"use client";

import { useEffect, useState } from "react";

/** Types example prompts into the hero prompt bar. Static (first prompt) under reduced motion. */
export function PromptTicker({ prompts, label }: { prompts: string[]; label: string }) {
  const [text, setText] = useState(prompts[0] ?? "");
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || prompts.length < 2) return;
    let idx = 0;
    let len = prompts[0]?.length ?? 0;
    let phase: "hold" | "erase" | "type" = "hold";
    let timer = 0;
    const step = () => {
      const full = prompts[idx] ?? "";
      if (phase === "hold") {
        phase = "erase";
        setTyping(true);
        timer = window.setTimeout(step, 20);
        return;
      }
      if (phase === "erase") {
        len = Math.max(0, len - 2);
        setText(full.slice(0, len));
        if (len === 0) {
          idx = (idx + 1) % prompts.length;
          phase = "type";
          timer = window.setTimeout(step, 280);
        } else timer = window.setTimeout(step, 16);
        return;
      }
      len += 1;
      setText(full.slice(0, len));
      if (len >= full.length) {
        phase = "hold";
        setTyping(false);
        timer = window.setTimeout(step, 2800);
      } else timer = window.setTimeout(step, 30 + Math.random() * 45);
    };
    timer = window.setTimeout(step, 3200);
    return () => window.clearTimeout(timer);
  }, [prompts]);
  return (
    <p className="prompt-ticker" aria-label={label}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{prompts[0]}</span>
      <span className="caret" data-typing={typing} aria-hidden="true" />
    </p>
  );
}
