import { describe, expect, it } from "vitest";
import { EAS_CLI_VERSION, easBuild, expoPreviewQr, parseEasBuildOutput } from "../src/index.js";

describe("easBuild", () => {
  it("builds a non-interactive EAS command for the sandbox", () => {
    const c = easBuild({ platform: "android", profile: "preview" });
    expect(c.argv).toEqual(["npx", "--yes", `eas-cli@${EAS_CLI_VERSION}`, "build", "--platform", "android", "--profile", "preview", "--non-interactive", "--json", "--no-wait"]);
    expect(c.command).toBe(c.argv.join(" "));
    expect(c.requiredEnv).toEqual(["EXPO_TOKEN"]);
    expect(c.cwd).toBe("/workspace");
  });

  it("quotes messages and validates input", () => {
    const c = easBuild({ platform: "all", profile: "production", message: "it's v1; rm -rf /", wait: true, autoSubmit: true });
    expect(c.command).toContain(`--message 'it'\\''s v1; rm -rf /'`);
    expect(c.argv).not.toContain("--no-wait");
    expect(c.argv).toContain("--auto-submit");
    expect(() => easBuild({ platform: "windows" as "ios", profile: "preview" })).toThrow();
    expect(() => easBuild({ platform: "ios", profile: "prod; curl evil" })).toThrow();
  });

  it("parses eas build --json output", () => {
    const out = `Some log line\n[{"id":"b1","platform":"ANDROID","status":"FINISHED","artifacts":{"buildUrl":"https://expo.dev/artifacts/eas/b1.apk"}}]`;
    expect(parseEasBuildOutput(out)).toEqual([{ id: "b1", platform: "ANDROID", status: "FINISHED", artifactUrl: "https://expo.dev/artifacts/eas/b1.apk" }]);
    expect(() => parseEasBuildOutput("no json")).toThrow();
  });
});

describe("expoPreviewQr", () => {
  it("renders an SVG QR code for exp:// and https:// URLs", async () => {
    const svg = await expoPreviewQr("exp://u.expo.dev/abc?runtime-version=1");
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(svg).toContain("<path");
    expect(await expoPreviewQr("https://expo.dev/preview/update?id=1")).toContain("<svg");
  });

  it("rejects other schemes", async () => {
    await expect(expoPreviewQr("javascript:alert(1)")).rejects.toThrow(/Unsupported/);
    await expect(expoPreviewQr("not a url")).rejects.toThrow(/Invalid/);
  });
});
