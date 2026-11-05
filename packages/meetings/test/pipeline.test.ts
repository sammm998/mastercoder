import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventBus, MemoryUsageSink } from "@forge/shared";
import { MockLLMProvider } from "@forge/llm";
import { MockSttProvider, MockTranscriptRegistry, encodeWav } from "@forge/speech";
import { approveMeeting, approveSpec, processMeeting } from "../src/index.js";
import { InMemoryMeetingRepo } from "../src/repo.js";
import { extractMeeting, lemma, parseUtterances, toUserStory } from "../src/rules.js";

const salon = readFileSync(fileURLToPath(new URL("../../../evals/fixtures/meetings/salong-mote.sv.txt", import.meta.url)), "utf8");

describe("meeting pipeline (mock LLM, Swedish salon fixture)", () => {
  it("extracts requirements covering the booking system and a spec with booking entities", async () => {
    const usage = new MemoryUsageSink();
    const events = new EventBus();
    const repo = new InMemoryMeetingRepo();
    await repo.create({ id: "mtg_salon", workspaceId: "ws", source: "recording", language: "sv", status: "processing", consentNoticePosted: true, retention: {}, createdAt: new Date().toISOString() });
    const r = await processMeeting({ meetingId: "mtg_salon", transcript: salon, language: "sv" }, { llm: new MockLLMProvider(), usage, events, projectId: "prj_1", repo });

    expect(r.status).toBe("awaiting_approval");
    expect(r.transcript.segments.length).toBeGreaterThan(30);
    expect(r.transcript.segments[0]!.speaker).toBe("Maria");
    const ex = r.extraction;
    expect(ex.generator).toBe("mock-rules");
    expect(ex.summary).toMatch(/mock/);
    const reqText = ex.requirements.map((q) => q.text.toLowerCase()).join("\n");
    // Coverage of everything discussed:
    expect(reqText).toMatch(/tjänst/); // services
    expect(reqText).toMatch(/stylist/); // stylists
    expect(reqText).toMatch(/tidslucko|tider/); // time slots
    expect(reqText).toMatch(/dubbelbok|samtidigt/); // no double bookings
    expect(reqText).toMatch(/sms/); // SMS confirmation / reminder
    expect(reqText).toMatch(/e-post/); // e-mail confirmation
    expect(reqText).toMatch(/dagsvy/); // staff day view
    expect(reqText).toMatch(/avboka/); // cancellations
    expect(ex.requirements.every((q) => /^Som \p{L}+ vill jag/u.test(q.userStory))).toBe(true);
    expect(ex.requirements.filter((q) => q.priority === "must").map((q) => q.text).join(" ")).toMatch(/aldrig/);
    expect(ex.requirements.find((q) => /kunden vill kunna välja/i.test(q.text))?.userStory).toMatch(/^Som kund vill jag kunna välja tjänst/);
    expect(ex.decisions).toHaveLength(2);
    expect(ex.decisions.join(" ")).toMatch(/avgift/);
    expect(ex.decisions.join(" ")).toMatch(/[Bb]etalning sker i salongen/);
    expect(ex.openQuestions).toEqual(["Ska vi koppla det till Google Kalender för personalen?"]);
    expect(ex.actionItems).toEqual([
      expect.objectContaining({ owner: "Jonas", due: "nästa fredag" }),
      expect.objectContaining({ owner: "Maria", due: "senast på måndag" }),
    ]);

    const spec = r.spec;
    expect(spec.title).toBe("Bokningssystem");
    const names = spec.entities.map((e) => e.name);
    for (const n of ["Bokning", "Tjänst", "Stylist", "Kund", "Tidslucka"]) expect(names).toContain(n);
    expect(spec.entities.find((e) => e.name === "Tjänst")!.fields).toEqual(expect.arrayContaining(["id", "price", "durationMinutes"]));
    expect(spec.entities.find((e) => e.name === "Bokning")!.fields).toEqual(expect.arrayContaining(["startsAt", "endsAt"]));
    expect(spec.entities.find((e) => e.name === "Kund")!.fields).toEqual(expect.arrayContaining(["name", "phone"]));
    expect(spec.screens).toContain("Dagsvy för personalen");
    expect(spec.integrations.join(" ")).toMatch(/SMS/);
    expect(spec.integrations.join(" ")).toMatch(/E-post/);
    // Payment was explicitly deferred and calendar sync is an open question → not integrations.
    expect(spec.integrations.join(" ")).not.toMatch(/Betalning|Kalender/);
    expect(spec.suggestedIntents[0]).toMatchObject({ kind: "app", hint: "nextjs" });
    expect(spec.acceptanceCriteria).toHaveLength(ex.requirements.length);
    expect(spec.openQuestions).toEqual(ex.openQuestions);

    // Persisted + events + metering
    expect((await repo.get("mtg_salon"))!.status).toBe("awaiting_approval");
    expect(events.history.map((e) => e.type)).toEqual(["phase.started", "job.progress", "job.progress", "plan.ready", "phase.completed"]);
    expect(events.ofType("plan.ready")[0]!.requiresApproval).toBe(true);
    expect(usage.records.some((u) => u.kind === "llm_input_tokens" && u.projectId === "prj_1")).toBe(true);

    // Approval → build prompt for the intent router
    const prompt = await approveMeeting("mtg_salon", repo);
    expect((await repo.get("mtg_salon"))!.status).toBe("approved");
    expect(prompt).toMatch(/^Bygg: Bokningssystem/);
    expect(prompt).toMatch(/Datamodell:\n- Stylist\(id/);
    expect(prompt).toMatch(/Bokning\(id, startsAt, endsAt\)/);
    expect(prompt).toContain("Öppna frågor");
    await expect(approveMeeting("mtg_salon", repo)).rejects.toThrow(/not awaiting_approval/);
  });

  it("transcribes audio with the SttProvider first", async () => {
    const registry = new MockTranscriptRegistry();
    const wav = encodeWav(new Int16Array(16000 * 3), { sampleRate: 16000 });
    registry.registerAudio(wav, "Anna: Vi behöver en app för att boka tvättstugan.\nErik: Varje bokning ska ha en starttid och en sluttid. Den ska kunna visa lediga tider för varje tvättstuga.\nAnna: Bra. Vi bestämde att bokningar max får vara tre timmar.");
    const usage = new MemoryUsageSink();
    const r = await processMeeting({ audio: { bytes: wav, mimeType: "audio/wav" }, language: "sv" }, { llm: new MockLLMProvider(), stt: new MockSttProvider({ registry, usage }), usage });
    expect(r.transcript.segments.map((s) => s.speaker)).toEqual(["Anna", "Erik", "Anna"]);
    expect(r.extraction.requirements.length).toBeGreaterThanOrEqual(3);
    expect(r.extraction.decisions).toHaveLength(1);
    expect(r.spec.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["Bokning", "Tvättstuga"]));
    expect(usage.records.some((u) => u.kind === "transcription_minutes")).toBe(true);
  });

  it("handles an English meeting", async () => {
    const en = [
      "Sarah: We need a simple app for our gym members.",
      "Tom: Members should be able to book classes and cancel bookings online.",
      "Sarah: The system must never overbook a class. Each class has a coach and a capacity.",
      "Tom: Should we send reminders by email?",
      "Sarah: Yes, an email reminder the day before.",
      "Tom: We decided to launch in March.",
      "Sarah: Action: Tom shares the class schedule by Friday.",
      "Tom: Do we need payments?",
      "Sarah: Not sure yet, let's get back to that.",
    ].join("\n");
    const r = await processMeeting({ transcript: en, language: "en" }, { llm: new MockLLMProvider() });
    const ex = r.extraction;
    expect(ex.requirements.every((q) => q.userStory.startsWith("As a "))).toBe(true);
    expect(ex.requirements.map((q) => q.text).join(" ")).toMatch(/book classes/);
    expect(ex.requirements.some((q) => q.priority === "must")).toBe(true);
    expect(ex.decisions).toEqual(["We decided to launch in March"]);
    expect(ex.actionItems[0]).toMatchObject({ owner: "Tom", due: "by friday" });
    expect(ex.openQuestions).toEqual(["Do we need payments?"]);
    expect(r.spec.language).toBe("en");
    expect(r.spec.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["Class"]));
    expect(r.spec.integrations.join(" ")).toMatch(/e-mail/i);
    expect(approveSpec(r.spec)).toMatch(/^Build: /);
  });

  it("rejects empty input", async () => {
    await expect(processMeeting({ language: "sv" }, { llm: new MockLLMProvider() })).rejects.toThrow(/audio or a transcript/);
    await expect(processMeeting({ transcript: "   ", language: "sv" }, { llm: new MockLLMProvider() })).rejects.toThrow(/empty/);
  });
});

