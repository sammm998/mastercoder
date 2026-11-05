import type { Hono } from "hono";

/**
 * Extension point for @forge/app-kit. When kit features (auth, payments, cron, ...) are added,
 * Forge regenerates this file to mount their routes. No kit features installed.
 */
export function mountKit(_app: Hono): void {}
