// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  // Public origin for canonical URLs and the sitemap. Set SITE_URL in CI/deploy.
  site: process.env.SITE_URL ?? "http://localhost:4321",
  integrations: [sitemap()],
  server: { port: 4321 },
});
