import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Locate a preinstalled Chromium for Remotion. Order: REMOTION_BROWSER_EXECUTABLE, then the newest
 * Playwright `chromium_headless_shell-*` (chrome-headless-shell, preferred by Remotion), then `chromium-*`
 * under PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers. Returns null to let Remotion download its own.
 */
export function findChromiumExecutable(): { path: string; mode: "headless-shell" | "chrome-for-testing" } | null {
  const explicit = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (explicit && existsSync(explicit)) return { path: explicit, mode: explicit.includes("headless-shell") ? "headless-shell" : "chrome-for-testing" };
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(process.env.HOME ?? "", ".cache/ms-playwright")].filter(
    (r): r is string => Boolean(r) && existsSync(r as string),
  );
  const rev = (name: string) => Number(name.split("-").pop()) || 0;
  for (const root of roots) {
    const dirs = readdirSync(root);
    const shells = dirs.filter((d) => d.startsWith("chromium_headless_shell-")).sort((a, b) => rev(b) - rev(a));
    for (const d of shells) {
      for (const p of [join(root, d, "chrome-headless-shell-linux64", "chrome-headless-shell"), join(root, d, "chrome-linux", "headless_shell")]) {
        if (existsSync(p)) return { path: p, mode: "headless-shell" };
      }
    }
    const full = dirs.filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => rev(b) - rev(a));
    for (const d of full) {
      for (const p of [join(root, d, "chrome-linux64", "chrome"), join(root, d, "chrome-linux", "chrome")]) {
        if (existsSync(p)) return { path: p, mode: "chrome-for-testing" };
      }
    }
  }
  return null;
}
