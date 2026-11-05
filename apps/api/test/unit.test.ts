import { describe, it, expect } from "vitest";
import { can, canAssign } from "../src/lib/rbac.js";
import { hashPassword, verifyPassword, passwordProblems } from "../src/auth/password.js";
import { MemoryRateLimiter } from "../src/lib/ratelimit.js";
import { HeuristicBotProtection } from "../src/auth/bot-protection.js";

describe("rbac", () => {
  it("orders roles", () => {
    expect(can("viewer", "project.read")).toBe(true);
    expect(can("viewer", "project.write")).toBe(false);
    expect(can("editor", "project.deploy")).toBe(true);
    expect(can("admin", "billing.manage")).toBe(false);
    expect(can("owner", "workspace.delete")).toBe(true);
    expect(can(null, "project.read")).toBe(false);
    expect(canAssign("admin", "editor")).toBe(true);
    expect(canAssign("admin", "admin")).toBe(false);
    expect(canAssign("owner", "owner")).toBe(true);
  });
});

describe("passwords", () => {
  it("hashes and verifies with scrypt", async () => {
    const h = await hashPassword("Correct-Horse-9");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("Correct-Horse-9", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(passwordProblems("short")).toMatch(/10/);
    expect(passwordProblems("alllowercaseletters")).toMatch(/two/);
    expect(passwordProblems("Long-enough-1")).toBeNull();
  });
});

describe("abuse controls", () => {
  it("rate limiter blocks after limit", async () => {
    const rl = new MemoryRateLimiter();
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rl.hit("k", 3, 60)).allowed);
    expect(results).toEqual([true, true, true, false]);
  });
  it("heuristic bot protection", async () => {
    const b = new HeuristicBotProtection();
    expect((await b.verify({ ip: "1", website: "x" })).ok).toBe(false);
    expect((await b.verify({ ip: "1", elapsedMs: 200 })).ok).toBe(false);
    expect((await b.verify({ ip: "1", elapsedMs: 4000 })).ok).toBe(true);
  });
});
