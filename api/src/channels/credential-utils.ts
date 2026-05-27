import { encrypt, decrypt } from '../utils/encryption';

/**
 * Encrypt a credential value before storing in the database.
 */
export function encryptCredential(value: string): string {
  return encrypt(value);
}

/**
 * Decrypt a credential value read from the database.
 */
export function decryptCredential(encryptedValue: string, fallbackToPlaintext = false): string {
  try {
    return decrypt(encryptedValue, 'credential');
  } catch {
    if (fallbackToPlaintext) {
      // Support reading legacy unencrypted values during migration
      return encryptedValue;
    }
    throw new Error('Failed to decrypt credential');
  }
}

/**
 * Get the bot token from a Telegram channel connection, decrypting it.
 */
export function getTelegramBotToken(credentials: Record<string, unknown>): string | null {
  const token = credentials.botToken as string | undefined;
  if (!token) return null;
  return decryptCredential(token, true);
}

/**
 * Get the page access token from a Meta (Messenger/Instagram) connection, decrypting it.
 */
export function getMetaPageAccessToken(credentials: Record<string, unknown>): string | null {
  const token = credentials.pageAccessToken as string | undefined;
  if (!token) return null;
  return decryptCredential(token, true);
}

/**
 * Get the system-user / phone-number access token from a WhatsApp Cloud API
 * connection, decrypting it.
 */
export function getWhatsAppAccessToken(credentials: Record<string, unknown>): string | null {
  const token = credentials.accessToken as string | undefined;
  if (!token) return null;
  return decryptCredential(token, true);
}
