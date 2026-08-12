/**
 * Turning Chromium cookie rows into Electron cookie writes.
 *
 * Kept separate from the I/O so the policy — what transfers, what is dropped,
 * and what URL a cookie is attributed to — can be tested without a browser
 * profile, a Keychain, or a live session.
 */
import { chromiumExpiryToUnixSeconds, isDeviceBoundCookieName } from "./CookieDecrypt.ts";

/** One row of Chromium's `cookies` table, as read from the SQLite file. */
export interface ChromiumCookieRow {
  readonly host_key: string;
  readonly name: string;
  readonly path: string;
  readonly is_secure: number;
  readonly is_httponly: number;
  /** Text, not a number: the raw value overflows JS integers. */
  readonly expires_utc: number | string;
  readonly samesite: number;
}

export interface ElectronCookieWrite {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate?: number;
  readonly sameSite: "no_restriction" | "lax" | "strict";
}

/**
 * A cookie already reduced to Electron's shape. Safari and Firefox produce
 * these directly, since neither needs decryption or Chromium's column layout.
 */
export function mappingFromCookie(input: {
  readonly cookie: Omit<ElectronCookieWrite, "url">;
  readonly nowSeconds: number;
}): CookieMapping {
  const { cookie } = input;
  if (cookie.name.length === 0) return { kind: "skip", reason: "empty_name" };
  if (isDeviceBoundCookieName(cookie.name)) return { kind: "skip", reason: "device_bound" };
  if (cookie.expirationDate !== undefined && cookie.expirationDate <= input.nowSeconds) {
    return { kind: "skip", reason: "expired" };
  }
  const url = cookieUrl(cookie.domain, cookie.path, cookie.secure);
  if (url === null) return { kind: "skip", reason: "invalid_domain" };
  return { kind: "write", cookie: { ...cookie, url } };
}

export type CookieSkipReason =
  | "device_bound"
  | "decryption_failed"
  | "expired"
  | "invalid_domain"
  | "empty_name";

export type CookieMapping =
  | { readonly kind: "write"; readonly cookie: ElectronCookieWrite }
  | { readonly kind: "skip"; readonly reason: CookieSkipReason };

/**
 * Chromium's samesite column: -1 unspecified, 0 none, 1 lax, 2 strict.
 * Unspecified maps to lax, matching how a browser treats it in practice.
 */
export function mapSameSite(samesite: number): ElectronCookieWrite["sameSite"] {
  switch (samesite) {
    case 0:
      return "no_restriction";
    case 2:
      return "strict";
    default:
      return "lax";
  }
}

/**
 * Electron identifies a cookie by URL rather than domain. A leading dot means
 * "and subdomains", which is not part of the host, so it is stripped for the
 * URL while the original domain is preserved on the write.
 */
export function cookieUrl(hostKey: string, path: string, secure: boolean): string | null {
  const host = hostKey.replace(/^\./, "").trim();
  if (host.length === 0 || host.includes("/") || host.includes(" ")) return null;
  const scheme = secure ? "https" : "http";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  try {
    return new URL(`${scheme}://${host}${normalizedPath}`).toString();
  } catch {
    return null;
  }
}

export function mapChromiumCookie(input: {
  readonly row: ChromiumCookieRow;
  readonly value: string | null;
  readonly nowSeconds: number;
}): CookieMapping {
  const { row, value } = input;
  if (row.name.length === 0) return { kind: "skip", reason: "empty_name" };
  // Device-bound cookies are checked before decryption cost matters, and are
  // dropped even when they decrypt: they do not work off their origin device.
  if (isDeviceBoundCookieName(row.name)) return { kind: "skip", reason: "device_bound" };
  if (value === null) return { kind: "skip", reason: "decryption_failed" };

  const expirationDate = chromiumExpiryToUnixSeconds(row.expires_utc);
  if (expirationDate !== undefined && expirationDate <= input.nowSeconds) {
    return { kind: "skip", reason: "expired" };
  }

  const secure = row.is_secure === 1;
  const url = cookieUrl(row.host_key, row.path, secure);
  if (url === null) return { kind: "skip", reason: "invalid_domain" };

  return {
    kind: "write",
    cookie: {
      url,
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path.length > 0 ? row.path : "/",
      secure,
      httpOnly: row.is_httponly === 1,
      ...(expirationDate === undefined ? {} : { expirationDate }),
      sameSite: mapSameSite(row.samesite),
    },
  };
}

export interface CookieImportSummary {
  readonly imported: number;
  readonly skipped: Record<CookieSkipReason, number>;
}

export const emptyImportSummary = (): CookieImportSummary => ({
  imported: 0,
  skipped: {
    device_bound: 0,
    decryption_failed: 0,
    expired: 0,
    invalid_domain: 0,
    empty_name: 0,
  },
});

export function tallyMapping(
  summary: CookieImportSummary,
  mapping: CookieMapping,
): CookieImportSummary {
  if (mapping.kind === "write") return { ...summary, imported: summary.imported + 1 };
  return {
    ...summary,
    skipped: { ...summary.skipped, [mapping.reason]: summary.skipped[mapping.reason] + 1 },
  };
}
