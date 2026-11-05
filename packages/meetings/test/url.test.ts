import { describe, it, expect } from "vitest";
import { findMeetingUrl, parseMeetingUrl } from "../src/url.js";

describe("parseMeetingUrl", () => {
  it("parses Zoom links", () => {
    expect(parseMeetingUrl("https://us02web.zoom.us/j/85012345678?pwd=bXlTZWNyZXRQYXNz.1")).toEqual({
      platform: "zoom",
      nativeId: "85012345678",
      passcode: "bXlTZWNyZXRQYXNz.1",
      url: "https://us02web.zoom.us/j/85012345678?pwd=bXlTZWNyZXRQYXNz.1",
    });
    expect(parseMeetingUrl("https://zoom.us/j/123456789")).toMatchObject({ platform: "zoom", nativeId: "123456789" });
    expect(parseMeetingUrl("zoom.us/j/1234567890")).toMatchObject({ nativeId: "1234567890" });
    expect(parseMeetingUrl("https://acme.zoom.us/w/98765432101?tk=abc")).toMatchObject({ nativeId: "98765432101" });
    expect(parseMeetingUrl("https://zoom.us/wc/join/85012345678")).toMatchObject({ nativeId: "85012345678" });
    expect(parseMeetingUrl("https://zoom.us/wc/85012345678/join?pwd=x")).toMatchObject({ nativeId: "85012345678", passcode: "x" });
    expect(parseMeetingUrl("https://acme.zoom.us/my/anna.svensson")).toMatchObject({ platform: "zoom", nativeId: "anna.svensson" });
    expect(parseMeetingUrl("zoommtg://zoom.us/join?action=join&confno=85012345678&pwd=abc")).toMatchObject({ platform: "zoom", nativeId: "85012345678", passcode: "abc" });
    expect(parseMeetingUrl("https://acme.zoom.com/j/85012345678")).toMatchObject({ platform: "zoom" });
  });

  it("parses Teams links (classic meetup-join and new /meet/ format)", () => {
    const classic =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA4ZGE3YTAtYjQ4Ny00MmFhLWI0ZTEtYzM2ZWQ0N2E0ZmFm%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%2c%22Oid%22%3a%22a1b2%22%7d";
    expect(parseMeetingUrl(classic)).toMatchObject({ platform: "teams", nativeId: "19:meeting_NjA4ZGE3YTAtYjQ4Ny00MmFhLWI0ZTEtYzM2ZWQ0N2E0ZmFm@thread.v2" });
    expect(parseMeetingUrl("https://teams.microsoft.com/meet/3512345678901?p=AbCdEfGh12")).toEqual({
      platform: "teams",
      nativeId: "3512345678901",
      passcode: "AbCdEfGh12",
      url: "https://teams.microsoft.com/meet/3512345678901?p=AbCdEfGh12",
    });
    expect(parseMeetingUrl("https://teams.live.com/meet/9876543210123?p=xyz")).toMatchObject({ platform: "teams", nativeId: "9876543210123", passcode: "xyz" });
  });

  it("parses Google Meet links", () => {
    expect(parseMeetingUrl("https://meet.google.com/abc-defg-hij?authuser=1&hs=122")).toEqual({ platform: "google_meet", nativeId: "abc-defg-hij", url: "https://meet.google.com/abc-defg-hij" });
    expect(parseMeetingUrl("meet.google.com/ABC-DEFG-HIJ")).toMatchObject({ nativeId: "abc-defg-hij" });
  });

  it("rejects unsupported or malformed links", () => {
    for (const bad of ["https://example.com/j/123456789", "https://zoom.us/j/abc", "https://meet.google.com/abcdefghij", "https://teams.microsoft.com/l/chat/0/0", "not a url at all ::", "https://meet.google.com/"]) {
      expect(() => parseMeetingUrl(bad), bad).toThrow();
    }
  });

  it("finds meeting links in free text", () => {
    expect(findMeetingUrl("Join: https://example.com/x then https://meet.google.com/abc-defg-hij.")).toBe("https://meet.google.com/abc-defg-hij");
    expect(findMeetingUrl("Location: Konferensrum 2")).toBeUndefined();
    expect(findMeetingUrl(undefined)).toBeUndefined();
  });
});
