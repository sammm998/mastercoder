import { site } from "./site";

export interface PageMeta {
  title?: string;
  description?: string;
  /** Path of the page, e.g. "/about". */
  path: string;
  /** Absolute or root-relative Open Graph image. */
  image?: string;
}

export interface ResolvedMeta {
  title: string;
  description: string;
  canonical: string;
  openGraph: Record<string, string>;
}

/** Title, description, canonical URL and Open Graph tags for a page. */
export function resolveMeta(meta: PageMeta, origin: string): ResolvedMeta {
  const title = meta.title ? `${meta.title} · ${site.name}` : site.name;
  const description = meta.description ?? site.description;
  const canonical = new URL(meta.path, origin).toString();
  const openGraph: Record<string, string> = {
    "og:title": title,
    "og:description": description,
    "og:url": canonical,
    "og:type": "website",
    "og:site_name": site.name,
    "og:locale": site.locale,
  };
  if (meta.image) openGraph["og:image"] = new URL(meta.image, origin).toString();
  return { title, description, canonical, openGraph };
}

/** schema.org JSON-LD for the site, safe to inline in a <script type="application/ld+json">. */
export function websiteJsonLd(origin: string): string {
  return JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: origin }).replace(/</g, "\\u003c");
}
