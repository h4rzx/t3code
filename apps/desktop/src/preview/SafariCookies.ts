/**
 * Safari's `Cookies.binarycookies` format.
 *
 * Safari is not Chromium: one binary jar, no per-profile split, and no
 * encryption, so there is no Keychain step. The layout is:
 *
 *   file   "cook" | pageCount (BE) | pageSize[pageCount] (BE) | pages…
 *   page   0x00000100 (BE) | cookieCount (LE) | offset[cookieCount] (LE) | cookies…
 *   cookie size (LE) | flags (LE) | url/name/path/value offsets (LE) | expiry (double LE)
 *
 * Note the endianness switch: the file header is big-endian, everything inside
 * a page is little-endian. Offsets inside a cookie are relative to the start of
 * that cookie record, and strings are NUL-terminated.
 *
 * Everything here is pure and takes bytes, so the parser is tested against
 * hand-built fixtures rather than a real Safari profile.
 */

/** Safari stores dates as seconds since 2001-01-01, not the Unix epoch. */
export const MAC_EPOCH_DELTA_SECONDS = 978_307_200;

const FILE_MAGIC = "cook";
const PAGE_HEADER = 0x0000_0100;
/** Offsets are 4 bytes each and the fixed cookie header runs to byte 48. */
const COOKIE_HEADER_BYTES = 48;

export interface SafariCookie {
  readonly name: string;
  readonly value: string;
  /** Safari keeps the domain in the record's URL field; there is no domain column. */
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Unix seconds, or undefined for a session cookie. */
  readonly expirationDate?: number | undefined;
}

/**
 * Reads a NUL-terminated string, refusing to run past `end`. Offsets come from
 * the file and cannot be trusted to stay inside the record.
 */
export function readCString(buffer: Buffer, offset: number, end: number): string | null {
  if (offset < 0 || offset >= end) return null;
  let cursor = offset;
  while (cursor < end && buffer[cursor] !== 0) cursor++;
  if (cursor >= end) return null;
  return buffer.toString("utf8", offset, cursor);
}

export function decodeSafariCookie(record: Buffer): SafariCookie | null {
  if (record.length < COOKIE_HEADER_BYTES) return null;
  // The declared size is attacker-controllable; clamp it so string reads stay
  // inside the buffer we were handed.
  const size = Math.min(record.readUInt32LE(0), record.length);
  if (size < COOKIE_HEADER_BYTES) return null;

  const flags = record.readUInt32LE(8);
  const secure = (flags & 1) !== 0;
  const httpOnly = (flags & 4) !== 0;

  const urlOffset = record.readUInt32LE(16);
  const nameOffset = record.readUInt32LE(20);
  const pathOffset = record.readUInt32LE(24);
  const valueOffset = record.readUInt32LE(28);

  const name = readCString(record, nameOffset, size);
  if (name === null || name.length === 0) return null;
  const domain = readCString(record, urlOffset, size);
  if (domain === null || domain.length === 0) return null;

  const expiry = record.readDoubleLE(40);
  const expirationDate = expiry > 0 ? Math.round(expiry + MAC_EPOCH_DELTA_SECONDS) : undefined;

  return {
    name,
    value: readCString(record, valueOffset, size) ?? "",
    domain,
    path: readCString(record, pathOffset, size) ?? "/",
    secure,
    httpOnly,
    expirationDate,
  };
}

function decodeSafariPage(page: Buffer): ReadonlyArray<SafariCookie> {
  if (page.length < 16) return [];
  if (page.readUInt32BE(0) !== PAGE_HEADER) return [];

  const cookieCount = page.readUInt32LE(4);
  if (8 + cookieCount * 4 > page.length) return [];

  const cookies: Array<SafariCookie> = [];
  for (let index = 0; index < cookieCount; index++) {
    const offset = page.readUInt32LE(8 + index * 4);
    if (offset >= page.length) continue;
    const cookie = decodeSafariCookie(page.subarray(offset));
    if (cookie !== null) cookies.push(cookie);
  }
  return cookies;
}

/**
 * Parses a whole `Cookies.binarycookies` file. A malformed page yields no
 * cookies rather than aborting the file: partial recovery beats none when the
 * jar is being written concurrently by Safari.
 */
export function decodeSafariBinaryCookies(buffer: Buffer): ReadonlyArray<SafariCookie> {
  if (buffer.length < 8) return [];
  if (buffer.subarray(0, 4).toString("utf8") !== FILE_MAGIC) return [];

  const pageCount = buffer.readUInt32BE(4);
  let cursor = 8;
  if (cursor + pageCount * 4 > buffer.length) return [];

  const pageSizes: Array<number> = [];
  for (let index = 0; index < pageCount; index++) {
    pageSizes.push(buffer.readUInt32BE(cursor));
    cursor += 4;
  }

  const cookies: Array<SafariCookie> = [];
  for (const pageSize of pageSizes) {
    const page = buffer.subarray(cursor, cursor + pageSize);
    cursor += pageSize;
    for (const cookie of decodeSafariPage(page)) cookies.push(cookie);
  }
  return cookies;
}
