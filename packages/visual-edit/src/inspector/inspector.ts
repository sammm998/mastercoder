/**
 * Preview inspector. Runs inside the generated app (dev only) and talks to the Forge workspace that
 * embeds the preview in an iframe:
 *  - hover outlines the nearest element tagged with data-forge-src
 *  - click selects it and posts { type: "forge:select", src, tag, text, styles, ... } to the parent
 *  - listens for { type: "forge:highlight", src } and { type: "forge:inspect", enabled }
 * Only messages from window.parent are accepted. Nothing runs when the page isn't framed.
 */
import { PROTOCOL_VERSION, SRC_ATTR, isParentMessage, type ForgeSelectMessage, type InspectedStyles } from "../protocol.js";

declare global {
  interface Window {
    __forgeInspector?: { enabled: boolean; destroy(): void };
  }
}

const ACCENT = "#ff6a2b";

function makeBox(id: string, dashed: boolean): HTMLDivElement {
  const d = document.createElement("div");
  d.id = id;
  d.setAttribute("aria-hidden", "true");
  Object.assign(d.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483646",
    border: `2px ${dashed ? "dashed" : "solid"} ${ACCENT}`,
    borderRadius: "3px",
    background: dashed ? "transparent" : "rgba(255,106,43,0.08)",
    display: "none",
    transition: "all 80ms ease-out",
  } satisfies Partial<CSSStyleDeclaration>);
  return d;
}

function makeLabel(): HTMLDivElement {
  const d = document.createElement("div");
  d.setAttribute("aria-hidden", "true");
  Object.assign(d.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    background: ACCENT,
    color: "#17140f",
    font: "500 11px/1.4 ui-monospace, Menlo, monospace",
    padding: "2px 6px",
    borderRadius: "3px",
    display: "none",
    whiteSpace: "nowrap",
  } satisfies Partial<CSSStyleDeclaration>);
  return d;
}

function tagged(el: EventTarget | null): HTMLElement | null {
  let n = el instanceof Element ? el : null;
  while (n && !n.hasAttribute(SRC_ATTR)) n = n.parentElement;
  return n instanceof HTMLElement || n instanceof SVGElement ? (n as HTMLElement) : null;
}

function place(box: HTMLElement, el: Element) {
  const r = el.getBoundingClientRect();
  Object.assign(box.style, { display: "block", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
}

function directText(el: Element): string {
  let out = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) out += n.textContent ?? "";
  return out.replace(/\s+/g, " ").trim();
}

function stylesOf(el: Element): InspectedStyles {
  const cs = getComputedStyle(el);
  return {
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    padding: cs.padding,
    margin: cs.margin,
    borderRadius: cs.borderRadius,
  };
}

export function describe(el: HTMLElement): ForgeSelectMessage {
  const r = el.getBoundingClientRect();
  const own = directText(el);
  const attrs: ForgeSelectMessage["attrs"] = {};
  for (const name of ["src", "alt", "href"] as const) {
    const v = el.getAttribute(name);
    if (v !== null) attrs[name] = v;
  }
  return {
    type: "forge:select",
    src: el.getAttribute(SRC_ATTR) ?? "",
    tag: el.tagName.toLowerCase(),
    text: (own || (el.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, 2000),
    hasDirectText: own.length > 0,
    classes: Array.from(el.classList),
    attrs,
    styles: stylesOf(el),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

export function install(win: Window = window): { enabled: boolean; destroy(): void } {
  if (win.__forgeInspector) return win.__forgeInspector;
  const doc = win.document;
  const hover = makeBox("forge-inspector-hover", true);
  const selected = makeBox("forge-inspector-selected", false);
  const label = makeLabel();
  let selectedEl: Element | null = null;
  const state = { enabled: false, destroy };

  const mount = () => doc.body?.append(hover, selected, label);
  if (doc.body) mount();
  else doc.addEventListener("DOMContentLoaded", mount, { once: true });

  const post = (msg: unknown) => win.parent.postMessage(msg, "*");

  function onMove(e: MouseEvent) {
    if (!state.enabled) return;
    const el = tagged(e.target);
    if (!el) {
      hover.style.display = "none";
      label.style.display = "none";
      return;
    }
    place(hover, el);
    const r = el.getBoundingClientRect();
    label.textContent = `<${el.tagName.toLowerCase()}>  ${el.getAttribute(SRC_ATTR)}`;
    Object.assign(label.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${Math.max(0, r.top - 20)}px` });
  }

  function onClick(e: MouseEvent) {
    if (!state.enabled) return;
    const el = tagged(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    selectedEl = el;
    place(selected, el);
    post(describe(el));
  }

  function reposition() {
    if (selectedEl && selectedEl.isConnected) place(selected, selectedEl);
    else selected.style.display = "none";
  }

  function onMessage(e: MessageEvent) {
    if (e.source !== win.parent || !isParentMessage(e.data)) return;
    if (e.data.type === "forge:inspect") {
      state.enabled = e.data.enabled;
      doc.documentElement.style.cursor = state.enabled ? "crosshair" : "";
      if (!state.enabled) {
        hover.style.display = "none";
        label.style.display = "none";
      }
    } else {
      const src = e.data.src;
      selectedEl = src ? (Array.from(doc.querySelectorAll(`[${SRC_ATTR}]`)).find((n) => n.getAttribute(SRC_ATTR) === src) ?? null) : null;
      if (selectedEl) {
        selectedEl.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        place(selected, selectedEl);
      } else selected.style.display = "none";
    }
  }

  function destroy() {
    doc.removeEventListener("mousemove", onMove, true);
    doc.removeEventListener("click", onClick, true);
    win.removeEventListener("message", onMessage);
    win.removeEventListener("scroll", reposition, true);
    win.removeEventListener("resize", reposition);
    hover.remove();
    selected.remove();
    label.remove();
    delete win.__forgeInspector;
  }

  doc.addEventListener("mousemove", onMove, true);
  doc.addEventListener("click", onClick, true);
  win.addEventListener("message", onMessage);
  win.addEventListener("scroll", reposition, true);
  win.addEventListener("resize", reposition);
  win.__forgeInspector = state;
  post({ type: "forge:ready", version: PROTOCOL_VERSION });
  return state;
}

if (typeof window !== "undefined" && window.parent !== window) install();
