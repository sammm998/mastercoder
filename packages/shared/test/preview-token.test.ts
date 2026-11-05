import { describe, it, expect } from "vitest";
import { signPreviewToken, verifyPreviewToken } from "../src/index.js";

describe("preview tokens", () => {
  it("round-trips, rejects tampering, wrong secrets, expiry and non-http targets", () => {
    const now = 1_800_000_000;
    const t = signPreviewToken({ projectId: "p1", target: "http://w.internal:5173", exp: now + 60 }, "s");
    expect(verifyPreviewToken(t, "s", now)?.target).toBe("http://w.internal:5173");
    expect(verifyPreviewToken(t, "other", now)).toBeNull();
    expect(verifyPreviewToken(t, "s", now + 61)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ projectId: "p1", target: "http://evil:1", exp: now + 60 })).toString("base64url");
    expect(verifyPreviewToken(`${forged}.${sig}`, "s", now)).toBeNull();
    expect(verifyPreviewToken(`${body}x.${sig}`, "s", now)).toBeNull();
    expect(verifyPreviewToken(signPreviewToken({ projectId: "p", target: "file:///etc/passwd", exp: now + 60 }, "s"), "s", now)).toBeNull();
  });
});
