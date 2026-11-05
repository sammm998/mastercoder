import { CATALOG, catalogAppInfo, getCatalogApp, type CatalogApp } from "./catalog.js";
import type { AppInfo } from "./types.js";

/**
 * Forge exposes a curated app catalog (scopes with sv/en descriptions, irreversible flags) regardless of
 * which broker performs OAuth. Real adapters extend this and implement the vendor calls.
 */
export abstract class CatalogBackedProvider {
  async listApps(): Promise<AppInfo[]> {
    return CATALOG.map((a) => catalogAppInfo(a));
  }
  async getApp(app: string): Promise<AppInfo> {
    return catalogAppInfo(getCatalogApp(app));
  }
  protected app(app: string): CatalogApp {
    return getCatalogApp(app);
  }
  /** Map a vendor app slug back to the catalog slug (falls back to the vendor slug). */
  protected catalogSlug(vendor: keyof CatalogApp["vendor"], vendorSlug: string): string {
    return CATALOG.find((a) => a.vendor[vendor] === vendorSlug)?.slug ?? vendorSlug;
  }
}
