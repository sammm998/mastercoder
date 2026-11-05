import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const TOKEN_KEY = "forge.session";

/**
 * Session token: Keychain / Android Keystore via expo-secure-store. Web has no secure enclave, so the web
 * build (used for previews and `expo export --platform web`) falls back to sessionStorage, cleared with the tab.
 */
export const tokenStore = {
  async get(): Promise<string | null> {
    try {
      if (Platform.OS === "web") return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null;
      return await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  async set(token: string): Promise<void> {
    if (Platform.OS === "web") {
      globalThis.sessionStorage?.setItem(TOKEN_KEY, token);
      return;
    }
    await SecureStore.setItemAsync(TOKEN_KEY, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async clear(): Promise<void> {
    try {
      if (Platform.OS === "web") globalThis.sessionStorage?.removeItem(TOKEN_KEY);
      else await SecureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      /* already gone */
    }
  },
};

/** Non-secret preferences and upload state. */
export const kv = {
  async getItem(k: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(k);
    } catch {
      return null;
    }
  },
  async setItem(k: string, v: string): Promise<void> {
    await AsyncStorage.setItem(k, v);
  },
  async removeItem(k: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
