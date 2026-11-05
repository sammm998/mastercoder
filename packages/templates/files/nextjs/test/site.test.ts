import { describe, expect, it } from "vitest";
import { absoluteUrl, site } from "@/lib/site";
import { motionDuration } from "@/lib/motion";

describe("site", () => {
  it("builds absolute URLs from the site origin", () => {
    expect(absoluteUrl("/about", "https://example.eu")).toBe("https://example.eu/about");
    expect(absoluteUrl("blog/post", "https://example.eu/base")).toBe("https://example.eu/base/blog/post");
    expect(site.name.length).toBeGreaterThan(0);
  });

  it("drops animation durations under reduced motion", () => {
    expect(motionDuration(400, true)).toBe(0);
    expect(motionDuration(400, false)).toBe(400);
  });
});
