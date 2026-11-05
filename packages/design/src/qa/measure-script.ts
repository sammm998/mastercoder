/**
 * In-page measurement scripts for the heuristic critic. Kept as plain JavaScript strings (evaluated with
 * page.evaluate) so no TS/bundler helpers leak into the browser.
 */

/** Installed before navigation: accumulates CLS (layout shifts without recent input). */
export const CLS_INIT_SCRIPT = String.raw`
window.__forgeCLS = 0;
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__forgeCLS += e.value;
  }).observe({ type: "layout-shift", buffered: true });
} catch (e) {}
`;

/**
 * Full measurement: a function expression taking the *requested* viewport width (mobile emulation widens
 * the layout viewport when content overflows, so window.innerWidth cannot be trusted for that check).
 */
export const MEASURE_FN = String.raw`((expectedWidth) => {
  const vw = expectedWidth || window.innerWidth;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    return op > 0.1 ? op : false;
  };
  const rootBg = (() => { const b = rgba(getComputedStyle(document.body).backgroundColor); if (b[3] > 0.5) return b; const h = rgba(getComputedStyle(document.documentElement).backgroundColor); return h[3] > 0.5 ? h : [255, 255, 255, 1]; })();
  const backgroundOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; }
    }
    let bg = rootBg;
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };

  // ---- contrast
  const textEls = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!t.textContent || !t.textContent.trim()) continue;
    const el = t.parentElement;
    if (!el || seen.has(el) || el.closest("script,style,noscript,canvas")) continue;
    seen.add(el);
    textEls.push(el);
  }
  let checked = 0, failing = 0, unknown = 0, minRatio = 21;
  const failures = [];
  const families = new Map();
  for (const el of textEls) {
    const op = visible(el);
    if (!op) continue;
    const cs = getComputedStyle(el);
    const fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    families.set(fam, (families.get(fam) || 0) + 1);
    const bg = backgroundOf(el);
    if (!bg) { unknown++; continue; }
    const fg = rgba(cs.color);
    const text = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const r = ratio(text, bg);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const required = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    checked++;
    minRatio = Math.min(minRatio, r);
    if (r + 0.01 < required) {
      failing++;
      if (failures.length < 12) failures.push({ text: el.textContent.trim().slice(0, 60), ratio: Math.round(r * 100) / 100, required, viewport: vw });
    }
  }

  // ---- spacing scale (resolve tokens through a probe element)
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const resolve = (v) => { probe.style.marginTop = "0px"; probe.style.marginTop = v; return parseFloat(getComputedStyle(probe).marginTop) || 0; };
  const tokens = [];
  for (let i = 1; i <= 10; i++) { const v = resolve("var(--space-" + i + ")"); if (v > 0) tokens.push(v); }
  const extras = ["var(--grid-margin)", "var(--grid-gutter)"].map(resolve).filter((v) => v > 0);
  probe.remove();
  const base = tokens.length ? tokens.concat(extras) : [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
  const scale = new Set(base.map((v) => Math.round(v)));
  for (const a of base) for (const b of base) scale.add(Math.round(a + b));
  const scaleArr = Array.from(scale).sort((a, b) => a - b);
  const onScaleVal = (v) => scaleArr.some((s) => Math.abs(s - v) <= Math.max(1, s * 0.03)) || (!tokens.length && v % 4 === 0);
  let samples = 0, onScale = 0;
  const off = new Map();
  const all = Array.from(document.body.querySelectorAll("*")).slice(0, 2500);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "inline" || cs.position === "fixed") continue;
    const vals = [cs.paddingTop, cs.paddingBottom, cs.paddingLeft, cs.paddingRight, cs.marginTop, cs.marginBottom, cs.rowGap, cs.columnGap];
    const ml = parseFloat(cs.marginLeft), mr = parseFloat(cs.marginRight);
    if (!(Math.abs(ml - mr) < 1 && ml > 0)) vals.push(cs.marginLeft, cs.marginRight);
    for (const raw of vals) {
      const v = Math.abs(parseFloat(raw));
      if (!v || v < 2 || !isFinite(v) || v > 400) continue;
      samples++;
      if (onScaleVal(v)) onScale++; else off.set(Math.round(v), (off.get(Math.round(v)) || 0) + 1);
    }
  }
  const offScaleExamples = Array.from(off.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);

  // ---- headings
  const hs = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  const levels = hs.map((h) => Number(h.tagName[1]));
  let skips = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) skips++;
  if (levels.length && levels[0] !== 1) skips++;
  const bodySize = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  const h1 = document.querySelector("h1");
  const h1Size = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
  const maxDisplayPx = hs.reduce((m, h) => Math.max(m, parseFloat(getComputedStyle(h).fontSize) || 0), 0);
  const centered = hs.filter((h) => getComputedStyle(h).textAlign === "center").length;

  // ---- motion (stylesheet scan + live state)
  let animationRules = 0, transitionRules = 0, guards = 0;
  const layoutAnims = new Set();
  const LAYOUT = /(^|,|\s)(width|height|top|left|right|bottom|margin[a-z-]*|padding[a-z-]*|font-size|all)(\s|,|$)/;
  const scan = (rules, inReduced) => {
    for (const rule of rules) {
      if (rule.media && rule.cssRules) {
        const media = rule.media.mediaText || "";
        if (/prefers-reduced-motion/.test(media)) guards++;
        scan(rule.cssRules, inReduced || /reduced-motion:\s*reduce/.test(media));
        continue;
      }
      if (rule.type === 7 && rule.cssRules) {
        for (const kf of rule.cssRules) for (let i = 0; i < kf.style.length; i++) { const p = kf.style[i]; if (!/^(transform|opacity|translate|scale|rotate|filter|clip-path|offset.*|color|background-color|fill|stroke.*)$/.test(p)) layoutAnims.add("@keyframes " + rule.name + " " + p); }
        continue;
      }
      if (rule.cssRules && !rule.style) { scan(rule.cssRules, inReduced); continue; }
      if (!rule.style) continue;
      // Shorthands containing var() leave longhands empty in CSSOM, so read the declaration text.
      const text = rule.style.cssText || "";
      const anim = /(?:^|;|\s)animation(?:-name)?\s*:\s*([^;]+)/.exec(text);
      if (anim && !/^\s*none\s*$/.test(anim[1])) animationRules++;
      const tr = /(?:^|;|\s)transition(?:-property)?\s*:\s*([^;]+)/.exec(text);
      if (tr && !/^\s*none\s*$/.test(tr[1])) {
        transitionRules++;
        const props = tr[1].split(",").map((part) => part.trim().split(/\s+/)[0]);
        const bad = props.filter((p) => LAYOUT.test(" " + p + " "));
        if (bad.length && !inReduced) layoutAnims.add((rule.selectorText || "?") + " transition " + bad.join(","));
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) { try { scan(sheet.cssRules, false); } catch (e) {} }
  const running = document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : 0;
  const motionEls = Array.from(document.querySelectorAll("[data-motion]")).filter((e) => e.getAttribute("data-motion") !== "static");
  const canvases = Array.from(document.querySelectorAll("canvas")).filter((c) => c.getBoundingClientRect().width > 10);
  const scrollTrigger = !!document.querySelector(".pin-spacer, [data-motion='scrolltrigger']");
  const webgl = canvases.length > 0 || !!document.querySelector("[data-motion='webgl']");

  // ---- overflow + tap targets
  const offenders = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || (r.right <= vw + 1 && r.left >= -1)) continue;
    let contained = false;
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o !== "visible") { contained = true; break; }
    }
    if (!contained && getComputedStyle(el).position !== "fixed") offenders.push(el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""));
    if (offenders.length > 10) break;
  }
  const targets = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,summary,[role=button]"));
  let tChecked = 0, tooSmall = 0;
  const tExamples = [];
  for (const t of targets) {
    const r = t.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (t.closest("p") && t.tagName === "A") continue; // inline links are exempt (WCAG 2.5.8)
    const cs = getComputedStyle(t);
    if (cs.visibility === "hidden") continue;
    tChecked++;
    if (r.width < 24 || r.height < 24) { tooSmall++; if (tExamples.length < 6) tExamples.push((t.textContent || t.getAttribute("aria-label") || t.tagName).trim().slice(0, 30) + " " + Math.round(r.width) + "x" + Math.round(r.height)); }
  }

  // ---- images
  const imgs = Array.from(document.querySelectorAll("img"));
  const missingAlt = imgs.filter((i) => !i.hasAttribute("alt")).length + Array.from(document.querySelectorAll("svg[role=img]")).filter((s) => !s.getAttribute("aria-label") && !s.querySelector("title")).length;

  // ---- rhythm
  const main = document.querySelector("main") || document.body;
  const sections = Array.from(main.querySelectorAll(":scope > section, :scope > article, :scope > div > section"));
  // The opening hero is intentionally its own scale; rhythm is measured on the sections after it.
  const paddings = sections.slice(1).map((s) => { const cs = getComputedStyle(s); return parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom); }).filter((v) => v > 0);
  const beats = new Set(paddings.map((v) => Math.round(v / 8))).size;
  const mean = paddings.reduce((a, b) => a + b, 0) / (paddings.length || 1);
  const sd = Math.sqrt(paddings.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (paddings.length || 1));
  const lineChars = [];
  for (const p of Array.from(document.querySelectorAll("main p"))) {
    const txt = (p.textContent || "").trim();
    if (txt.length < 80 || !visible(p)) continue;
    const cs = getComputedStyle(p);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const lines = Math.max(1, Math.round(p.getBoundingClientRect().height / lh));
    lineChars.push(txt.length / lines);
  }
  lineChars.sort((a, b) => a - b);
  const bcs = getComputedStyle(document.body);
  const bodyLineHeight = (parseFloat(bcs.lineHeight) || 0) / (parseFloat(bcs.fontSize) || 16);
  const patterns = Array.from(document.querySelectorAll("[data-pattern]")).map((e) => e.getAttribute("data-pattern"));
  const webFontsLoaded = document.fonts ? Array.from(new Set(Array.from(document.fonts).filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")))) : [];

  return {
    viewport: vw,
    contrast: { checked, failing, unknownBackground: unknown, minRatio: checked ? Math.round(minRatio * 100) / 100 : 0, failures },
    spacing: { samples, onScale, ratio: samples ? onScale / samples : 1, scale: scaleArr.slice(0, 40), offScaleExamples },
    fonts: { families: Array.from(families.keys()), count: families.size, webFontsLoaded },
    headings: { levels, h1Count: levels.filter((l) => l === 1).length, skips, h1ToBodyRatio: h1Size / bodySize, maxDisplayPx },
    cls: window.__forgeCLS || 0,
    motion: { animationRules, transitionRules, reducedMotionGuards: guards, runningAnimations: running, scrollTrigger, webgl, canvases: canvases.length, activeMotionElements: motionEls.length, layoutAnimations: Array.from(layoutAnims).slice(0, 10) },
    overflow: { scrollWidth: Math.max(document.documentElement.scrollWidth, window.innerWidth), viewport: vw, offenders },
    tapTargets: { checked: tChecked, tooSmall, examples: tExamples },
    images: { total: imgs.length, missingAlt },
    rhythm: { sectionPaddings: paddings, beats, cv: mean ? sd / mean : 0, medianLineChars: lineChars.length ? lineChars[Math.floor(lineChars.length / 2)] : 0, bodyLineHeight },
    layout: { sections: sections.length, patterns, centeredHeadingRatio: hs.length ? centered / hs.length : 0 },
  };
})`;

export const measureExpression = (width: number) => `${MEASURE_FN}(${Math.round(width)})`;

/**
 * Scroll through the page step by step so scroll-triggered content reveals. Waits for the real scroll
 * position at each step (smooth-scroll libraries such as Lenis interpolate towards the target).
 */
export const AUTOSCROLL_SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async (target) => {
    const t0 = performance.now();
    while (performance.now() - t0 < 900) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (Math.abs(window.scrollY - Math.min(target, max)) < 4) break;
      await sleep(40);
    }
  };
  let y = 0, guard = 0;
  while (y < document.documentElement.scrollHeight - window.innerHeight && guard++ < 300) {
    y += Math.round(window.innerHeight * 0.6);
    window.scrollTo(0, y);
    await settle(y);
    await sleep(80);
  }
  await sleep(500);
  window.scrollTo(0, 0);
  await settle(0);
  await sleep(300);
  return document.documentElement.scrollHeight;
})()`;
