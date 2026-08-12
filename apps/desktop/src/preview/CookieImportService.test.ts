/**
 * The seam the unit tests cannot reach.
 *
 * `CookieDecrypt`, `CookieImportMapping`, and `SafariCookies` are pure and well
 * covered, and the suite stayed green through a bug that broke every Chromium
 * import on real profiles: `expires_utc` is microseconds since 1601, which
 * exceeds `Number.MAX_SAFE_INTEGER` for anything expiring past 2255, and
 * `node:sqlite` throws `ERR_OUT_OF_RANGE` on the first such row. Roughly 85% of
 * rows in a real profile were affected.
 *
 * Nothing pure could have caught it, because the failure lived entirely in the
 * shape of the SQL. These tests build an actual Chromium-shaped database and
 * read it back.
 */
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe } from "vite-plus/test";

import { mapChromiumCookie } from "./CookieImportMapping.ts";
import { readCookieRows } from "./CookieImportService.ts";

/** Well past 2255, which is where the microsecond epoch stops fitting a double. */
const OVERFLOWING_EXPIRY = "13500000000000000";
const SAFE_EXPIRY = "13350000000000000";

const withChromiumDatabase = <A>(
  rows: ReadonlyArray<{
    readonly host_key: string;
    readonly name: string;
    readonly expires_utc: string;
  }>,
  use: (databasePath: string) => A,
): A => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-cookie-test-"));
  const databasePath = NodePath.join(directory, "Cookies");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    // The columns the reader selects, in Chromium's own types: expires_utc is
    // INTEGER, which is what makes the overflow reachable at all.
    database.exec(`CREATE TABLE cookies (
      host_key TEXT, name TEXT, path TEXT, is_secure INTEGER, is_httponly INTEGER,
      expires_utc INTEGER, samesite INTEGER, value TEXT, encrypted_value BLOB
    )`);
    for (const row of rows) {
      // Written as a SQL literal rather than a bound parameter, so the driver
      // never has to represent the value as a double on the way in. Chromium
      // stores these as plain integers, and reproducing that is the point.
      database.exec(
        `INSERT INTO cookies VALUES ('${row.host_key}', '${row.name}', '/', 1, 1, ${row.expires_utc}, 1, 'v', X'')`,
      );
    }
  } finally {
    database.close();
  }
  try {
    return use(databasePath);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

describe("readCookieRows", () => {
  it("reads a cookie whose expiry overflows a JavaScript number", () => {
    // Regression: this threw ERR_OUT_OF_RANGE and failed the entire import,
    // surfacing as "the cookie database could not be opened".
    const rows = withChromiumDatabase(
      [{ host_key: ".example.com", name: "session", expires_utc: OVERFLOWING_EXPIRY }],
      readCookieRows,
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]?.expires_utc, OVERFLOWING_EXPIRY);
  });

  it("returns every row rather than stopping at the first unreadable one", () => {
    // The original failure was not a dropped row but an abandoned import: one
    // bad value took the other few thousand cookies with it.
    const rows = withChromiumDatabase(
      [
        { host_key: ".a.com", name: "one", expires_utc: SAFE_EXPIRY },
        { host_key: ".b.com", name: "two", expires_utc: OVERFLOWING_EXPIRY },
        { host_key: ".c.com", name: "three", expires_utc: SAFE_EXPIRY },
      ],
      readCookieRows,
    );
    assert.deepStrictEqual(
      rows.map((row) => row.name),
      ["one", "two", "three"],
    );
  });

  it("hands the mapper a value it can turn into a live cookie", () => {
    // Reading the row is only half of it: the string has to survive mapping,
    // or a successful read still produces zero imported cookies.
    const rows = withChromiumDatabase(
      [{ host_key: ".example.com", name: "session", expires_utc: OVERFLOWING_EXPIRY }],
      readCookieRows,
    );
    const mapping = mapChromiumCookie({
      row: rows[0]!,
      value: "abc",
      nowSeconds: 1_700_000_000,
    });
    assert.strictEqual(mapping.kind, "write");
    assert.strictEqual(mapping.kind === "write" && mapping.cookie.domain, ".example.com");
  });

  it("reads a session cookie, which has no expiry at all", () => {
    const rows = withChromiumDatabase(
      [{ host_key: ".example.com", name: "session", expires_utc: "0" }],
      readCookieRows,
    );
    const mapping = mapChromiumCookie({
      row: rows[0]!,
      value: "abc",
      nowSeconds: 1_700_000_000,
    });
    assert.strictEqual(mapping.kind, "write");
    assert.strictEqual(mapping.kind === "write" && "expirationDate" in mapping.cookie, false);
  });
});
