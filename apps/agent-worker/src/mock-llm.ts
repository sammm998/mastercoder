import { registerMockHandler } from "@forge/llm";

/**
 * Offline (LLM_PROVIDER=mock) chat replies: rule-based, built only from the real project context the job
 * passed in, and labelled as offline so they are never mistaken for a language model.
 */
registerMockHandler("assistant.chat", (req) => {
  const m = req.messages[req.messages.length - 1];
  const text = typeof m?.content === "string" ? m.content : "";
  const msg = (text.split("## Message\n")[1] ?? "").trim();
  const project = text.match(/Project: (.+)/)?.[1] ?? "your project";
  const files = Number(text.match(/Files \((\d+)\)/)?.[1] ?? 0);
  const sv = /[åäö]|\b(hur|vad|varför|kan|jag|du|är|och|det)\b/i.test(msg);
  const recent = (text.split("Recent requests:\n")[1] ?? "").split("\n## Message")[0]?.trim() ?? "";
  const status = recent && !recent.startsWith("- none") ? (sv ? `Senaste förfrågningar:\n${recent}` : `Recent requests:\n${recent}`) : sv ? "Inga tidigare förfrågningar än." : "No earlier requests yet.";
  const head = sv
    ? `(Offline-läge: jag svarar med regler, inte en språkmodell.) ${project} har ${files} filer.`
    : `(Offline mode: rule-based reply, not a language model.) ${project} has ${files} files.`;
  const tip = sv ? "Vill du att jag ändrar något? Byt till Bygg-läget och beskriv ändringen." : "Want me to change something? Switch to Build mode and describe the change.";
  return `${head}\n\n${status}\n\n${tip}`;
});
