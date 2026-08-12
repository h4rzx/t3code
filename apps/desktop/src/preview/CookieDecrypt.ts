/**
 * Chromium cookie value decryption.
 *
 * Chromium stores cookie values encrypted with a key held by the OS: the
 * "<Browser> Safe Storage" Keychain entry on macOS, the login keyring on Linux,
 * DPAPI on Windows. The scheme is versioned by a three-byte prefix:
 *
 *   v10 / v11  AES-128-CBC, PBKDF2-SHA1 key, IV of sixteen spaces (mac, Linux)
 *   v10        AES-256-GCM, [12-byte nonce][ciphertext][16-byte tag] (Windows)
 *
 * Linux splits the key by version: v10 always uses the hardcoded "peanuts"
 * password, v11 the real keyring password, so both are derived and tried.
 *
 * Everything here is pure — keys arrive as arguments — so the format handling
 * is testable without a Keychain, a browser, or a platform.
 */
import * as NodeCrypto from "node:crypto";

const PBKDF2_SALT = "saltysalt";
const PBKDF2_KEY_LENGTH = 16;
/** macOS iteration count; Linux uses 1. */
export const MACOS_PBKDF2_ITERATIONS = 1003;
export const LINUX_PBKDF2_ITERATIONS = 1;
/** Linux v10's password is hardcoded in Chromium itself. */
export const LINUX_V10_PASSWORD = "peanuts";

const CBC_IV = Buffer.alloc(16, " ");
/** Chrome 130+ prefixes the plaintext with a SHA-256 of the cookie's domain. */
const DOMAIN_HASH_PREFIX_BYTES = 32;

/**
 * Cookies whose values are bound to the originating device. Copying them
 * produces a session the destination browser cannot use, and for Google it
 * actively breaks sign-in, so they are dropped rather than imported.
 */
const DEVICE_BOUND_COOKIE_NAMES: ReadonlySet<string> = new Set([
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "__Secure-STRP",
  "AEC",
]);

export function isDeviceBoundCookieName(name: string): boolean {
  return DEVICE_BOUND_COOKIE_NAMES.has(name);
}

export function deriveChromiumKey(password: string, iterations: number): Buffer {
  return NodeCrypto.pbkdf2Sync(password, PBKDF2_SALT, iterations, PBKDF2_KEY_LENGTH, "sha1");
}

/**
 * Chrome 130+ prepends a 32-byte domain hash to the plaintext. It is not
 * length-delimited, so detection is heuristic: strip it only when what follows
 * is plausible cookie text and the leading bytes are not.
 */
export function stripDomainHashPrefix(plaintext: Buffer): Buffer {
  if (plaintext.length <= DOMAIN_HASH_PREFIX_BYTES) return plaintext;
  const prefix = plaintext.subarray(0, DOMAIN_HASH_PREFIX_BYTES);
  const isPrintable = (buffer: Buffer) => buffer.every((byte) => byte >= 0x20 && byte <= 0x7e);
  return isPrintable(prefix) ? plaintext : plaintext.subarray(DOMAIN_HASH_PREFIX_BYTES);
}

export interface ChromiumDecryptionKeys {
  readonly key: Buffer;
  readonly mode: "aes-128-cbc" | "aes-256-gcm";
  /** Linux only: the other version's key, tried when the first fails. */
  readonly fallbackKey?: Buffer | undefined;
}

export function readEncryptionVersion(encrypted: Buffer): "v10" | "v11" | null {
  const prefix = encrypted.subarray(0, 3).toString("utf8");
  return prefix === "v10" || prefix === "v11" ? prefix : null;
}

function decryptAes256Gcm(payload: Buffer, key: Buffer): Buffer | null {
  // [12-byte nonce][ciphertext][16-byte auth tag]
  if (payload.length < 12 + 16) return null;
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(-16));
    return Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * Returns the plaintext value, or null when no available key decrypts it —
 * a wrong key must drop the cookie, never yield garbage into the jar.
 */
export function decryptChromiumCookieValue(
  encrypted: Buffer,
  keys: ChromiumDecryptionKeys,
): string | null {
  const version = readEncryptionVersion(encrypted);
  // Unversioned values were written before encryption was enabled.
  if (version === null) return encrypted.length > 0 ? encrypted.toString("utf8") : null;

  const payload = encrypted.subarray(3);
  if (payload.length === 0) return "";

  if (keys.mode === "aes-256-gcm") {
    const decrypted = decryptAes256Gcm(payload, keys.key);
    return decrypted === null ? null : stripDomainHashPrefix(decrypted).toString("utf8");
  }

  const candidates =
    version === "v10" && keys.fallbackKey
      ? [keys.fallbackKey, keys.key]
      : [keys.key, ...(keys.fallbackKey ? [keys.fallbackKey] : [])];
  for (const candidate of candidates) {
    try {
      const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", candidate, CBC_IV);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
      return stripDomainHashPrefix(decrypted).toString("utf8");
    } catch {
      continue;
    }
  }
  return null;
}

/** Chromium timestamps are microseconds since 1601-01-01; Electron wants epoch seconds. */
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;

/**
 * Accepts a string because Chromium's microsecond timestamps routinely exceed
 * `Number.MAX_SAFE_INTEGER` — a cookie expiring in 2036 is ~1.34e16. SQLite
 * reads them as text for that reason, and dividing to seconds lands the value
 * back in safe range long before precision matters.
 */
export function chromiumExpiryToUnixSeconds(
  microsecondsSince1601: number | string,
): number | undefined {
  const microseconds =
    typeof microsecondsSince1601 === "string"
      ? Number(microsecondsSince1601)
      : microsecondsSince1601;
  if (!Number.isFinite(microseconds) || microseconds <= 0) return undefined;
  const seconds = Math.floor(microseconds / 1_000_000) - WINDOWS_EPOCH_OFFSET_SECONDS;
  return seconds > 0 ? seconds : undefined;
}
