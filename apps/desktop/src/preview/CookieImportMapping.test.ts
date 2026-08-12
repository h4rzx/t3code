import { describe, expect, it } from "vite-plus/test";

import {
  cookieUrl,
  describeCookieWriteFailure,
  emptyImportSummary,
  mapChromiumCookie,
  mapSameSite,
  tallyMapping,
  type ChromiumCookieRow,
} from "./CookieImportMapping.ts";

const NOW = 1_700_000_000;
const FUTURE_CHROMIUM_MICROS = (1_900_000_000 + 11_644_473_600) * 1_000_000;

const row = (overrides: Partial<ChromiumCookieRow> = {}): ChromiumCookieRow => ({
  host_key: ".example.com",
  name: "session",
  path: "/",
  is_secure: 1,
  is_httponly: 1,
  expires_utc: FUTURE_CHROMIUM_MICROS,
  samesite: 1,
  ...overrides,
});

describe("cookieUrl", () => {
  it("drops the leading dot and picks the scheme from the secure flag", () => {
    expect(cookieUrl(".example.com", "/app", true)).toBe("https://example.com/app");
    expect(cookieUrl("example.com", "/", false)).toBe("http://example.com/");
  });

  it("rejects hosts that cannot form a URL", () => {
    expect(cookieUrl("", "/", true)).toBeNull();
    expect(cookieUrl("bad host", "/", true)).toBeNull();
    expect(cookieUrl("example.com/path", "/", true)).toBeNull();
  });
});

describe("mapSameSite", () => {
  it("maps Chromium's column, treating unspecified as lax", () => {
    expect(mapSameSite(0)).toBe("no_restriction");
    expect(mapSameSite(1)).toBe("lax");
    expect(mapSameSite(2)).toBe("strict");
    expect(mapSameSite(-1)).toBe("lax");
  });
});

describe("mapChromiumCookie", () => {
  it("maps a live cookie into an Electron write", () => {
    const mapping = mapChromiumCookie({ row: row(), value: "abc123", nowSeconds: NOW });
    expect(mapping).toEqual({
      kind: "write",
      cookie: {
        url: "https://example.com/",
        name: "session",
        value: "abc123",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: 1_900_000_000,
        sameSite: "lax",
      },
    });
  });

  it("keeps session cookies, which have no expiry", () => {
    const mapping = mapChromiumCookie({
      row: row({ expires_utc: 0 }),
      value: "abc",
      nowSeconds: NOW,
    });
    expect(mapping.kind).toBe("write");
    expect(mapping.kind === "write" && "expirationDate" in mapping.cookie).toBe(false);
  });

  it("drops device-bound cookies even when they decrypt", () => {
    expect(mapChromiumCookie({ row: row({ name: "SIDCC" }), value: "x", nowSeconds: NOW })).toEqual(
      { kind: "skip", reason: "device_bound" },
    );
  });

  it("drops values that failed to decrypt rather than writing garbage", () => {
    expect(mapChromiumCookie({ row: row(), value: null, nowSeconds: NOW })).toEqual({
      kind: "skip",
      reason: "decryption_failed",
    });
  });

  it("drops already-expired and malformed cookies", () => {
    const expired = (1_600_000_000 + 11_644_473_600) * 1_000_000;
    expect(
      mapChromiumCookie({ row: row({ expires_utc: expired }), value: "x", nowSeconds: NOW }).kind,
    ).toBe("skip");
    expect(mapChromiumCookie({ row: row({ host_key: "" }), value: "x", nowSeconds: NOW })).toEqual({
      kind: "skip",
      reason: "invalid_domain",
    });
    expect(mapChromiumCookie({ row: row({ name: "" }), value: "x", nowSeconds: NOW })).toEqual({
      kind: "skip",
      reason: "empty_name",
    });
  });
});

describe("tallyMapping", () => {
  it("counts what was imported and why the rest was not", () => {
    const mappings = [
      mapChromiumCookie({ row: row(), value: "a", nowSeconds: NOW }),
      mapChromiumCookie({ row: row({ name: "AEC" }), value: "b", nowSeconds: NOW }),
      mapChromiumCookie({ row: row(), value: null, nowSeconds: NOW }),
    ];
    const summary = mappings.reduce(tallyMapping, emptyImportSummary());
    expect(summary.imported).toBe(1);
    expect(summary.skipped.device_bound).toBe(1);
    expect(summary.skipped.decryption_failed).toBe(1);
  });
});

describe("describeCookieWriteFailure", () => {
  it("reads a domain rejection as a domain problem", () => {
    expect(
      describeCookieWriteFailure(
        new Error("Failed to set cookie with an invalid domain attribute"),
      ),
    ).toBe("invalid_domain");
  });

  it("treats anything else as a dropped cookie", () => {
    // Filing this under the domain hid the only bucket that represents a
    // working cookie the user lost.
    expect(describeCookieWriteFailure(new Error("Failed to parse cookie"))).toBe("rejected");
  });

  it("does not depend on the cause being an Error", () => {
    expect(describeCookieWriteFailure("Setting cookie failed")).toBe("rejected");
    expect(describeCookieWriteFailure({ message: "bad URL for cookie" })).toBe("invalid_domain");
    expect(describeCookieWriteFailure(undefined)).toBe("rejected");
  });
});
