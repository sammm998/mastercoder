import { describe, it, expect } from "vitest";
import { MEDIA_ASK } from "../src/routers/task.js";

describe("chat-mode media requests", () => {
  it("routes 'make an image/video' messages to media generation", () => {
    for (const p of ["Skapa en bild av en katt i rymden", "kan du generera en kort video om vårt kafé", "Make me a logo for Saxen", "create 3 images of the product"]) expect(MEDIA_ASK.test(p), p).toBe(true);
  });
  it("keeps ordinary chat as chat", () => {
    for (const p of ["Vad har du byggt hittills?", "How do I deploy this?", "Varför är bilden suddig på mobilen?"]) expect(MEDIA_ASK.test(p), p).toBe(false);
  });
});
