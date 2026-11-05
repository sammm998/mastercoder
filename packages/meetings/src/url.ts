import { ForgeError } from "@forge/shared";
import type { ParsedMeetingUrl } from "./types.js";

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Parse Zoom, Microsoft Teams and Google Meet join links.
 *  zoom:  https://us02web.zoom.us/j/85012345678?pwd=…  · https://zoom.us/j/…  · https://acme.zoom.us/my/anna
 *         https://zoom.us/wc/join/…  · https://zoom.us/s/…  · zoommtg://zoom.us/join?confno=…&pwd=…  · *.zoom.com, zoomgov.com
 *  teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_…%40thread.v2/0?context=…
 *         https://teams.microsoft.com/meet/<id>?p=<passcode>  · https://teams.live.com/meet/<id>?p=…
 *  meet:  https://meet.google.com/abc-defg-hij
 */
export function parseMeetingUrl(raw: string): ParsedMeetingUrl {
  const input = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ForgeError("BAD_INPUT", `Not a URL: ${input.slice(0, 200)}`);
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  // ---- Zoom
  if (u.protocol === "zoommtg:" || u.protocol === "zoomus:") {
    const id = u.searchParams.get("confno");
    if (!id || !/^\d{9,12}$/.test(id)) throw new ForgeError("BAD_INPUT", "Zoom app link without a valid confno");
    const pwd = u.searchParams.get("pwd");
    return withPass({ platform: "zoom", nativeId: id, url: `https://zoom.us/j/${id}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}` }, pwd);
  }
  if (/(^|\.)zoom(gov)?\.(us|com)$/.test(host)) {
    const pwd = u.searchParams.get("pwd");
    let id: string | undefined;
    const i = parts.findIndex((p) => p === "j" || p === "s" || p === "w");
    if (i >= 0) id = parts[i + 1];
    else if (parts[0] === "wc" && parts[1] === "join") id = parts[2];
    else if (parts[0] === "wc" && parts[2] === "join") id = parts[1];
    else if (parts[0] === "my" && parts[1]) {
      const name = parts[1].toLowerCase();
      if (!/^[a-z0-9._-]{1,64}$/.test(name)) throw new ForgeError("BAD_INPUT", "Invalid Zoom personal link");
      return withPass({ platform: "zoom", nativeId: name, url: `https://${host}/my/${name}` }, pwd);
    }
    if (!id || !/^\d{9,12}$/.test(id)) throw new ForgeError("BAD_INPUT", `Unrecognized Zoom link: ${input.slice(0, 200)}`);
    return withPass({ platform: "zoom", nativeId: id, url: `https://${host}/j/${id}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}` }, pwd);
  }

  // ---- Microsoft Teams
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com") || host === "teams.microsoft.us" || host === "gov.teams.microsoft.us") {
    if (parts[0] === "l" && parts[1] === "meetup-join" && parts[2]) {
      const thread = decodeURIComponent(parts[2]);
      if (!/^19:meeting_[A-Za-z0-9_-]+@thread\.(v2|skype|tacv2)$/.test(thread)) throw new ForgeError("BAD_INPUT", "Unrecognized Teams meeting thread id");
      return { platform: "teams", nativeId: thread, url: u.toString() };
    }
    const mi = parts.indexOf("meet");
    if (mi >= 0 && parts[mi + 1] && /^\d{9,20}$/.test(parts[mi + 1] as string)) {
      const id = parts[mi + 1] as string;
      const p = u.searchParams.get("p");
      return withPass({ platform: "teams", nativeId: id, url: `https://${host}/meet/${id}${p ? `?p=${encodeURIComponent(p)}` : ""}` }, p);
    }
    throw new ForgeError("BAD_INPUT", `Unrecognized Teams link: ${input.slice(0, 200)}`);
  }

  // ---- Google Meet
  if (host === "meet.google.com") {
    const code = (parts[0] === "lookup" ? parts[1] : parts[0])?.toLowerCase();
    if (!code || !MEET_CODE.test(code)) throw new ForgeError("BAD_INPUT", `Unrecognized Google Meet link: ${input.slice(0, 200)}`);
    return { platform: "google_meet", nativeId: code, url: `https://meet.google.com/${code}` };
  }

  throw new ForgeError("BAD_INPUT", `Unsupported meeting platform: ${host}`);
}

function withPass(r: ParsedMeetingUrl, pass: string | null): ParsedMeetingUrl {
  return pass ? { ...r, passcode: pass } : r;
}

/** Find the first Zoom/Teams/Meet join URL inside free text (calendar location/description). */
export function findMeetingUrl(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const re = /(https:\/\/[^\s<>"')\]]+|zoommtg:\/\/[^\s<>"')\]]+)/g;
  for (const m of text.matchAll(re)) {
    const candidate = (m[1] as string).replace(/[.,;]+$/, "");
    try {
      parseMeetingUrl(candidate);
      return candidate;
    } catch {
      /* not a meeting link */
    }
  }
  return undefined;
}
