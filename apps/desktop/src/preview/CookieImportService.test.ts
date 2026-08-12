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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { describe } from "vite-plus/test";

import { mapChromiumCookie } from "./CookieImportMapping.ts";
import { isPermissionDenied, readCookieRows } from "./CookieImportService.ts";

/** Well past 2255, which is where the microsecond epoch stops fitting a double. */
const OVERFLOWING_EXPIRY = "13500000000000000";
const SAFE_EXPIRY = "13350000000000000";

const NOW_SECONDS = 1_700_000_000;

/** Typed so a fixture that cannot be written fails as itself, not as a defect. */
class FixtureError extends Schema.TaggedErrorClass<FixtureError>()("FixtureError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fixtureFailure = (cause: unknown) =>
  new FixtureError({ detail: cause instanceof Error ? cause.message : String(cause) });

/**
 * Writes a database with Chromium's own column types — `expires_utc` as
 * INTEGER, which is what makes the overflow reachable at all — and reads it
 * back through the production reader.
 */
const readFixture = Effect.fn("test.readFixture")(function* (
  rows: ReadonlyArray<{
    readonly host_key: string;
    readonly name: string;
    readonly expires_utc: string;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-cookie-test-" });
  const databasePath = path.join(directory, "Cookies");

  yield* Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(databasePath);
      try {
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
    },
    catch: fixtureFailure,
  });

  return yield* Effect.try({
    try: () => readCookieRows(databasePath),
    catch: fixtureFailure,
  });
});

const runFixture = (
  rows: ReadonlyArray<{
    readonly host_key: string;
    readonly name: string;
    readonly expires_utc: string;
  }>,
) => readFixture(rows).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("readCookieRows", () => {
  it.effect("reads a cookie whose expiry overflows a JavaScript number", () =>
    Effect.gen(function* () {
      // Regression: this threw ERR_OUT_OF_RANGE and failed the entire import,
      // surfacing as "the cookie database could not be opened".
      const rows = yield* runFixture([
        { host_key: ".example.com", name: "session", expires_utc: OVERFLOWING_EXPIRY },
      ]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.expires_utc, OVERFLOWING_EXPIRY);
    }),
  );

  it.effect("returns every row rather than stopping at the first unreadable one", () =>
    Effect.gen(function* () {
      // The original failure was not a dropped row but an abandoned import: one
      // bad value took the other few thousand cookies with it.
      const rows = yield* runFixture([
        { host_key: ".a.com", name: "one", expires_utc: SAFE_EXPIRY },
        { host_key: ".b.com", name: "two", expires_utc: OVERFLOWING_EXPIRY },
        { host_key: ".c.com", name: "three", expires_utc: SAFE_EXPIRY },
      ]);
      assert.deepStrictEqual(
        rows.map((row) => row.name),
        ["one", "two", "three"],
      );
    }),
  );

  it.effect("hands the mapper a value it can turn into a live cookie", () =>
    Effect.gen(function* () {
      // Reading the row is only half of it: the string has to survive mapping,
      // or a successful read still produces zero imported cookies.
      const rows = yield* runFixture([
        { host_key: ".example.com", name: "session", expires_utc: OVERFLOWING_EXPIRY },
      ]);
      const mapping = mapChromiumCookie({ row: rows[0]!, value: "abc", nowSeconds: NOW_SECONDS });
      assert.strictEqual(mapping.kind, "write");
      assert.strictEqual(mapping.kind === "write" && mapping.cookie.domain, ".example.com");
    }),
  );

  it.effect("reads a session cookie, which has no expiry at all", () =>
    Effect.gen(function* () {
      const rows = yield* runFixture([
        { host_key: ".example.com", name: "session", expires_utc: "0" },
      ]);
      const mapping = mapChromiumCookie({ row: rows[0]!, value: "abc", nowSeconds: NOW_SECONDS });
      assert.strictEqual(mapping.kind, "write");
      assert.strictEqual(mapping.kind === "write" && "expirationDate" in mapping.cookie, false);
    }),
  );
});

describe("isPermissionDenied", () => {
  it("recognises Effect's SystemError, which never mentions the errno", () => {
    // The original check looked for "EPERM" in the message and therefore
    // missed every Effect filesystem error, reporting a blocked read as a
    // corrupt cookie jar.
    assert.isTrue(isPermissionDenied({ _tag: "SystemError", reason: "PermissionDenied" }));
  });

  it("recognises a raw Node error", () => {
    assert.isTrue(isPermissionDenied(Object.assign(new Error("open failed"), { code: "EPERM" })));
    assert.isTrue(isPermissionDenied(Object.assign(new Error("open failed"), { code: "EACCES" })));
    assert.isTrue(isPermissionDenied(new Error("EPERM: operation not permitted, open '/x'")));
  });

  it("does not claim a missing or corrupt file is a permissions problem", () => {
    assert.isFalse(isPermissionDenied(new Error("ENOENT: no such file or directory")));
    assert.isFalse(isPermissionDenied({ _tag: "SystemError", reason: "NotFound" }));
    assert.isFalse(isPermissionDenied(null));
  });
});
