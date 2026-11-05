import { describe, it, expect } from "vitest";
import { S3ObjectStore, ensureBuckets } from "../src/adapters/s3.js";

const cfg = { endpoint: process.env.S3_ENDPOINT || "http://localhost:9000", region: "eu-central-1", accessKeyId: "forge", secretAccessKey: "forgeforge" };

describe("s3 adapter (SeaweedFS/MinIO)", () => {
  it("round-trips an object", async () => {
    await ensureBuckets(cfg, ["forge-test"]);
    const s = new S3ObjectStore({ ...cfg, bucket: "forge-test" });
    await s.put("x/hello.txt", "hi there", { contentType: "text/plain" });
    expect(Buffer.from(await s.get("x/hello.txt")).toString()).toBe("hi there");
    expect(await s.list("x/")).toContain("x/hello.txt");
    expect(await s.url("x/hello.txt")).toMatch(/X-Amz-Signature/);
    await s.delete("x/hello.txt");
    expect(await s.exists("x/hello.txt")).toBe(false);
  });
});
