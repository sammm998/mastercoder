import type { DesignBriefInput } from "../src/types.js";

/** The three benchmark briefs used by the site integration test (Definition of Done #5). */
export const BENCHMARK_BRIEFS: Array<{ id: string; kind: "landing" | "portfolio"; brief: DesignBriefInput; sections?: string[] }> = [
  {
    id: "ebike-landing",
    kind: "landing",
    brief: {
      name: "Volta",
      kind: "landing",
      description:
        "Volta makes lightweight electric bikes for city commuters, with 120 km range, 19 kg frame and 4 h charge. Launch page for the new Volta One with a 3D hero.",
      industry: "Electric bikes",
      audience: "urban commuters",
      keywords: ["electric", "mobility", "urban"],
      tone: ["bold", "futuristic"],
      features: ["3d hero", "scroll storytelling"],
      locale: "en",
    },
    sections: ["hero-3d", "statement", "features", "story", "stats", "marquee", "cta"],
  },
  {
    id: "architect-portfolio",
    kind: "portfolio",
    brief: {
      name: "Halden Arkitekter",
      kind: "portfolio",
      description:
        "Halden is a small Stockholm architecture studio designing low-carbon homes, libraries and timber retrofits. Portfolio with scroll storytelling through selected projects.",
      industry: "Architecture studio",
      audience: "private clients and municipalities",
      keywords: ["architecture", "portfolio", "nordic", "minimal"],
      tone: ["calm", "editorial"],
      features: ["scroll storytelling", "image distortion", "page transitions"],
      locale: "en",
    },
  },
  {
    id: "fintech-launch",
    kind: "landing",
    brief: {
      name: "Ledgerline",
      kind: "landing",
      description:
        "Ledgerline is a business account and payments platform for European startups, with payouts to 38 countries, 0.4% FX fee and 99.95% uptime. Launch page with horizontal scroll and split text.",
      industry: "Business payments",
      audience: "startup finance teams",
      keywords: ["fintech", "payments", "launch"],
      tone: ["precise", "trust"],
      features: ["horizontal scroll", "split text"],
      locale: "en",
    },
    sections: ["hero-type", "statement", "horizontal", "features", "stats", "marquee", "cta"],
  },
];