describe("rules helpers", () => {
  it("lemmatizes Swedish definite/plural nouns", () => {
    expect(["bokningar", "bokningen", "bokningarna", "kunder", "kunden", "kunderna", "tjänster", "tjänsten", "stylister", "tidsluckor", "bekräftelsen", "påminnelser", "systemet", "bookings", "classes"].map(lemma)).toEqual([
      "bokning", "bokning", "bokning", "kund", "kund", "kund", "tjänst", "tjänst", "stylist", "tidslucka", "bekräftelse", "påminnelse", "system", "booking", "classe",
    ]);
  });
  it("writes user stories from cue phrases", () => {
    expect(toUserStory("Kunden vill kunna avboka själv.", "sv")).toBe("Som kund vill jag kunna avboka själv");
    expect(toUserStory("Den ska kunna skicka sms.", "sv")).toBe("Som användare vill jag att systemet ska kunna skicka sms");
    expect(toUserStory("Vi behöver en adminpanel för personalen", "sv")).toBe("Som personal vill jag ha en adminpanel för personalen");
    expect(toUserStory("The customer wants to pay by card", "en")).toBe("As a customer, I want to pay by card");
  });
  it("parses labelled utterances and keeps continuation lines", () => {
    expect(parseUtterances("A: hej\nfortsätter\nB: ok")).toEqual([{ speaker: "A", text: "hej fortsätter" }, { speaker: "B", text: "ok" }]);
    expect(extractMeeting("Beslut: vi kör React.", "sv").decisions).toEqual(["Vi kör React"]);
  });
});
