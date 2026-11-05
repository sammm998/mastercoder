import { ForgeError, type EventSink, type UsageSink } from "@forge/shared";
import { MeteredLLM, getModels, structured, type LLMProvider } from "@forge/llm";
import { parseLabelledText, transcriptToLabeledText, type SttProvider, type Transcript } from "@forge/speech";
import { ExtractionSchema, MeetingSpecSchema, type Extraction, type MeetingSpec } from "./schemas.js";
import { PURPOSE_EXTRACT, PURPOSE_SPEC } from "./mock-llm.js";
import type { MeetingRepo } from "./types.js";

export interface ProcessMeetingInput {
  meetingId?: string;
  /** Raw audio (in-person recording / bot recording) — transcribed with deps.stt. */
  audio?: { bytes: Uint8Array; mimeType: string };
  /** Or an existing transcript (bot vendor transcript, uploaded text with "Name: text" lines). */
  transcript?: Transcript | string;
  language: string;
  diarize?: boolean;
}

export interface ProcessMeetingDeps {
  llm: LLMProvider;
  stt?: SttProvider;
  usage?: UsageSink;
  events?: EventSink;
  projectId?: string;
  repo?: MeetingRepo;
  models?: { extract?: string; spec?: string };
}

export interface ProcessMeetingResult {
  meetingId?: string;
  status: "awaiting_approval";
  transcript: Transcript;
  extraction: Extraction;
  spec: MeetingSpec;
}

/** Max transcript characters sent to the model (≈ 3 h meeting); longer transcripts are truncated with a marker. */
export const MAX_TRANSCRIPT_CHARS = 400_000;

const EXTRACT_SYSTEM = `You analyse meeting transcripts for Forge, a platform that builds software from requirements.
Extract, in the meeting's language:
- summary: 3-6 sentences
- decisions: explicit decisions ("vi bestämde", "beslut:", "we decided")
- requirements: each with id ("R1"...), text (as stated), userStory ("Som <roll> vill jag ..." in Swedish, "As a <role>, I want ..." in English), priority must|should|could, source (speaker)
- openQuestions: questions that were not resolved
- actionItems: { text, owner?, due? } — owner is a participant name when stated
JSON shape: {"summary":string,"decisions":string[],"requirements":[{"id","text","userStory","priority","source"}],"openQuestions":string[],"actionItems":[{"text","owner","due"}]}
Only include what the transcript supports; never invent requirements.`;

const SPEC_SYSTEM = `You turn an approved meeting extraction into a build spec for Forge's intent router.
JSON shape: {"title":string,"language":"sv"|"en","goals":string[],"userStories":string[],
"entities":[{"name":string,"fields":string[],"relations":string[]}],"screens":string[],"integrations":string[],
"suggestedIntents":[{"kind":"app"|"website"|"mobile"|"backend"|"integration"|"agent"|"document"|"slides"|"image"|"video"|"question","confidence":number,"summary":string,"hint"?:string}],
"acceptanceCriteria":string[],"openQuestions":string[]}
Entities are data-model hints (singular nouns, camelCase fields). Keep the meeting's language for prose.`;

function transcriptFromText(text: string, language: string): Transcript {
  const parts = parseLabelledText(text);
  return {
    text: parts.map((p) => p.text).join(" "),
    language,
    durationSec: 0,
    segments: parts.map((p) => (p.speaker ? { start: 0, end: 0, text: p.text, speaker: p.speaker } : { start: 0, end: 0, text: p.text })),
    provider: "text",
    model: "none",
  };
}

function promptTranscript(t: Transcript): string {
  const s = transcriptToLabeledText(t) || t.text;
  return s.length > MAX_TRANSCRIPT_CHARS ? `${s.slice(0, MAX_TRANSCRIPT_CHARS)}\n[… transcript truncated …]` : s;
}

/**
 * audio → transcript (SttProvider) → extraction ("meetings.extract") → spec ("meetings.spec") → awaiting_approval.
 * Nothing is built until a human approves the spec (`approveSpec`).
 */
