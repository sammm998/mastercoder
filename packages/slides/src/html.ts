import type { Deck, DeckTheme, ImageRef, Slide } from "./schema.js";
import { renderChartSvg } from "./chart-svg.js";
import { cssFontStack, escapeHtml as esc, onColor } from "./theme.js";

export interface DeckHtmlOptions {
  /** "present" (interactive, one slide at a time) or "print" (all slides stacked, 1280×720 pages for PDF). */
  mode?: "present" | "print";
  lang?: string;
}

function paragraphs(body: string | undefined, cls = "body"): string {
  if (!body) return "";
  return body
    .split(/\n{2,}/)
    .map((p) => `<p class="${cls}">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function bulletList(items: string[] | undefined): string {
  if (!items?.length) return "";
  return `<ul class="bullets">${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
}

function imageEl(img: ImageRef | undefined, cls: string): string {
  if (!img) return "";
  if (img.url && /^(data:image\/|https?:\/\/)/.test(img.url)) {
    return `<img class="${cls}" src="${esc(img.url)}" alt="${esc(img.alt)}">`;
  }
  // Not resolved (prompt/artifactId only): an explicit placeholder, never a fake image.
  return `<div class="${cls} img-missing" role="img" aria-label="${esc(img.alt)}"><span>${esc(img.alt)}</span><small>image not generated yet</small></div>`;
}

function slideInner(s: Slide, theme: DeckTheme, index: number): string {
  const title = s.title ? `<h2 class="title">${esc(s.title)}</h2>` : "";
  const sub = s.subtitle ? `<p class="subtitle">${esc(s.subtitle)}</p>` : "";
  switch (s.layout) {
    case "title":
      return `<div class="hero"><div class="bar" aria-hidden="true"></div><h1 class="title">${esc(s.title)}</h1>${sub}${paragraphs(s.body)}</div>`;
    case "section":
      return `<div class="sec"><span class="num" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><h2 class="title">${esc(s.title)}</h2>${sub}</div>`;
    case "bullets":
      return `${title}${sub}<div class="content">${bulletList(s.bullets)}${paragraphs(s.body)}</div>`;
    case "two-column": {
      const cols = s.columns?.length ? s.columns : [{ bullets: s.bullets?.slice(0, Math.ceil((s.bullets?.length ?? 0) / 2)) }, { bullets: s.bullets?.slice(Math.ceil((s.bullets?.length ?? 0) / 2)) }];
      return `${title}${sub}<div class="cols">${cols
        .map((c) => `<div class="col">${c.heading ? `<h3>${esc(c.heading)}</h3>` : ""}${bulletList(c.bullets)}${paragraphs(c.body)}</div>`)
        .join("")}</div>`;
    }
    case "image-left":
      return `<div class="split">${imageEl(s.image, "media")}<div class="text">${title}${sub}${bulletList(s.bullets)}${paragraphs(s.body)}</div></div>`;
    case "image-full":
      return `${imageEl(s.image, "bleed")}<div class="overlay">${title}${sub}${paragraphs(s.body)}</div>`;
    case "chart":
      return `${title}${sub}<div class="chart">${s.chart ? renderChartSvg(s.chart, { theme, width: 1100, height: 470 }) : '<p class="body">No chart data provided.</p>'}</div>${paragraphs(s.body, "caption")}`;
    case "quote":
      return s.quote
        ? `<figure class="quote"><blockquote>${esc(s.quote.text)}</blockquote><figcaption>${esc(s.quote.author)}</figcaption></figure>`
        : `${title}${paragraphs(s.body)}`;
    case "stats":
      return `${title}${sub}<div class="stats">${(s.stats ?? []).map((st) => `<div class="stat"><span class="value${st.value.length > 7 ? " long" : ""}">${esc(st.value)}</span><span class="label">${esc(st.label)}</span></div>`).join("")}</div>${paragraphs(s.body, "caption")}`;
    case "timeline": {
      const items = s.timeline?.length ? s.timeline : (s.bullets ?? []).map((b, i) => ({ label: String(i + 1), text: b }));
      return `${title}${sub}<ol class="timeline">${items.map((t) => `<li><span class="dot" aria-hidden="true"></span><span class="tl-label">${esc(t.label)}</span><span class="tl-text">${esc(t.text)}</span></li>`).join("")}</ol>`;
    }
    case "closing":
      return `<div class="closing"><h2 class="title">${esc(s.title)}</h2>${sub}${paragraphs(s.body)}${bulletList(s.bullets)}</div>`;
  }
}

function css(theme: DeckTheme, mode: "present" | "print"): string {
  const c = theme.colors;
  const border = c.border ?? c.muted;
  return `
:root{--bg:${c.bg};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--accent2:${c.accent2};--border:${border};--on-accent:${onColor(c.accent)};
--display:${cssFontStack(theme.fonts.display)};--body:${cssFontStack(theme.fonts.body)}}
*{box-sizing:border-box}
html,body{margin:0;background:${mode === "print" ? c.bg : "#05060a"};color:var(--text);font-family:var(--body)}
.slide{position:relative;container-type:inline-size;overflow:hidden;background:var(--bg);display:flex;flex-direction:column;padding:6cqw 7cqw 5cqw;
  ${mode === "print" ? "width:1280px;height:720px;break-after:page;page-break-after:always;" : "width:min(100vw,calc(100vh * 16 / 9));aspect-ratio:16/9;margin:auto;"}}
.slide>*{position:relative}
.title{font-family:var(--display);font-weight:700;letter-spacing:-.02em;line-height:1.08;margin:0 0 1.6cqw;font-size:3.6cqw}
.subtitle{color:var(--muted);font-size:1.9cqw;margin:0 0 2cqw;line-height:1.35}
.body,.caption{font-size:1.8cqw;line-height:1.5;margin:0 0 1.2cqw;color:var(--text);max-width:70ch}
.caption{color:var(--muted);font-size:1.4cqw}
.bullets{list-style:none;margin:0;padding:0;display:grid;gap:1.8cqw}
.bullets li{font-size:2.4cqw;line-height:1.35;padding-left:2.6cqw;position:relative}
.bullets li::before{content:"";position:absolute;left:0;top:.55em;width:1cqw;height:1cqw;border-radius:.25cqw;background:var(--accent)}
.content{display:grid;gap:2.4cqw;align-content:start;margin-top:1.5cqw}
.l-title{justify-content:center;background:radial-gradient(120% 120% at 85% 10%,color-mix(in srgb,var(--accent) 35%,transparent),transparent 55%),var(--bg)}
.l-title .title{font-size:6.4cqw;max-width:18ch}
.l-title .subtitle{font-size:2.4cqw;max-width:40ch}
.hero .bar{width:9cqw;height:.7cqw;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:1cqw;margin-bottom:2.5cqw}
.l-section{justify-content:center;background:linear-gradient(135deg,var(--surface),var(--bg))}
.sec .num{font-family:var(--display);font-size:11cqw;font-weight:800;line-height:1;color:transparent;-webkit-text-stroke:.18cqw var(--accent)}
.sec .title{font-size:5cqw}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:3cqw;flex:1;align-content:start}
.col{background:var(--surface);border:1px solid var(--border);border-radius:1.4cqw;padding:2.6cqw}
.col h3{font-family:var(--display);font-size:2.2cqw;margin:0 0 1.6cqw;color:var(--accent2)}
.col .bullets li{font-size:1.95cqw}
.l-image-left{padding:0}
.split{display:grid;grid-template-columns:46% 1fr;height:100%}
.split .media{width:100%;height:100%;object-fit:cover}
.split .text{padding:6cqw 5cqw;display:flex;flex-direction:column;justify-content:center}
.l-image-full{padding:0;justify-content:flex-end}
.bleed{position:absolute!important;inset:0;width:100%;height:100%;object-fit:cover}
.overlay{padding:5cqw 7cqw;background:linear-gradient(transparent,color-mix(in srgb,var(--bg) 92%,transparent) 45%)}
.overlay .title{font-size:4.6cqw}
.img-missing{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.8cqw;background:repeating-linear-gradient(45deg,var(--surface),var(--surface) 1cqw,var(--bg) 1cqw,var(--bg) 2cqw);border:.2cqw dashed var(--border);color:var(--muted);text-align:center;padding:3cqw;font-size:1.7cqw}
.img-missing small{font-size:1.2cqw;text-transform:uppercase;letter-spacing:.1em}
.chart{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
.chart svg{width:100%;height:auto;max-height:100%}
.quote{margin:auto 0;padding-left:4cqw;border-left:.6cqw solid var(--accent)}
.quote blockquote{margin:0;font-family:var(--display);font-size:3.6cqw;line-height:1.25;font-weight:600}
.quote blockquote::before{content:"\\201C";color:var(--accent);margin-right:.2em}
.quote figcaption{margin-top:2cqw;color:var(--muted);font-size:1.8cqw}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:2.4cqw;margin:auto 0}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:1.4cqw;padding:3cqw 2.4cqw;display:flex;flex-direction:column;gap:1cqw}
.stat .value{font-family:var(--display);font-size:5.4cqw;font-weight:800;color:var(--accent);line-height:1}
.stat .value.long{font-size:3.2cqw;overflow-wrap:anywhere}
.stat .label{font-size:1.6cqw;color:var(--muted);line-height:1.35}
.timeline{list-style:none;margin:auto 0;padding:3cqw 0 0;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2cqw;position:relative}
.timeline::before{content:"";position:absolute;top:3.6cqw;left:0;right:0;height:.25cqw;background:var(--border)}
.timeline li{display:flex;flex-direction:column;gap:1cqw;padding-top:2.4cqw;position:relative}
.timeline .dot{position:absolute;top:-.1cqw;left:0;width:1.6cqw;height:1.6cqw;border-radius:50%;background:var(--accent);box-shadow:0 0 0 .5cqw var(--bg)}
.tl-label{font-family:var(--display);font-weight:700;font-size:1.9cqw;color:var(--accent2)}
.tl-text{font-size:1.6cqw;line-height:1.4}
.l-closing{justify-content:center;align-items:center;text-align:center;background:radial-gradient(80% 90% at 50% 100%,color-mix(in srgb,var(--accent2) 28%,transparent),transparent 60%),var(--bg)}
.l-closing .title{font-size:5.6cqw}
.l-closing .bullets{justify-items:center}
.l-closing .bullets li::before{display:none}
.l-closing .bullets li{padding:0;color:var(--muted)}
.foot{position:absolute;left:7cqw;right:7cqw;bottom:2cqw;display:flex;justify-content:space-between;font-size:1.05cqw;color:var(--muted)}
.l-image-left .foot,.l-image-full .foot{left:auto;right:3cqw;gap:2cqw}
.notes{display:none}
${mode === "present" ? presentCss() : "@page{size:1280px 720px;margin:0}"}
@media (prefers-reduced-motion:no-preference){.slide.enter{animation:fade .35s ease}@keyframes fade{from{opacity:.0;transform:translateY(6px)}to{opacity:1;transform:none}}}
`;
}

function presentCss(): string {
  return `
body{height:100vh;overflow:hidden;display:flex;flex-direction:column}
.stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
.slide[hidden]{display:none}
.deck:focus{outline:none}
.deck:focus-visible .slide{outline:3px solid var(--accent);outline-offset:-3px}
.controls{position:fixed;bottom:12px;right:12px;display:flex;gap:6px;opacity:.25;transition:opacity .2s}
.controls:hover,.controls:focus-within{opacity:1}
.controls button{font:inherit;font-size:14px;background:#1b1e26;color:#fff;border:1px solid #333a48;border-radius:8px;padding:6px 10px;cursor:pointer}
.controls button:focus-visible{outline:2px solid var(--accent)}
.progress{position:fixed;left:0;top:0;height:3px;background:var(--accent);transition:width .25s}
.panel{display:none;background:#0d0f14;color:#e5e7eb;border-left:1px solid #222733;padding:20px;overflow:auto;font-size:18px;line-height:1.5}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:#8b93a3;margin:18px 0 6px}
.panel .timer{font-variant-numeric:tabular-nums;font-size:28px;font-weight:700}
body.show-notes .panel,body.presenter .panel{display:block}
body.show-notes .deck,body.presenter .deck{display:grid;grid-template-columns:1fr 32vw;height:100vh}
body.show-notes .slide,body.presenter .slide{width:min(66vw,calc(100vh * 16 / 9))}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.help{position:fixed;left:12px;bottom:12px;font-size:12px;color:#8b93a3;opacity:.6}
`;
}

const SCRIPT = `
(()=>{const slides=[...document.querySelectorAll('.slide')];const live=document.getElementById('live');const notes=document.getElementById('notes-text');
const next=document.getElementById('next-title');const counter=document.getElementById('counter');const bar=document.querySelector('.progress');const deck=document.querySelector('.deck');
let i=0;const start=Date.now();
function show(n,focus){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,k)=>{const on=k===i;s.hidden=!on;s.setAttribute('aria-hidden',String(!on));if(on){s.classList.remove('enter');void s.offsetWidth;s.classList.add('enter')}});
const s=slides[i];live.textContent='Slide '+(i+1)+' of '+slides.length+': '+(s.dataset.title||'');
notes.textContent=(s.querySelector('.notes')||{}).textContent||'(no notes)';next.textContent=slides[i+1]?slides[i+1].dataset.title:'(end)';
counter.textContent=(i+1)+' / '+slides.length;bar.style.width=((i+1)/slides.length*100)+'%';
if(location.hash!=='#'+(i+1))history.replaceState(null,'','#'+(i+1));if(focus)deck.focus()}
document.addEventListener('keydown',e=>{if(e.target.closest&&e.target.closest('input,textarea,[contenteditable]'))return;
const k=e.key;if(['ArrowRight','PageDown',' ','Enter'].includes(k)&&!(k==='Enter'&&e.target.tagName==='BUTTON')){e.preventDefault();show(i+1)}
else if(['ArrowLeft','PageUp','Backspace'].includes(k)){e.preventDefault();show(i-1)}else if(k==='Home'){show(0)}else if(k==='End'){show(slides.length-1)}
else if(k==='n'||k==='N'){document.body.classList.toggle('show-notes')}else if(k==='p'||k==='P'){document.body.classList.toggle('presenter')}
else if(k==='f'||k==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}});
document.getElementById('prev').onclick=()=>show(i-1);document.getElementById('nextb').onclick=()=>show(i+1);
document.getElementById('notesb').onclick=()=>document.body.classList.toggle('show-notes');
let x0=null;deck.addEventListener('touchstart',e=>{x0=e.touches[0].clientX},{passive:true});deck.addEventListener('touchend',e=>{if(x0===null)return;const dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>40)show(i+(dx<0?1:-1));x0=null});
setInterval(()=>{const t=Math.floor((Date.now()-start)/1000);document.getElementById('timer').textContent=String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0')},1000);
const h=parseInt(location.hash.slice(1),10);if(new URLSearchParams(location.search).has('presenter'))document.body.classList.add('presenter');show(Number.isFinite(h)?h-1:0);})();`;

/** Standalone themed HTML for a deck (16:9, keyboard navigation, notes/presenter view, accessible). */
export function renderDeckHtml(deck: Deck, opts: DeckHtmlOptions = {}): string {
  const mode = opts.mode ?? "present";
  const theme = deck.theme;
  const total = deck.slides.length;
  const sections = deck.slides
    .map((s, i) => {
      const label = `Slide ${i + 1} of ${total}: ${s.title}`;
      return `<section class="slide l-${s.layout}" id="slide-${i + 1}" data-title="${esc(s.title)}" role="group" aria-roledescription="slide" aria-label="${esc(label)}"${mode === "present" && i > 0 ? " hidden" : ""}>
${slideInner(s, theme, i)}
<footer class="foot" aria-hidden="true"><span>${esc(deck.title)}</span><span>${i + 1} / ${total}</span></footer>
<aside class="notes" aria-label="Speaker notes">${esc(s.notes ?? "")}</aside>
</section>`;
    })
    .join("\n");
  const head = `<!doctype html>
<html lang="${esc(opts.lang ?? "en")}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(deck.title)}</title>
<meta name="generator" content="Forge slides${deck.meta?.generator ? ` (${esc(String(deck.meta.generator))})` : ""}">
<style>${css(theme, mode)}</style></head>`;
  if (mode === "print") return `${head}<body>${sections}</body></html>`;
  return `${head}
<body>
<div class="progress" aria-hidden="true"></div>
<main class="deck" tabindex="0" aria-roledescription="carousel" aria-label="${esc(deck.title)} presentation">
<div class="stage">${sections}</div>
<aside class="panel" aria-label="Presenter panel">
<h2>Elapsed</h2><div class="timer" id="timer">00:00</div>
<h2>Slide</h2><div id="counter"></div>
<h2>Next</h2><div id="next-title"></div>
<h2>Notes</h2><div id="notes-text"></div>
</aside>
</main>
<div class="sr-only" id="live" aria-live="polite" aria-atomic="true"></div>
<nav class="controls" aria-label="Slide controls"><button id="prev" type="button" aria-label="Previous slide">&larr;</button><button id="notesb" type="button" aria-label="Toggle speaker notes">Notes</button><button id="nextb" type="button" aria-label="Next slide">&rarr;</button></nav>
<p class="help" aria-hidden="true">&larr; &rarr; navigate · N notes · P presenter · F fullscreen</p>
<script>${SCRIPT}</script>
</body></html>`;
}
