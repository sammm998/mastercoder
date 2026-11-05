import { describe, it, expect } from "vitest";
import { DESIGN_OPTIONS } from "../src/jobs/build.js";

describe("design proposal requests", () => {
  it("recognises requests for design proposals in Swedish and English", () => {
    for (const p of ["Ge mig tre designförslag först", "visa 3 olika design innan du bygger", "Show me design options first", "three different styles please", "förslag på design för hemsidan"]) expect(DESIGN_OPTIONS.test(p)).toBe(true);
    for (const p of ["Bygg en hemsida för mitt kafé", "Make the header blue", "Design a landing page"]) expect(DESIGN_OPTIONS.test(p)).toBe(false);
  });
});