export async function processMeeting(input: ProcessMeetingInput, deps: ProcessMeetingDeps): Promise<ProcessMeetingResult> {
  if (!input.audio && input.transcript === undefined) throw new ForgeError("BAD_INPUT", "processMeeting needs audio or a transcript");
  const llm = deps.usage && !(deps.llm instanceof MeteredLLM) ? new MeteredLLM(deps.llm, deps.usage, { projectId: deps.projectId }) : deps.llm;
  const models = getModels();
  const projectId = deps.projectId ?? input.meetingId ?? "meeting";
  const started = Date.now();
  const progress = (p: number, label: string) =>
    deps.events?.emit({ type: "job.progress", projectId, jobId: input.meetingId ?? "meeting", progress: p, label });
  deps.events?.emit({ type: "phase.started", projectId, phase: "meeting" });
  if (input.meetingId && deps.repo) await deps.repo.update(input.meetingId, { status: "processing" });
  try {
    let transcript: Transcript;
    if (input.transcript !== undefined) {
      transcript = typeof input.transcript === "string" ? transcriptFromText(input.transcript, input.language) : input.transcript;
    } else {
      if (!deps.stt) throw new ForgeError("BAD_INPUT", "Audio given but no SttProvider in deps.stt");
      progress(0.1, "transcribing");
      const audio = input.audio as { bytes: Uint8Array; mimeType: string };
      transcript = await deps.stt.transcribe(audio.bytes, { mimeType: audio.mimeType, language: input.language, diarize: input.diarize ?? true });
    }
    if (!transcript.text.trim()) throw new ForgeError("BAD_INPUT", "Transcript is empty");
    const tText = promptTranscript(transcript);

    progress(0.5, "extracting requirements");
    const { value: extraction } = await structured(
      llm,
      {
        purpose: PURPOSE_EXTRACT,
        model: deps.models?.extract ?? models.builder,
        system: EXTRACT_SYSTEM,
        cache: true,
        messages: [{ role: "user", content: `<language>${input.language}</language>\n<transcript>\n${tText}\n</transcript>` }],
        maxTokens: 8000,
      },
      ExtractionSchema,
    );

    progress(0.8, "writing spec");
    const { value: spec } = await structured(
      llm,
      {
        purpose: PURPOSE_SPEC,
        model: deps.models?.spec ?? models.planner,
        system: SPEC_SYSTEM,
        cache: true,
        messages: [
          {
            role: "user",
            content: `<language>${input.language}</language>\n<extraction>\n${JSON.stringify(extraction)}\n</extraction>\n<transcript>\n${tText}\n</transcript>`,
          },
        ],
        maxTokens: 8000,
      },
      MeetingSpecSchema,
    );

    if (input.meetingId && deps.repo) await deps.repo.update(input.meetingId, { status: "awaiting_approval", transcript, extraction, spec });
    deps.events?.emit({ type: "plan.ready", projectId, spec, requiresApproval: true });
    deps.events?.emit({ type: "phase.completed", projectId, phase: "meeting", durationMs: Date.now() - started });
    const out: ProcessMeetingResult = { status: "awaiting_approval", transcript, extraction, spec };
    if (input.meetingId) out.meetingId = input.meetingId;
    return out;
  } catch (e) {
    if (input.meetingId && deps.repo) await deps.repo.update(input.meetingId, { status: "failed" }).catch(() => undefined);
    throw e;
  }
}

/** Turn an approved spec into the build prompt handed to the intent router (source "meeting"). */
export function approveSpec(spec: MeetingSpec): string {
  const sv = spec.language.startsWith("sv");
  const L = sv
    ? { build: "Bygg", goals: "Mål", stories: "User stories", model: "Datamodell", screens: "Skärmar", integrations: "Integrationer", criteria: "Acceptanskriterier", open: "Öppna frågor (fråga användaren innan du antar något)", source: "Källa: mötesspecifikation godkänd av användaren." }
    : { build: "Build", goals: "Goals", stories: "User stories", model: "Data model", screens: "Screens", integrations: "Integrations", criteria: "Acceptance criteria", open: "Open questions (ask the user before assuming)", source: "Source: meeting spec approved by the user." };
  const list = (h: string, xs: string[]) => (xs.length ? `\n${h}:\n${xs.map((x) => `- ${x}`).join("\n")}\n` : "");
  const entities = spec.entities.map((e) => `${e.name}(${e.fields.join(", ")})${e.relations.length ? ` → ${e.relations.join(", ")}` : ""}`);
  return [
    `${L.build}: ${spec.title}`,
    list(L.goals, spec.goals),
    list(L.stories, spec.userStories),
    list(L.model, entities),
    list(L.screens, spec.screens),
    list(L.integrations, spec.integrations),
    list(L.criteria, spec.acceptanceCriteria),
    list(L.open, spec.openQuestions),
    L.source,
  ]
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Mark a meeting approved and return the build prompt. */
export async function approveMeeting(meetingId: string, repo: MeetingRepo): Promise<string> {
  const m = await repo.get(meetingId);
  if (!m?.spec) throw new ForgeError("NOT_FOUND", `Meeting ${meetingId} has no spec to approve`);
  if (m.status !== "awaiting_approval") throw new ForgeError("BAD_INPUT", `Meeting ${meetingId} is ${m.status}, not awaiting_approval`);
  await repo.update(meetingId, { status: "approved" });
  return approveSpec(m.spec);
}
