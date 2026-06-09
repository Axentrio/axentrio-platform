// Clerk token cache backed by the device Keychain/Keystore via expo-secure-store.
// This is what keeps the session in secure native storage (not JS-readable).
import * as SecureStore from 'expo-secure-store';

export const tokenCache = {
  async getToken(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // ignore write failures; Clerk will re-auth on next launch
    }
  },
};
