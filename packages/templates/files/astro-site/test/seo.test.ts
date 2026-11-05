import { describe, expect, it } from "vitest";
import { resolveMeta, websiteJsonLd } from "../src/lib/seo";
import { site } from "../src/lib/site";

describe("seo", () => {
  it("builds title, canonical and Open Graph tags", () => {
    const m = resolveMeta({ title: "About", path: "/about", image: "/og.png" }, "https://example.eu");
    expect(m.title).toBe(`About · ${site.name}`);
    expect(m.canonical).toBe("https://example.eu/about");
    expect(m.openGraph["og:image"]).toBe("https://example.eu/og.png");
    expect(m.description).toBe(site.description);
  });

  it("escapes JSON-LD so it cannot close the script tag", () => {
    expect(websiteJsonLd("https://example.eu/</script>")).not.toContain("</script>");
  });
});
