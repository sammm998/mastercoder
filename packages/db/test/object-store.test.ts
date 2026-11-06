import { describe, it, expect } from "vitest";
import { verifyFileSignature, DbObjectStore } from "../src/object-store.js";

describe("signed file URLs", () => {
  it("accepts its own signature until expiry and rejects tampering", async () => {
    const store = new DbObjectStore({} as never, { publicBaseUrl: "https://api.example/", secret: "s3cret" });
    const u = new URL(await store.url("projects/p1/media/a.png", 60));
    expect(u.pathname).toBe("/files/projects/p1/media/a.png");
    const exp = Number(u.searchParams.get("exp"));
    const sig = u.searchParams.get("sig")!;
    expect(verifyFileSignature("projects/p1/media/a.png", exp, sig, "s3cret")).toBe(true);
    expect(verifyFileSignature("projects/p2/media/a.png", exp, sig, "s3cret")).toBe(false);
    expect(verifyFileSignature("projects/p1/media/a.png", exp, sig, "other")).toBe(false);
    expect(verifyFileSignature("projects/p1/media/a.png", exp, sig, "s3cret", exp + 1)).toBe(false);
  });
  it("rejects path traversal keys", async () => {
    const store = new DbObjectStore({} as never, { publicBaseUrl: "https://api.example", secret: "x" });
    await expect(store.url("../etc/passwd")).rejects.toThrow(/Invalid storage key/);
  });
});
