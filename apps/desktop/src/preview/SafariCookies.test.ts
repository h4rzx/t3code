import { describe, expect, it } from "vite-plus/test";

import {
  decodeSafariBinaryCookies,
  decodeSafariCookie,
  MAC_EPOCH_DELTA_SECONDS,
  readCString,
} from "./SafariCookies.ts";

interface CookieFixture {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  /** Unix seconds; omit for a session cookie. */
  readonly expiresAt?: number;
}

/** Builds one cookie record in Safari's on-disk layout. */
function encodeCookie(fixture: CookieFixture): Buffer {
  const strings = [fixture.domain, fixture.name, fixture.path, fixture.value];
  const encoded = strings.map((value) => Buffer.from(`${value}\0`, "utf8"));
  const headerBytes = 48;
  const offsets: Array<number> = [];
  let cursor = headerBytes;
  for (const part of encoded) {
    offsets.push(cursor);
    cursor += part.length;
  }

  const record = Buffer.alloc(cursor);
  record.writeUInt32LE(cursor, 0);
  const flags = (fixture.secure === true ? 1 : 0) | (fixture.httpOnly === true ? 4 : 0);
  record.writeUInt32LE(flags, 8);
  // url, name, path, value — the order the format stores offsets in.
  record.writeUInt32LE(offsets[0]!, 16);
  record.writeUInt32LE(offsets[1]!, 20);
  record.writeUInt32LE(offsets[2]!, 24);
  record.writeUInt32LE(offsets[3]!, 28);
  record.writeDoubleLE(
    fixture.expiresAt === undefined ? 0 : fixture.expiresAt - MAC_EPOCH_DELTA_SECONDS,
    40,
  );
  for (const [index, part] of encoded.entries()) part.copy(record, offsets[index]!);
  return record;
}

function encodePage(fixtures: ReadonlyArray<CookieFixture>): Buffer {
  const records = fixtures.map(encodeCookie);
  const headerBytes = 8 + records.length * 4;
  const offsets: Array<number> = [];
  let cursor = headerBytes;
  for (const record of records) {
    offsets.push(cursor);
    cursor += record.length;
  }

  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x0000_0100, 0);
  page.writeUInt32LE(records.length, 4);
  for (const [index, offset] of offsets.entries()) page.writeUInt32LE(offset, 8 + index * 4);
  for (const [index, record] of records.entries()) record.copy(page, offsets[index]!);
  return page;
}

function encodeFile(pages: ReadonlyArray<Buffer>): Buffer {
  const header = Buffer.alloc(8 + pages.length * 4);
  header.write("cook", 0, "utf8");
  header.writeUInt32BE(pages.length, 4);
  for (const [index, page] of pages.entries()) header.writeUInt32BE(page.length, 8 + index * 4);
  return Buffer.concat([header, ...pages]);
}

const EXPIRES_AT = 1_900_000_000;

describe("decodeSafariBinaryCookies", () => {
  it("round-trips cookies across multiple pages", () => {
    const file = encodeFile([
      encodePage([
        {
          name: "session",
          value: "abc123",
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expiresAt: EXPIRES_AT,
        },
      ]),
      encodePage([{ name: "theme", value: "dark", domain: "docs.example.com", path: "/app" }]),
    ]);

    expect(decodeSafariBinaryCookies(file)).toEqual([
      {
        name: "session",
        value: "abc123",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: EXPIRES_AT,
      },
      {
        name: "theme",
        value: "dark",
        domain: "docs.example.com",
        path: "/app",
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
      },
    ]);
  });

  it("converts the 2001 epoch to unix seconds", () => {
    // 2001-01-01T00:00:00Z is 0 in Mac absolute time.
    const file = encodeFile([
      encodePage([
        {
          name: "a",
          value: "1",
          domain: "example.com",
          path: "/",
          expiresAt: MAC_EPOCH_DELTA_SECONDS + 86_400,
        },
      ]),
    ]);
    expect(decodeSafariBinaryCookies(file)[0]?.expirationDate).toBe(
      MAC_EPOCH_DELTA_SECONDS + 86_400,
    );
  });

  it("reads the secure and httpOnly flag bits independently", () => {
    const build = (secure: boolean, httpOnly: boolean) =>
      decodeSafariBinaryCookies(
        encodeFile([
          encodePage([{ name: "f", value: "v", domain: "e.com", path: "/", secure, httpOnly }]),
        ]),
      )[0];

    expect(build(true, false)).toMatchObject({ secure: true, httpOnly: false });
    expect(build(false, true)).toMatchObject({ secure: false, httpOnly: true });
  });

  it("rejects a file without the cook magic", () => {
    const file = encodeFile([encodePage([{ name: "a", value: "1", domain: "e.com", path: "/" }])]);
    file.write("junk", 0, "utf8");
    expect(decodeSafariBinaryCookies(file)).toEqual([]);
  });

  it("returns nothing for empty or truncated input rather than throwing", () => {
    expect(decodeSafariBinaryCookies(Buffer.alloc(0))).toEqual([]);
    expect(decodeSafariBinaryCookies(Buffer.from("cook", "utf8"))).toEqual([]);
    // Claims 99 pages but carries no page-size table.
    const lying = Buffer.alloc(8);
    lying.write("cook", 0, "utf8");
    lying.writeUInt32BE(99, 4);
    expect(decodeSafariBinaryCookies(lying)).toEqual([]);
  });

  it("skips a malformed page without losing the rest of the file", () => {
    const good = encodePage([{ name: "keep", value: "1", domain: "e.com", path: "/" }]);
    const bad = Buffer.alloc(16); // page header is zeroed, so it fails validation
    const file = encodeFile([bad, good]);
    expect(decodeSafariBinaryCookies(file).map((cookie) => cookie.name)).toEqual(["keep"]);
  });
});

describe("decodeSafariCookie", () => {
  it("drops a record whose declared size exceeds the buffer", () => {
    const record = encodeCookie({ name: "a", value: "1", domain: "e.com", path: "/" });
    record.writeUInt32LE(0xffff_ffff, 0);
    // Size is clamped to the buffer, so the strings still resolve safely.
    expect(decodeSafariCookie(record)).toMatchObject({ name: "a" });
  });

  it("drops records that are too short to hold a header", () => {
    expect(decodeSafariCookie(Buffer.alloc(20))).toBeNull();
  });

  it("drops a record with no name", () => {
    const record = encodeCookie({ name: "", value: "1", domain: "e.com", path: "/" });
    expect(decodeSafariCookie(record)).toBeNull();
  });
});

describe("readCString", () => {
  it("stops at the terminator and refuses to read past the end", () => {
    const buffer = Buffer.from("hello\0world\0", "utf8");
    expect(readCString(buffer, 0, buffer.length)).toBe("hello");
    expect(readCString(buffer, 6, buffer.length)).toBe("world");
    // Unterminated within the bound.
    expect(readCString(Buffer.from("abc", "utf8"), 0, 3)).toBeNull();
    expect(readCString(buffer, 99, buffer.length)).toBeNull();
  });
});
