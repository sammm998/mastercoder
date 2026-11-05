import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Verify Slack's v0 request signature (rejects requests older than 5 minutes). */
export function verifySlackSignature(signingSecret: string, timestamp: string, rawBody: string, signature: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SlackEnvelope = z.union([
  z.object({ type: z.literal("url_verification"), challenge: z.string() }),
  z.object({
    type: z.literal("event_callback"),
    team_id: z.string().optional(),
    event: z.object({ type: z.string(), text: z.string().default(""), channel: z.string().optional(), user: z.string().optional(), ts: z.string().optional(), thread_ts: z.string().optional(), bot_id: z.string().optional() }),
  }),
]);

export type SlackAction = { kind: "challenge"; challenge: string } | { kind: "run"; input: { text: string; channel: string; user: string; threadTs: string } } | { kind: "ignore"; reason: string };

/** Map a Slack Events API payload to what the agent should do. Ignores bot messages (no loops). */
export function handleSlackEvent(payload: unknown, opts: { onlyChannel?: string } = {}): SlackAction {
  const p = SlackEnvelope.safeParse(payload);
  if (!p.success) return { kind: "ignore", reason: "unrecognised payload" };
  if (p.data.type === "url_verification") return { kind: "challenge", challenge: p.data.challenge };
  const e = p.data.event;
  if (e.bot_id) return { kind: "ignore", reason: "bot message" };
  if (e.type !== "app_mention" && e.type !== "message") return { kind: "ignore", reason: `event ${e.type}` };
  if (!e.channel || !e.user) return { kind: "ignore", reason: "missing channel/user" };
  if (opts.onlyChannel && e.channel !== opts.onlyChannel) return { kind: "ignore", reason: "other channel" };
  return { kind: "run", input: { text: e.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim(), channel: e.channel, user: e.user, threadTs: e.thread_ts ?? e.ts ?? "" } };
}

/**
 * Embeddable web chat widget. Loads with:
 *   <script src="{API}/widget.js" data-agent="agt_..." async></script>
 * Talks to the public, rate-limited widget endpoint (no secrets in the page).
 */
export function widgetScript(apiUrl: string): string {
  return `(()=>{const s=document.currentScript;const agent=s&&s.dataset.agent;if(!agent)return;const api=${JSON.stringify(apiUrl)};
const root=document.createElement("div");root.setAttribute("role","complementary");root.setAttribute("aria-label","Chat");
root.style.cssText="position:fixed;right:20px;bottom:20px;z-index:2147483000;font:14px/1.4 system-ui,sans-serif";
const btn=document.createElement("button");btn.type="button";btn.textContent="Chat";btn.setAttribute("aria-expanded","false");
btn.style.cssText="padding:12px 18px;border-radius:999px;border:0;background:#111;color:#fff;cursor:pointer";
const panel=document.createElement("div");panel.hidden=true;panel.style.cssText="width:320px;max-height:420px;display:flex;flex-direction:column;background:#fff;color:#111;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.2);margin-bottom:10px;overflow:hidden";
const log=document.createElement("div");log.setAttribute("aria-live","polite");log.style.cssText="flex:1;overflow:auto;padding:12px";
const form=document.createElement("form");form.style.cssText="display:flex;border-top:1px solid #eee";
const input=document.createElement("input");input.setAttribute("aria-label","Message");input.style.cssText="flex:1;border:0;padding:12px;font:inherit";
const send=document.createElement("button");send.textContent="Send";send.style.cssText="border:0;background:none;padding:0 14px;cursor:pointer";
form.append(input,send);panel.append(log,form);root.append(panel,btn);document.body.append(root);
let conversation=null;const add=(who,text)=>{const p=document.createElement("p");p.textContent=text;p.style.cssText="margin:0 0 8px;"+(who==="me"?"text-align:right":"");log.append(p);log.scrollTop=log.scrollHeight};
btn.onclick=()=>{panel.hidden=!panel.hidden;btn.setAttribute("aria-expanded",String(!panel.hidden));if(!panel.hidden)input.focus()};
form.onsubmit=async(e)=>{e.preventDefault();const text=input.value.trim();if(!text)return;input.value="";add("me",text);
try{const r=await fetch(api+"/v1/widget/"+agent+"/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:text,conversationId:conversation})});
const d=await r.json();conversation=d.conversationId||conversation;add("bot",d.reply||d.error||"…")}catch{add("bot","Connection problem, try again.")}}})();`;
}

/** Normalised inbound email → agent input (provider webhooks are normalised in apps/api). */
export function emailToInput(e: { from: string; subject: string; text: string }) {
  return { channel: "email", from: e.from, subject: e.subject, text: e.text.slice(0, 20_000) };
}
