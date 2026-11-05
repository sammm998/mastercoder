import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

/** /robots.txt: crawlable except private areas; points to the sitemap. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/admin", "/sign-in"] }],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
