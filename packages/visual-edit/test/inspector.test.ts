// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { install, describe as describeEl } from "../src/inspector/inspector.js";
import { isSelectMessage, isParentMessage, parseSrc, selectorForSrc, srcFromSelector, formatSrc } from "../src/protocol.js";

/** jsdom has no parent frame; fake one so the inspector posts to a spy and accepts its messages. */
function framed() {
  const parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  return parent;
}

function send(data: unknown, source: unknown = window.parent) {
  window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
}

beforeEach(() => {
  window.__forgeInspector?.destroy();
  document.body.innerHTML = `
    <main data-forge-src="src/App.tsx:3:5">
      <h1 data-forge-src="src/App.tsx:4:7" class="title big" style="color: rgb(255, 0, 0)">Hello <em>world</em></h1>
      <a data-forge-src="src/App.tsx:5:7" href="/go"><span>no tag</span></a>
      <img data-forge-src="src/App.tsx:6:7" src="/a.png" alt="A" />
    </main>`;
});

describe("inspector", () => {
  it("announces itself and ignores clicks until inspect mode is on", () => {
    const parent = framed();
    install();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "forge:ready", version: 1 }, "*");
    document.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it("selects the nearest tagged element on click and prevents navigation", () => {
    const parent = framed();
    install();
    send({ type: "forge:inspect", enabled: true });
    const span = document.querySelector("a span")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    span.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const msg = parent.postMessage.mock.calls.at(-1)![0];
    expect(isSelectMessage(msg)).toBe(true);
    expect(msg).toMatchObject({ type: "forge:select", src: "src/App.tsx:5:7", tag: "a", attrs: { href: "/go" }, hasDirectText: false, text: "no tag" });
  });

  it("reports direct text, classes and computed styles", () => {
    const m = describeEl(document.querySelector("h1")!);
    expect(m.text).toBe("Hello");
    expect(m.hasDirectText).toBe(true);
    expect(m.classes).toEqual(["title", "big"]);
    expect(m.styles.color).toBe("rgb(255, 0, 0)");
    expect(describeEl(document.querySelector("img")!).attrs).toEqual({ src: "/a.png", alt: "A" });
  });

  it("highlights by src and ignores messages from other windows", () => {
    framed();
    install();
    send({ type: "forge:highlight", src: "src/App.tsx:6:7" });
    expect(document.getElementById("forge-inspector-selected")!.style.display).toBe("block");
    send({ type: "forge:highlight", src: null });
    expect(document.getElementById("forge-inspector-selected")!.style.display).toBe("none");
    send({ type: "forge:inspect", enabled: true }, window);
    expect(window.__forgeInspector!.enabled).toBe(false);
  });

  it("cleans up on destroy", () => {
    framed();
    install().destroy();
    expect(document.getElementById("forge-inspector-hover")).toBeNull();
    expect(window.__forgeInspector).toBeUndefined();
  });
});

describe("protocol", () => {
  it("parses and formats src locations safely", () => {
    expect(parseSrc("src/App.tsx:12:5")).toEqual({ path: "src/App.tsx", line: 12, column: 5 });
    expect(formatSrc({ path: "a/b.tsx", line: 1, column: 2 })).toBe("a/b.tsx:1:2");
    expect(parseSrc("./src/a.tsx:1:1")?.path).toBe("src/a.tsx");
    expect(parseSrc("../etc/passwd:1:1")).toBeNull();
    expect(parseSrc("/abs.tsx:1:1")).toBeNull();
    expect(parseSrc("src/a.tsx:0:1")).toBeNull();
    expect(parseSrc("nonsense")).toBeNull();
  });

  it("round-trips comment selectors", () => {
    const sel = selectorForSrc('src/we"ird.tsx:1:1');
    expect(srcFromSelector(sel)).toBe('src/we"ird.tsx:1:1');
    expect(srcFromSelector(".random")).toBeNull();
  });

  it("validates parent messages", () => {
    expect(isParentMessage({ type: "forge:inspect", enabled: true })).toBe(true);
    expect(isParentMessage({ type: "forge:highlight", src: null })).toBe(true);
    expect(isParentMessage({ type: "forge:highlight", src: 3 })).toBe(false);
    expect(isParentMessage({ type: "other" })).toBe(false);
    expect(isSelectMessage({ type: "forge:select", src: "x" })).toBe(false);
  });
});
