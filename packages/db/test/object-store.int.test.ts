import { describe, it, expect, afterAll } from "vitest";
import { connect, runMigrations, DbObjectStore } from "../src/index.js";

const h = connect(undefined, 2);
afterAll(() => h.close());

describe("DbObjectStore (postgres)", () => {
  it("round-trips binary objects with content type, lists by prefix and deletes", async () => {
    await runMigrations();
    const s = new DbObjectStore(h.db, { publicBaseUrl: "http://api", secret: "x" });
    const key = `test/${Date.now()}/img.png`;
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]);
    await s.put(key, bytes, { contentType: "image/png" });
    expect(await s.get(key)).toEqual(bytes);
    expect(await s.head(key)).toEqual({ contentType: "image/png", size: 7 });
    expect(await s.list(key.slice(0, key.lastIndexOf("/") + 1))).toEqual([key]);
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
  });
});
