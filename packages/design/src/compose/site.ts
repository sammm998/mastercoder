import { z } from "zod";
import { googleFontsLinks } from "../fonts.js";
import { bundlePatterns } from "../patterns/index.js";
import { tokensFromDirection, tokensToCss } from "../tokens.js";
import { ArtDirectionSchema, DesignBriefSchema, type ArtDirection, type DesignBrief, type DesignBriefInput, type ArtDirectionInput } from "../types.js";
import { ART_COMPONENT, faviconSvg, projectSvg } from "./art.js";
import { SiteContentSchema, type SiteContent, type SiteContentInput } from "./content.js";
import { BASE_CSS } from "./styles.js";

export const SECTION_TYPES = ["hero-3d", "hero-type", "statement", "features", "story", "horizontal", "stats", "marquee", "cta"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/** Pinned toolchain versions for generated projects (checked against the npm registry when curated). */
export const TOOLCHAIN_VERSIONS = {
  vite: "8.3.6",
  "@vitejs/plugin-react": "6.2.1",
  typescript: "5.9.3",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  "@types/three": "0.187.0",
} as const;

const SECTION_PATTERNS: Record<SectionType, string[]> = {
  "hero-3d": ["hero-3d", "magnetic-button"],
  "hero-type": ["parallax-layers", "magnetic-button"],
  statement: ["split-text"],
  features: ["bento-grid"],
  story: ["sticky-story"],
  horizontal: ["horizontal-scroll"],
  stats: ["animated-counter"],
  marquee: ["marquee"],
  cta: ["split-text", "magnetic-button", "motion-reveal"],
};

export interface ComposeOptions {
  /** Add the custom cursor follower (default: when the direction prefers it). */
  cursor?: boolean;
  /** Add the first-visit preloader curtain (default false for landings, true for portfolios). */
  preloader?: boolean;
  /** Lenis smooth scrolling (default true). */
  smoothScroll?: boolean;
}

export const ComposeLandingInputSchema = z.object({
  brief: DesignBriefSchema,
  direction: ArtDirectionSchema,
  sections: z.array(z.enum(SECTION_TYPES)).optional(),
  content: SiteContentSchema,
});

export interface ComposeLandingInput {
  brief: DesignBriefInput;
  direction: ArtDirectionInput;
  /** Section order; defaults are derived from the brief features and direction. */
  sections?: SectionType[];
  content: SiteContentInput;
  options?: ComposeOptions;
}

export type ProjectFiles = Record<string, string>;

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "site";
const htmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Pick default sections from brief features (3d, scroll storytelling, horizontal, split text...). */
export function defaultSections(brief: DesignBrief, direction: ArtDirection, content: SiteContent): SectionType[] {
  const f = [...brief.features, ...direction.preferredPatterns].join(" ").toLowerCase();
  const wants = (re: RegExp) => re.test(f);
  const out: SectionType[] = [wants(/3d|webgl|hero-3d|three/) ? "hero-3d" : "hero-type", "statement", "features"];
  if (wants(/story|sticky|storytelling/) || !wants(/horizontal/)) out.push("story");
  if (wants(/horizontal/)) out.push("horizontal");
  if (content.stats.items.length >= 2) out.push("stats");
  out.push("marquee", "cta");
  return out;
}

function packageJson(name: string, deps: Record<string, string>): string {
  const devDependencies: Record<string, string> = {
    "@types/react": TOOLCHAIN_VERSIONS["@types/react"],
    "@types/react-dom": TOOLCHAIN_VERSIONS["@types/react-dom"],
    "@vitejs/plugin-react": TOOLCHAIN_VERSIONS["@vitejs/plugin-react"],
    typescript: TOOLCHAIN_VERSIONS.typescript,
    vite: TOOLCHAIN_VERSIONS.vite,
  };
  if (deps.three) devDependencies["@types/three"] = TOOLCHAIN_VERSIONS["@types/three"];
  const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return (
    JSON.stringify(
      {
        name,
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview", typecheck: "tsc --noEmit" },
        dependencies: sorted(deps),
        devDependencies: sorted(devDependencies),
      },
      null,
      2,
    ) + "\n"
  );
}

function indexHtml(brief: DesignBrief, content: SiteContent, direction: ArtDirection): string {
  const t = tokensFromDirection(direction);
  return `<!doctype html>
<html lang="${htmlEsc(brief.locale)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEsc(content.meta.title)}</title>
    <meta name="description" content="${htmlEsc(content.meta.description)}" />
    <meta name="theme-color" content="${t.color.bg}" />
    <meta name="color-scheme" content="${t.scheme}" />
    <meta property="og:title" content="${htmlEsc(content.meta.title)}" />
    <meta property="og:description" content="${htmlEsc(content.meta.description)}" />
    <meta property="og:type" content="website" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    ${googleFontsLinks(t.fonts)}
  </head>
  <body>
    <div id="root"></div>
    <noscript><main><h1>${htmlEsc(content.hero.headline)}</h1><p>${htmlEsc(content.hero.lede)}</p></main></noscript>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", modulePreload: { polyfill: false }, chunkSizeWarningLimit: 1200 },
});
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      noUncheckedIndexedAccess: true,
      isolatedModules: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["vite/client"],
    },
    include: ["src"],
  },
  null,
  2,
) + "\n";

function mainTsx(css: string[]): string {
  const imports = css.map((c) => `import "./${c.replace(/^src\//, "")}";`).join("\n");
  return `import { StrictMode, startTransition } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
${imports}
import App from "./App";

const root = document.getElementById("root");
// A transition render is time-sliced, so the first render never becomes one long main-thread task.
if (root) {
  const reactRoot = createRoot(root);
  startTransition(() => reactRoot.render(<StrictMode><App /></StrictMode>));
}
`;
}

const CONTENT_TYPES = `export interface Link { label: string; href: string }
export interface SiteContent {
  generatedBy: string;
  meta: { title: string; description: string };
  brand: string;
  nav: Link[];
  hero: { eyebrow: string; headline: string; emphasis?: string; lede: string; primaryCta: Link; secondaryCta?: Link };
  statement: { text: string; emphasis: number[] };
  features: { title: string; intro: string; items: Array<{ title: string; body: string; kicker?: string }> };
  story: { title: string; intro: string; steps: Array<{ kicker?: string; title: string; body: string }> };
  horizontal: { title: string; intro: string; items: Array<{ title: string; body: string; meta?: string }> };
  stats: { title?: string; items: Array<{ value: number; prefix?: string; suffix?: string; decimals?: number; label: string }> };
  marquee: string[];
  cta: { title: string; body: string; button: Link };
  footer: { tagline: string; links: Link[]; legal: string };
  projects: Array<{ slug: string; title: string; year: string; role: string; location?: string; summary: string; body: string; tags: string[] }>;
}
`;

function contentTs(content: SiteContent, locale: string): string {
  return `${CONTENT_TYPES}
export const locale = ${JSON.stringify(locale)};

export const content: SiteContent = ${JSON.stringify(content, null, 2)};
`;
}

const HEADER_TSX = `import { useState } from "react";
import type { Link } from "../content";

export function SiteHeader({ brand, nav, cta }: { brand: string; nav: Link[]; cta: Link }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <a className="site-header__brand" href="#top">
        {brand}
      </a>
      <button type="button" className="site-header__toggle" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((o) => !o)}>
        Menu
      </button>
      <nav id="site-nav" aria-label="Primary" className={open ? "site-nav is-open" : "site-nav"}>
        <ul>
          {nav.map((l) => (
            <li key={l.href}>
              <a href={l.href} onClick={() => setOpen(false)}>
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <a className="site-header__cta" href={cta.href}>
        {cta.label}
      </a>
    </header>
  );
}
`;

const FOOTER_TSX = `import type { SiteContent } from "../content";

export function SiteFooter({ content }: { content: SiteContent }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__top">
        <p className="site-footer__tagline">{content.footer.tagline}</p>
        <ul className="site-footer__links">
          {content.footer.links.map((l) => (
            <li key={l.href}>
              <a href={l.href}>{l.label}</a>
            </li>
          ))}
        </ul>
      </div>
      <p className="site-footer__wordmark" aria-hidden="true">
        {content.brand}
      </p>
      <p className="site-footer__legal">{content.footer.legal}</p>
    </footer>
  );
}
`;

const EMPHASIS_TSX = `/** Render a headline with one phrase emphasised (italic accent). */
export function Emphasis({ text, phrase }: { text: string; phrase?: string }) {
  if (!phrase) return <>{text}</>;
  const i = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <em>{text.slice(i, i + phrase.length)}</em>
      {text.slice(i + phrase.length)}
    </>
  );
}
`;

/** JSX for each section (expects `content`, `locale`, components imported in App). */
function sectionJsx(s: SectionType): string {
  switch (s) {
    case "hero-3d":
      return `      <Hero3D
        id="top"
        eyebrow={content.hero.eyebrow}
        title={<Emphasis text={content.hero.headline} phrase={content.hero.emphasis} />}
        lede={content.hero.lede}
        actions={
          <>
            <MagneticButton href={content.hero.primaryCta.href}>{content.hero.primaryCta.label}</MagneticButton>
            {content.hero.secondaryCta ? (
              <a className="link-arrow" href={content.hero.secondaryCta.href}>
                {content.hero.secondaryCta.label} <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </>
        }
      />`;
    case "hero-type":
      return `      <section id="top" className="hero-type" aria-labelledby="top-title">
        <ParallaxLayers
          as="div"
          label="Decorative composition"
          className="hero-type__art"
          layers={[
            { depth: 0.25, decorative: true, content: <div className="hero-type__shape"><Art variant={1} /></div> },
            { depth: 0.7, decorative: true, content: <span className="hero-type__disc" /> },
          ]}
        />
        <div className="hero-type__content">
          <p className="hero-type__eyebrow">{content.hero.eyebrow}</p>
          <h1 id="top-title" className="hero-type__title">
            <Emphasis text={content.hero.headline} phrase={content.hero.emphasis} />
          </h1>
          <p className="hero-type__lede">{content.hero.lede}</p>
          <div className="hero-actions">
            <MagneticButton href={content.hero.primaryCta.href}>{content.hero.primaryCta.label}</MagneticButton>
            {content.hero.secondaryCta ? (
              <a className="link-arrow" href={content.hero.secondaryCta.href}>
                {content.hero.secondaryCta.label} <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        </div>
      </section>`;
    case "statement":
      return `      <section id="studio" className="statement" aria-label={"About " + content.brand}>
        <p className="statement__label" aria-hidden="true">({content.brand})</p>
        <SplitText as="p" className="statement__text" text={content.statement.text} emphasis={content.statement.emphasis} />
      </section>`;
    case "features":
      return `      <BentoGrid
        id="features"
        title={content.features.title}
        intro={content.features.intro}
        items={content.features.items.map((f, i) => ({
          id: "feature-" + i,
          ...f,
          size: BENTO_SIZES[i % BENTO_SIZES.length],
          accent: i === 0,
          visual: i === 0 ? <Art variant={4} tone="inverse" /> : i % 2 === 1 ? <Art variant={i + 2} /> : undefined,
        }))}
      />`;
    case "story":
      return `      <StickyStory
        id="story"
        title={content.story.title}
        intro={content.story.intro}
        steps={content.story.steps.map((s, i) => ({ id: "step-" + i, ...s, visual: <Art variant={i} /> }))}
      />`;
    case "horizontal":
      return `      <HorizontalScroll
        id="range"
        title={content.horizontal.title}
        intro={content.horizontal.intro}
        items={content.horizontal.items.map((h, i) => ({ id: "item-" + i, ...h, visual: <Art variant={i + 3} /> }))}
      />`;
    case "stats":
      return `      <CounterRow id="numbers" title={content.stats.title} stats={content.stats.items.map((s) => ({ ...s, locale }))} />`;
    case "marquee":
      return `      <Marquee items={content.marquee} label={content.brand + " in words"} />`;
    case "cta":
      return `      <section id="contact" className="cta" aria-labelledby="contact-title">
        <SplitText as="h2" id="contact-title" className="cta__title" text={content.cta.title} />
        <Reveal className="cta__inner">
          <p className="cta__body">{content.cta.body}</p>
          <MagneticButton href={content.cta.button.href}>{content.cta.button.label}</MagneticButton>
        </Reveal>
      </section>`;
  }
}

interface Imp { name: string; from: string }

function importsFor(patternIds: Set<string>, extra: Imp[]): string {
  const map: Record<string, Imp> = {
    "hero-3d": { name: "Hero3D", from: "./patterns/hero-3d/Hero3D" },
    "magnetic-button": { name: "MagneticButton", from: "./patterns/magnetic-button/MagneticButton" },
    "parallax-layers": { name: "ParallaxLayers", from: "./patterns/parallax-layers/ParallaxLayers" },
    "split-text": { name: "SplitText", from: "./patterns/split-text/SplitText" },
    "bento-grid": { name: "BentoGrid", from: "./patterns/bento-grid/BentoGrid" },
    "sticky-story": { name: "StickyStory", from: "./patterns/sticky-story/StickyStory" },
    "horizontal-scroll": { name: "HorizontalScroll", from: "./patterns/horizontal-scroll/HorizontalScroll" },
    "animated-counter": { name: "CounterRow", from: "./patterns/animated-counter/AnimatedCounter" },
    marquee: { name: "Marquee", from: "./patterns/marquee/Marquee" },
    "motion-reveal": { name: "Reveal", from: "./patterns/motion-reveal/Reveal" },
    "smooth-scroll": { name: "SmoothScrollProvider", from: "./patterns/smooth-scroll/SmoothScroll" },
    "custom-cursor": { name: "CustomCursor", from: "./patterns/custom-cursor/CustomCursor" },
    preloader: { name: "Preloader", from: "./patterns/preloader/Preloader" },
    "image-distortion": { name: "DistortImage", from: "./patterns/image-distortion/DistortImage" },
  };
  const lines = [...patternIds].filter((id) => map[id]).map((id) => `import { ${map[id]!.name} } from "${map[id]!.from}";`);
  for (const e of extra) lines.push(`import { ${e.name} } from "${e.from}";`);
  return lines.sort().join("\n");
}

function sharedFiles(direction: ArtDirection, brief: DesignBrief, content: SiteContent, deps: Record<string, string>, css: string[]): ProjectFiles {
  const t = tokensFromDirection(direction);
  return {
    "package.json": packageJson(slugify(brief.name), deps),
    "index.html": indexHtml(brief, content, direction),
    "vite.config.ts": VITE_CONFIG,
    "tsconfig.json": TSCONFIG,
    "src/vite-env.d.ts": `/// <reference types="vite/client" />\n`,
    "src/main.tsx": mainTsx(css),
    "src/content.ts": contentTs(content, brief.locale),
    "src/styles/tokens.css": tokensToCss(t),
    "src/styles/base.css": BASE_CSS,
    "src/components/Art.tsx": ART_COMPONENT,
    "src/components/SiteHeader.tsx": HEADER_TSX,
    "src/components/SiteFooter.tsx": FOOTER_TSX,
    "src/components/Emphasis.tsx": EMPHASIS_TSX,
    "public/favicon.svg": faviconSvg(direction.palette, content.brand),
    "public/robots.txt": "User-agent: *\nAllow: /\n",
    ".gitignore": "node_modules\ndist\n",
  };
}

function wantsCursor(direction: ArtDirection, opts: ComposeOptions): boolean {
  return opts.cursor ?? direction.preferredPatterns.includes("custom-cursor");
}

/**
 * Compose a complete Vite + React + TS landing page project (path -> file content) from a brief,
 * an art direction, a section list and copy. Uses the pattern library sources verbatim.
 */
export function composeLanding(input: ComposeLandingInput): ProjectFiles {
  const brief = DesignBriefSchema.parse(input.brief);
  const direction = ArtDirectionSchema.parse(input.direction);
  const content = SiteContentSchema.parse(input.content);
  const opts = input.options ?? {};
  const sections = input.sections?.length ? input.sections : defaultSections(brief, direction, content);
  if (!sections.some((s) => s === "hero-3d" || s === "hero-type")) sections.unshift("hero-type");
  const ids = new Set<string>(sections.flatMap((s) => SECTION_PATTERNS[s]));
  if (opts.smoothScroll !== false) ids.add("smooth-scroll");
  if (wantsCursor(direction, opts)) ids.add("custom-cursor");
  if (opts.preloader) ids.add("preloader");
  const bundle = bundlePatterns([...ids]);
  const usesArt = sections.some((s) => ["hero-type", "features", "story", "horizontal"].includes(s));
  const extra: Imp[] = [
    { name: "SiteHeader", from: "./components/SiteHeader" },
    { name: "SiteFooter", from: "./components/SiteFooter" },
    { name: "Emphasis", from: "./components/Emphasis" },
    { name: "content", from: "./content" },
  ];
  if (sections.includes("stats")) extra.push({ name: "locale", from: "./content" });
  if (usesArt) extra.push({ name: "Art", from: "./components/Art" });
  const body = sections.map(sectionJsx).join("\n");
  const wrapOpen = ids.has("smooth-scroll") ? `    <SmoothScrollProvider syncScrollTrigger={${ids.has("sticky-story") || ids.has("horizontal-scroll")}}>` : "    <>";
  const wrapClose = ids.has("smooth-scroll") ? "    </SmoothScrollProvider>" : "    </>";
  const app = `${importsFor(ids, extra).replace(/import \{ content \} from "\.\/content";\nimport \{ locale \} from "\.\/content";/, 'import { content, locale } from "./content";')}
${sections.includes("features") ? `\nconst BENTO_SIZES = ["lg", "sm", "sm", "md", "md", "wide", "sm"] as const;\n` : ""}
export default function App() {
  return (
${wrapOpen}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      ${ids.has("preloader") ? "<Preloader label={content.brand} />" : ""}
      <SiteHeader brand={content.brand} nav={content.nav} cta={content.hero.primaryCta} />
      <main id="main">
${body}
      </main>
      <SiteFooter content={content} />
      ${ids.has("custom-cursor") ? "<CustomCursor />" : ""}
${wrapClose}
  );
}
`;
  return { ...sharedFiles(direction, brief, content, bundle.dependencies, bundle.css), ...bundle.files, "src/App.tsx": app };
}

export interface ComposePortfolioInput {
  brief: DesignBriefInput;
  direction: ArtDirectionInput;
  content: SiteContentInput;
  options?: ComposeOptions;
}

/**
 * Compose a portfolio: typographic parallax hero, sticky scroll storytelling through N projects (WebGL
 * distortion images), studio statement, horizontal process, marquee, contact, and per-project case-study
 * views with View Transitions.
 */
export function composePortfolio(input: ComposePortfolioInput): ProjectFiles {
  const brief = DesignBriefSchema.parse(input.brief);
  const direction = ArtDirectionSchema.parse(input.direction);
  const content = SiteContentSchema.parse(input.content);
  if (content.projects.length < 2) throw new Error("composePortfolio needs at least 2 projects in content.projects");
  const opts = { preloader: true, ...input.options };
  const ids = new Set<string>(["parallax-layers", "magnetic-button", "sticky-story", "image-distortion", "page-transition", "split-text", "horizontal-scroll", "marquee", "motion-reveal"]);
  if (opts.smoothScroll !== false) ids.add("smooth-scroll");
  if (wantsCursor(direction, opts)) ids.add("custom-cursor");
  if (opts.preloader) ids.add("preloader");
  const bundle = bundlePatterns([...ids]);
  const images: ProjectFiles = Object.fromEntries(content.projects.map((p, i) => [`public/work/${p.slug}.svg`, projectSvg(direction.palette, p.title, i)]));
  const app = `${importsFor(ids, [
    { name: "SiteHeader", from: "./components/SiteHeader" },
    { name: "SiteFooter", from: "./components/SiteFooter" },
    { name: "Emphasis", from: "./components/Emphasis" },
    { name: "content", from: "./content" },
    { name: "Art", from: "./components/Art" },
    { name: "useHashRoute, TransitionLink", from: "./patterns/page-transition/PageTransition" },
  ])}

type Navigate = (to: string) => void;

function Home({ navigate }: { navigate: Navigate }) {
  return (
    <>
${sectionJsx("hero-type").replace(/^ {6}/gm, "      ")}
      <StickyStory
        id="work"
        title={content.story.title}
        intro={content.story.intro}
        steps={content.projects.map((p) => ({
          id: p.slug,
          kicker: [p.year, p.location].filter(Boolean).join(" · "),
          title: p.title,
          body: p.summary,
          visual: <DistortImage src={"/work/" + p.slug + ".svg"} alt={p.title + " — " + p.summary} width={1600} height={1200} />,
          action: (
            <TransitionLink className="case-link" to={"work/" + p.slug} navigate={navigate}>
              Read the case study<span className="sr-only">: {p.title}</span> <span aria-hidden="true">→</span>
            </TransitionLink>
          ),
        }))}
      />
${sectionJsx("statement")}
      <HorizontalScroll
        id="process"
        title={content.horizontal.title}
        intro={content.horizontal.intro}
        items={content.horizontal.items.map((h, i) => ({ id: "process-" + i, ...h, visual: <Art variant={i + 3} /> }))}
      />
${sectionJsx("marquee")}
${sectionJsx("cta")}
    </>
  );
}

function CaseStudy({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const p = content.projects.find((x) => x.slug === slug);
  if (!p) {
    return (
      <section className="case" aria-labelledby="case-title">
        <h1 id="case-title" className="case__title" data-route-focus>
          Project not found
        </h1>
        <TransitionLink className="link-arrow" to="" navigate={navigate}>
          Back to all work
        </TransitionLink>
      </section>
    );
  }
  return (
    <article className="case" aria-labelledby="case-title">
      <TransitionLink className="link-arrow" to="" navigate={navigate}>
        <span aria-hidden="true">←</span> All work
      </TransitionLink>
      <h1 id="case-title" className="case__title" data-route-focus>
        {p.title}
      </h1>
      <DistortImage src={"/work/" + p.slug + ".svg"} alt={p.title + " — " + p.summary} width={1600} height={1200} priority />
      <dl className="case__meta">
        <div>
          <dt>Year</dt>
          <dd>{p.year}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{p.role}</dd>
        </div>
        {p.location ? (
          <div>
            <dt>Type</dt>
            <dd>{p.location}</dd>
          </div>
        ) : null}
      </dl>
      <p className="case__body">{p.body}</p>
      <ul className="case__tags" aria-label="Tags">
        {p.tags.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </article>
  );
}

export default function App() {
  const [route, navigate] = useHashRoute();
  const slug = route.startsWith("work/") ? route.slice(5) : null;
  return (
${ids.has("smooth-scroll") ? "    <SmoothScrollProvider syncScrollTrigger>" : "    <>"}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      ${ids.has("preloader") ? "<Preloader label={content.brand} />" : ""}
      <SiteHeader brand={content.brand} nav={content.nav} cta={content.hero.primaryCta} />
      <main id="main">{slug ? <CaseStudy slug={slug} navigate={navigate} /> : <Home navigate={navigate} />}</main>
      <SiteFooter content={content} />
      ${ids.has("custom-cursor") ? "<CustomCursor />" : ""}
${ids.has("smooth-scroll") ? "    </SmoothScrollProvider>" : "    </>"}
  );
}
`;
  return { ...sharedFiles(direction, brief, content, bundle.dependencies, bundle.css), ...bundle.files, ...images, "src/App.tsx": app };
}
