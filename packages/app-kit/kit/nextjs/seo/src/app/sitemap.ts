import type { MetadataRoute } from "next";
import { publicRoutes } from "@/lib/seo-routes";
import { absoluteUrl } from "@/lib/site";

/** /sitemap.xml from the public routes in forge.json. Add dynamic entries (blog posts...) here. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return publicRoutes.map((path) => ({ url: absoluteUrl(path), lastModified: now, changeFrequency: "weekly", priority: path === "/" ? 1 : 0.7 }));
}
