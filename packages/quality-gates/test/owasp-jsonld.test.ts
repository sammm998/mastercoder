import { describe, it, expect } from "vitest";
import { scanOwasp } from "../src/index.js";

const file = (path: string, content: string) => ({ path, content, lines: content.split("\n") });

describe("owasp: JSON-LD", () => {
  it("accepts the app-kit JSON-LD serializer but still flags raw JSON.stringify", () => {
    const safe = scanOwasp([file("src/kit/json-ld.tsx", `export const L = ({ d }) => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(d) }} />;`)]);
    const unsafe = scanOwasp([file("src/a.tsx", `export const L = ({ d }) => <div dangerouslySetInnerHTML={{ __html: JSON.stringify(d) }} />;`)]);
    expect(safe.filter((h) => h.rule === "owasp/xss-dangerously-set-inner-html")).toHaveLength(0);
    expect(unsafe.filter((h) => h.rule === "owasp/xss-dangerously-set-inner-html")).toHaveLength(1);
  });
});
