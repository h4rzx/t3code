import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  chromiumExpiryToUnixSeconds,
  decryptChromiumCookieValue,
  deriveChromiumKey,
  isDeviceBoundCookieName,
  LINUX_PBKDF2_ITERATIONS,
  LINUX_V10_PASSWORD,
  MACOS_PBKDF2_ITERATIONS,
  readEncryptionVersion,
  stripDomainHashPrefix,
} from "./CookieDecrypt.ts";

const CBC_IV = Buffer.alloc(16, " ");

const encryptCbc = (value: string | Buffer, key: Buffer, version: "v10" | "v11"): Buffer => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, CBC_IV);
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([Buffer.from(version, "utf8"), cipher.update(body), cipher.final()]);
};

const encryptGcm = (value: string, key: Buffer): Buffer => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "utf8"), nonce, body, cipher.getAuthTag()]);
};

describe("chromium cookie decryption", () => {
  const macKey = deriveChromiumKey("keychain-secret", MACOS_PBKDF2_ITERATIONS);

  it("round-trips a macOS AES-128-CBC value", () => {
    const encrypted = encryptCbc("session=abc123", macKey, "v10");
    expect(decryptChromiumCookieValue(encrypted, { key: macKey, mode: "aes-128-cbc" })).toBe(
      "session=abc123",
    );
  });

  it("round-trips a Windows AES-256-GCM value", () => {
    const key = NodeCrypto.randomBytes(32);
    expect(
      decryptChromiumCookieValue(encryptGcm("token=xyz", key), { key, mode: "aes-256-gcm" }),
    ).toBe("token=xyz");
  });

  it("uses the peanuts key for Linux v10 and the keyring key for v11", () => {
    const v10Key = deriveChromiumKey(LINUX_V10_PASSWORD, LINUX_PBKDF2_ITERATIONS);
    const v11Key = deriveChromiumKey("keyring-secret", LINUX_PBKDF2_ITERATIONS);
    const keys = { key: v11Key, mode: "aes-128-cbc", fallbackKey: v10Key } as const;
    expect(decryptChromiumCookieValue(encryptCbc("a=1", v10Key, "v10"), keys)).toBe("a=1");
    expect(decryptChromiumCookieValue(encryptCbc("b=2", v11Key, "v11"), keys)).toBe("b=2");
  });

  it("drops a value it cannot decrypt rather than emitting garbage", () => {
    const wrongKey = deriveChromiumKey("not-the-secret", MACOS_PBKDF2_ITERATIONS);
    const encrypted = encryptCbc("session=abc123", macKey, "v10");
    const decrypted = decryptChromiumCookieValue(encrypted, {
      key: wrongKey,
      mode: "aes-128-cbc",
    });
    expect(decrypted === null || decrypted !== "session=abc123").toBe(true);
  });

  it("passes through values written before encryption was enabled", () => {
    expect(
      decryptChromiumCookieValue(Buffer.from("plain", "utf8"), {
        key: macKey,
        mode: "aes-128-cbc",
      }),
    ).toBe("plain");
    expect(readEncryptionVersion(Buffer.from("plain", "utf8"))).toBeNull();
  });

  it("strips the Chrome 130+ domain hash prefix but leaves printable values alone", () => {
    const hash = NodeCrypto.randomBytes(32).map((byte) =>
      byte >= 0x20 && byte <= 0x7e ? 0x01 : byte,
    );
    const withPrefix = Buffer.concat([Buffer.from(hash), Buffer.from("value", "utf8")]);
    expect(stripDomainHashPrefix(withPrefix).toString("utf8")).toBe("value");

    const printable = Buffer.from("a".repeat(40), "utf8");
    expect(stripDomainHashPrefix(printable).toString("utf8")).toBe("a".repeat(40));
  });
});

describe("cookie policy and timestamps", () => {
  it("excludes device-bound cookies that cannot transfer", () => {
    expect(isDeviceBoundCookieName("SIDCC")).toBe(true);
    expect(isDeviceBoundCookieName("__Secure-1PSIDCC")).toBe(true);
    expect(isDeviceBoundCookieName("session")).toBe(false);
  });

  it("converts Chromium's 1601-epoch microseconds to unix seconds", () => {
    // 2021-01-01T00:00:00Z is 1609459200 unix, i.e. 13253932800 seconds since 1601.
    expect(chromiumExpiryToUnixSeconds(13_253_932_800_000_000)).toBe(1_609_459_200);
  });

  it("treats session cookies as having no expiry", () => {
    expect(chromiumExpiryToUnixSeconds(0)).toBeUndefined();
  });

  it("accepts timestamps read as text, which is how they arrive from SQLite", () => {
    expect(chromiumExpiryToUnixSeconds("13253932800000000")).toBe(1_609_459_200);
  });

  it("handles values past Number.MAX_SAFE_INTEGER", () => {
    // A real Brave cookie expiry; 85% of a live profile exceeds 2^53, and
    // reading these as numbers throws ERR_OUT_OF_RANGE before any parsing.
    const raw = "13432929434153692";
    expect(Number(raw)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const seconds = chromiumExpiryToUnixSeconds(raw);
    // 2026-01-05T13:17:14Z — sanity-check the decade, not the microsecond.
    expect(seconds).toBeGreaterThan(1_700_000_000);
    expect(seconds).toBeLessThan(2_000_000_000);
  });

  it("ignores garbage rather than producing NaN expiries", () => {
    expect(chromiumExpiryToUnixSeconds("not-a-number")).toBeUndefined();
    expect(chromiumExpiryToUnixSeconds("-5")).toBeUndefined();
  });
});
