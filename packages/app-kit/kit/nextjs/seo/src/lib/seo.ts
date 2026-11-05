import type { Metadata } from "next";
import { absoluteUrl, site } from "@/lib/site";

export interface PageSeo {
  title?: string;
  description?: string;
  /** Path of the page, e.g. "/pricing". Used for the canonical URL and og:url. */
  path: string;
  /** Absolute or root-relative image for Open Graph / Twitter cards (1200×630). */
  image?: string;
  type?: "website" | "article";
  noIndex?: boolean;
}

/** Next.js Metadata with canonical URL, Open Graph and Twitter card for one page. */
export function buildMetadata(p: PageSeo): Metadata {
  const url = absoluteUrl(p.path);
  const images = p.image ? [{ url: absoluteUrl(p.image), width: 1200, height: 630 }] : undefined;
  return {
    title: p.title,
    description: p.description ?? site.description,
    alternates: { canonical: url },
    openGraph: { title: p.title ?? site.name, description: p.description ?? site.description, url, siteName: site.name, locale: site.locale, type: p.type ?? "website", images },
    twitter: { card: images ? "summary_large_image" : "summary", title: p.title ?? site.name, description: p.description ?? site.description, images: images?.map((i) => i.url) },
    robots: p.noIndex ? { index: false, follow: false } : undefined,
  };
}

export type JsonLd = Record<string, unknown> & { "@type": string };

/** JSON for a <script type="application/ld+json">; escapes "<" so content cannot close the tag. */
export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  const withContext = Array.isArray(data) ? data.map((d) => ({ "@context": "https://schema.org", ...d })) : { "@context": "https://schema.org", ...data };
  return JSON.stringify(withContext).replace(/</g, "\\u003c");
}

export function websiteJsonLd(): JsonLd {
  return { "@type": "WebSite", name: site.name, url: absoluteUrl("/") };
}

export function organizationJsonLd(org: { name?: string; logo?: string; sameAs?: string[] } = {}): JsonLd {
  return { "@type": "Organization", name: org.name ?? site.name, url: absoluteUrl("/"), ...(org.logo ? { logo: absoluteUrl(org.logo) } : {}), ...(org.sameAs ? { sameAs: org.sameAs } : {}) };
}

export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>): JsonLd {
  return { "@type": "BreadcrumbList", itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: absoluteUrl(it.path) })) };
}

export function articleJsonLd(a: { title: string; path: string; datePublished: string; dateModified?: string; author?: string; image?: string }): JsonLd {
  return {
    "@type": "Article",
    headline: a.title,
    mainEntityOfPage: absoluteUrl(a.path),
    datePublished: a.datePublished,
    dateModified: a.dateModified ?? a.datePublished,
    ...(a.author ? { author: { "@type": "Person", name: a.author } } : {}),
    ...(a.image ? { image: absoluteUrl(a.image) } : {}),
  };
}
