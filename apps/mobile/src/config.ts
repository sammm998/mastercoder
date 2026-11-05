import Constants from "expo-constants";

type Extra = { apiUrl?: string };

/**
 * API base URL: EXPO_PUBLIC_API_URL (inlined at bundle time) → app.json `extra.apiUrl` → localhost.
 * On a physical device use your machine's LAN address (e.g. http://192.168.1.20:4000), not localhost.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || (Constants.expoConfig?.extra as Extra | undefined)?.apiUrl || "http://localhost:4000").replace(/\/$/, "");
