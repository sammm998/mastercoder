/**
 * Client-side SEO for the SPA: title, description, canonical, Open Graph and JSON-LD in <head>.
 * Search engines that render JavaScript pick these up; for content that must rank, prefer the
 * astro-site or nextjs templates (server-rendered HTML).
 */
export interface PageMeta {
  title: string;
  description?: string;
  /** Path of the page, e.g. "/pricing". */
  path?: string;
  image?: string;
  jsonLd?: Record<string, unknown>;
}

function setMeta(attr: "name" | "property", key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setLink(rel: string, href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
}

export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify({ "@context": "https://schema.org", ...data }).replace(/</g, "\\u003c");
}

/** Apply page metadata to document.head. Call on route change. */
export function setPageMeta(meta: PageMeta, origin: string = window.location.origin): void {
  document.title = meta.title;
  const url = new URL(meta.path ?? window.location.pathname, origin).toString();
  setLink("canonical", url);
  if (meta.description) {
    setMeta("name", "description", meta.description);
    setMeta("property", "og:description", meta.description);
  }
  setMeta("property", "og:title", meta.title);
  setMeta("property", "og:url", url);
  setMeta("property", "og:type", "website");
  setMeta("name", "twitter:card", meta.image ? "summary_large_image" : "summary");
  if (meta.image) setMeta("property", "og:image", new URL(meta.image, origin).toString());
  let ld = document.head.querySelector<HTMLScriptElement>('script[type="application/ld+json"][data-forge]');
  if (meta.jsonLd) {
    if (!ld) {
      ld = document.createElement("script");
      ld.type = "application/ld+json";
      ld.dataset.forge = "";
      document.head.appendChild(ld);
    }
    ld.textContent = serializeJsonLd(meta.jsonLd);
  } else ld?.remove();
}
