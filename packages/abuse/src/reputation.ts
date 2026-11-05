import { selectAdapter } from "@forge/shared";

export interface UrlReputation {
  readonly name: string;
  /** Returns threat types for URLs known to be malicious (empty when clean). */
  check(urls: string[]): Promise<Array<{ url: string; threats: string[] }>>;
}

/** Google Safe Browsing v4 threatMatches:find. */
export class SafeBrowsingReputation implements UrlReputation {
  readonly name = "safebrowsing";
  constructor(private readonly apiKey: string) {}
  async check(urls: string[]) {
    if (!urls.length) return [];
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "forge", clientVersion: "1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: urls.slice(0, 500).map((url) => ({ url })),
        },
      }),
    });
    if (!res.ok) throw new Error(`Safe Browsing ${res.status}`);
    const data = (await res.json()) as { matches?: Array<{ threat: { url: string }; threatType: string }> };
    const by = new Map<string, string[]>();
    for (const m of data.matches ?? []) by.set(m.threat.url, [...(by.get(m.threat.url) ?? []), m.threatType]);
    return [...by.entries()].map(([url, threats]) => ({ url, threats }));
  }
}

/** Offline reputation: a local blocklist of hosts (env ABUSE_BLOCKLIST, comma separated). */
export class MockUrlReputation implements UrlReputation {
  readonly name = "mock";
  constructor(private readonly blocked: string[] = (process.env.ABUSE_BLOCKLIST ?? "").split(",").filter(Boolean)) {}
  async check(urls: string[]) {
    return urls.filter((u) => this.blocked.some((b) => u.includes(b))).map((url) => ({ url, threats: ["BLOCKLIST"] }));
  }
}

export function createUrlReputation(): UrlReputation {
  const key = process.env.SAFE_BROWSING_API_KEY;
  return selectAdapter<UrlReputation>("URL_REPUTATION_PROVIDER", { safebrowsing: () => new SafeBrowsingReputation(key ?? ""), mock: () => new MockUrlReputation() }, key ? "safebrowsing" : "mock").instance;
}

export function extractUrls(files: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const c of Object.values(files)) for (const m of c.matchAll(/https?:\/\/[^\s"'<>)]+/g)) out.add(m[0]);
  return [...out];
}
