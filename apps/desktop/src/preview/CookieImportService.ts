/**
 * Reads cookies out of an installed browser and into a preview session.
 *
 * This is the I/O half of cookie import: Keychain lookup, reading the profile's
 * SQLite file, and writing to Electron's cookie jar. Format and policy live in
 * `CookieDecrypt.ts` and `CookieImportMapping.ts`, which are pure and tested.
 *
 * Two deliberate constraints:
 *   - The cookie database is copied before reading. Chromium holds a lock while
 *     running, and a live read is an inconsistent read.
 *   - Import is only reachable through an explicit user action in Settings.
 *     Nothing here is exposed to agents; copying live logins is the human's call.
 */
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeSqlite from "node:sqlite";

import {
  decryptChromiumCookieValue,
  deriveChromiumKey,
  LINUX_PBKDF2_ITERATIONS,
  LINUX_V10_PASSWORD,
  MACOS_PBKDF2_ITERATIONS,
  type ChromiumDecryptionKeys,
} from "./CookieDecrypt.ts";
import { decodeSafariBinaryCookies } from "./SafariCookies.ts";
import {
  browserApplicationPaths,
  browserRootPath,
  chromiumCookieCandidatePaths,
  CHROMIUM_BROWSERS,
  describeFirefoxProfiles,
  describeProfiles,
  firefoxProfilesRoot,
  safariCookieCandidatePaths,
  type BrowserProfile,
  type ChromiumBrowserDefinition,
  type CookieImportPaths,
  type CookieImportPlatform,
} from "./CookieImportCatalog.ts";
import {
  emptyImportSummary,
  mapChromiumCookie,
  mappingFromCookie,
  tallyMapping,
  type ChromiumCookieRow,
  type CookieImportSummary,
  type ElectronCookieWrite,
} from "./CookieImportMapping.ts";

export class CookieImportError extends Schema.TaggedErrorClass<CookieImportError>()(
  "CookieImportError",
  {
    reason: Schema.Literals([
      "keychain_unavailable",
      "database_unreadable",
      "permission_denied",
      "unsupported_platform",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const decodeUtf8 = (chunks: ReadonlyArray<Uint8Array>): string =>
  new TextDecoder().decode(
    chunks.reduce<Uint8Array>((accumulator, chunk) => {
      const merged = new Uint8Array(accumulator.length + chunk.length);
      merged.set(accumulator);
      merged.set(chunk, accumulator.length);
      return merged;
    }, new Uint8Array()),
  );

/**
 * The macOS Keychain holds the encryption password under the browser's
 * "Safe Storage" entry. Reading it prompts the user the first time, which is
 * an OS-level consent gate on top of our own.
 */
const readMacKeychainPassword = Effect.fn("desktop.cookieImport.readKeychainPassword")(function* (
  definition: ChromiumBrowserDefinition,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(
    "security",
    [
      "find-generic-password",
      "-w",
      "-s",
      definition.keychainService,
      "-a",
      definition.keychainAccount,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const failure = new CookieImportError({
    reason: "keychain_unavailable",
    detail: `Could not read the ${definition.label} encryption key from your Keychain. Approve the prompt and try again.`,
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), handle.exitCode],
        { concurrency: "unbounded" },
      );
      if ((exitCode as unknown as number) !== 0) return yield* failure;
      const password = decodeUtf8(stdout as unknown as ReadonlyArray<Uint8Array>).trim();
      return password.length > 0 ? password : yield* failure;
    }),
  ).pipe(
    Effect.catchIf(
      (error) => error._tag !== "CookieImportError",
      () => failure,
    ),
  );
});

export const resolveDecryptionKeys = Effect.fn("desktop.cookieImport.resolveKeys")(
  function* (input: {
    readonly platform: CookieImportPlatform;
    readonly definition: ChromiumBrowserDefinition;
  }) {
    if (input.platform === "darwin") {
      const password = yield* readMacKeychainPassword(input.definition);
      return {
        key: deriveChromiumKey(password, MACOS_PBKDF2_ITERATIONS),
        mode: "aes-128-cbc",
      } satisfies ChromiumDecryptionKeys;
    }
    if (input.platform === "linux") {
      // v10 uses Chromium's hardcoded password; v11 needs the login keyring,
      // which is not always reachable, so v10 is what we can rely on here.
      return {
        key: deriveChromiumKey(LINUX_V10_PASSWORD, LINUX_PBKDF2_ITERATIONS),
        mode: "aes-128-cbc",
      } satisfies ChromiumDecryptionKeys;
    }
    return yield* new CookieImportError({
      reason: "unsupported_platform",
      detail: "Cookie import is not supported on this platform yet.",
    });
  },
);

interface RawCookieRow extends ChromiumCookieRow {
  readonly encrypted_value: Uint8Array;
  readonly value: string;
}

const readCookieRows = (databasePath: string): ReadonlyArray<RawCookieRow> => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    // expires_utc is microseconds since 1601 and overflows a JS number for any
    // cookie expiring past 2255; node:sqlite throws ERR_OUT_OF_RANGE on the
    // first such row. Reading it as text keeps every other column typed.
    return database
      .prepare(
        "SELECT host_key, name, path, is_secure, is_httponly, CAST(expires_utc AS TEXT) AS expires_utc, samesite, value, encrypted_value FROM cookies",
      )
      .all() as unknown as ReadonlyArray<RawCookieRow>;
  } finally {
    database.close();
  }
};

/**
 * Copy first: both Chromium and Firefox hold a lock on the live database while
 * running, and a direct read is an inconsistent read.
 */
const readDatabaseFromCopy = Effect.fn("desktop.cookieImport.readDatabase")(function* <A>(
  cookiePath: string,
  fileName: string,
  read: (path: string) => ReadonlyArray<A>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-cookie-import-" });
  const copyPath = path.join(directory, fileName);
  const unreadable = (detail: string) =>
    new CookieImportError({ reason: "database_unreadable", detail });
  yield* fileSystem
    .copyFile(cookiePath, copyPath)
    .pipe(Effect.catch(() => unreadable(`Could not read the cookie database at ${cookiePath}.`)));
  return yield* Effect.try({
    try: () => read(copyPath),
    // Carry the SQLite message through: "could not be opened" on its own hides
    // whether this was a lock, a schema change, or a value we failed to read.
    catch: (cause) =>
      unreadable(
        `The cookie database at ${cookiePath} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
});

/** A profile with a cookie database we can actually read. */
export interface ImportableProfile extends BrowserProfile {
  readonly cookiePath: string;
}

/** How a browser's cookies are stored, which decides how they are read. */
export type CookieImportFamily = "chromium" | "safari" | "firefox";

export interface ImportableBrowser {
  readonly id: string;
  readonly label: string;
  readonly family: CookieImportFamily;
  /** Present only for the Chromium family, which needs the Keychain entry. */
  readonly definition?: ChromiumBrowserDefinition | undefined;
  readonly profiles: ReadonlyArray<ImportableProfile>;
}

/**
 * Discovery is best-effort by design: a browser that is not installed, a
 * profile directory we cannot list, or a missing `Local State` should narrow
 * the picker, never fail the whole listing.
 */
const firstReadableCookiePath = Effect.fn("desktop.cookieImport.findCookiePath")(function* (
  profileDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of chromiumCookieCandidatePaths(profileDir)) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return null;
});

const listBrowserProfiles = Effect.fn("desktop.cookieImport.listProfiles")(function* (
  root: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  if (entries.length === 0) return [];
  const localStateJson = yield* fileSystem
    .readFileString(path.join(root, "Local State"))
    .pipe(Effect.orElseSucceed(() => undefined));

  const profiles: Array<ImportableProfile> = [];
  for (const profile of describeProfiles({ entries, localStateJson })) {
    const cookiePath = yield* firstReadableCookiePath(path.join(root, profile.directory));
    if (cookiePath !== null) profiles.push({ ...profile, cookiePath });
  }
  return profiles;
});

/**
 * Whether the browser's application is actually present. On platforms where we
 * cannot name the bundle, this answers true and detection falls back to the
 * data directory alone.
 */
const isBrowserInstalled = Effect.fn("desktop.cookieImport.isInstalled")(function* (
  definition: ChromiumBrowserDefinition,
  paths: CookieImportPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const candidates = browserApplicationPaths(definition, paths);
  if (candidates.length === 0) return true;
  for (const candidate of candidates) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return true;
  }
  return false;
});

/** Firefox: `<random>.<name>` dirs each holding an unencrypted `cookies.sqlite`. */
const listFirefoxProfiles = Effect.fn("desktop.cookieImport.listFirefoxProfiles")(function* (
  paths: CookieImportPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = firefoxProfilesRoot(paths);
  if (root === null) return [];
  // Same leftover-data problem as the Chromium browsers: an uninstalled Firefox
  // keeps its profiles, so the app bundle decides whether it is offered.
  const installed = yield* isBrowserInstalled(
    {
      id: "firefox",
      label: "Firefox",
      keychainService: "",
      keychainAccount: "",
      macApp: "Firefox.app",
    },
    paths,
  );
  if (!installed) return [];
  const entries = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));

  const profiles: Array<ImportableProfile> = [];
  for (const profile of describeFirefoxProfiles(entries)) {
    const cookiePath = path.join(root, profile.directory, "cookies.sqlite");
    const exists = yield* fileSystem.exists(cookiePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) profiles.push({ ...profile, cookiePath });
  }
  return profiles;
});

/** Safari: a single binary jar, no profiles. */
const listSafariProfiles = Effect.fn("desktop.cookieImport.listSafariProfiles")(function* (
  paths: CookieImportPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of safariCookieCandidatePaths(paths)) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return [{ directory: "Default", label: "Default", cookiePath: candidate }];
    }
  }
  return [];
});

/** Every installed browser that has at least one readable cookie store. */
export const listImportableBrowsers = Effect.fn("desktop.cookieImport.listBrowsers")(function* (
  paths: CookieImportPaths,
) {
  const browsers: Array<ImportableBrowser> = [];
  for (const definition of CHROMIUM_BROWSERS) {
    const root = browserRootPath(definition, paths);
    if (root === null) continue;
    if (!(yield* isBrowserInstalled(definition, paths))) continue;
    const profiles = yield* listBrowserProfiles(root);
    if (profiles.length > 0) {
      browsers.push({
        id: definition.id,
        label: definition.label,
        family: "chromium",
        definition,
        profiles,
      });
    }
  }

  const firefoxProfiles = yield* listFirefoxProfiles(paths);
  if (firefoxProfiles.length > 0) {
    browsers.push({
      id: "firefox",
      label: "Firefox",
      family: "firefox",
      profiles: firefoxProfiles,
    });
  }

  const safariProfiles = yield* listSafariProfiles(paths);
  if (safariProfiles.length > 0) {
    browsers.push({ id: "safari", label: "Safari", family: "safari", profiles: safariProfiles });
  }

  return browsers;
});

/**
 * Safari's jar sits inside its sandbox container, which macOS TCC protects.
 * Reading it without Full Disk Access fails with EPERM, and the only fix is a
 * System Settings toggle, so that case gets its own message rather than a
 * generic "unreadable".
 */
const readSafariCookies = Effect.fn("desktop.cookieImport.readSafari")(function* (
  cookiePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* fileSystem.readFile(cookiePath).pipe(
    Effect.catch(
      (cause) =>
        new CookieImportError({
          reason: String(cause).includes("EPERM") ? "permission_denied" : "database_unreadable",
          detail: String(cause).includes("EPERM")
            ? "macOS blocked access to Safari's cookies. Grant Full Disk Access to T3 Code in System Settings → Privacy & Security → Full Disk Access, then try again."
            : `Could not read Safari's cookie jar at ${cookiePath}.`,
        }),
    ),
  );
  return decodeSafariBinaryCookies(Buffer.from(bytes));
});

interface FirefoxCookieRow {
  readonly name: string;
  readonly value: string;
  readonly host: string;
  readonly path: string;
  readonly expiry: number;
  readonly isSecure: number;
  readonly isHttpOnly: number;
  readonly sameSite: number;
}

const readFirefoxRows = (databasePath: string): ReadonlyArray<FirefoxCookieRow> => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies",
      )
      .all() as unknown as ReadonlyArray<FirefoxCookieRow>;
  } finally {
    database.close();
  }
};

/** Firefox's samesite column: 0 none, 1 lax, 2 strict. */
const firefoxSameSite = (raw: number): ElectronCookieWrite["sameSite"] =>
  raw === 0 ? "no_restriction" : raw === 2 ? "strict" : "lax";

export interface ImportCookiesInput {
  readonly platform: CookieImportPlatform;
  readonly definition?: ChromiumBrowserDefinition | undefined;
  readonly family: CookieImportFamily;
  readonly cookiePath: string;
  /**
   * Preview cookie jars are partitioned per environment, so one import writes
   * the same cookie into each target session.
   */
  readonly sessions: ReadonlyArray<Session>;
  readonly nowSeconds: number;
}

/**
 * Reads a profile's cookies and reduces them to write/skip decisions. Each
 * family has its own storage, but they converge here so the write loop, the
 * skip accounting, and the summary are shared.
 */
const readCookieMappings = Effect.fn("desktop.cookieImport.readMappings")(function* (
  input: ImportCookiesInput,
) {
  if (input.family === "safari") {
    const cookies = yield* readSafariCookies(input.cookiePath);
    return cookies.map(({ expirationDate, ...cookie }) =>
      mappingFromCookie({
        // Safari does not record SameSite, so cookies land as lax — the value a
        // browser applies when the attribute is absent.
        cookie: {
          ...cookie,
          sameSite: "lax",
          ...(expirationDate === undefined ? {} : { expirationDate }),
        },
        nowSeconds: input.nowSeconds,
      }),
    );
  }

  if (input.family === "firefox") {
    const rows = yield* Effect.scoped(
      readDatabaseFromCopy(input.cookiePath, "cookies.sqlite", readFirefoxRows),
    );
    return rows.map((row) =>
      mappingFromCookie({
        cookie: {
          name: row.name,
          value: row.value ?? "",
          domain: row.host,
          path: row.path.length > 0 ? row.path : "/",
          secure: row.isSecure === 1,
          httpOnly: row.isHttpOnly === 1,
          ...(row.expiry > 0 ? { expirationDate: row.expiry } : {}),
          sameSite: firefoxSameSite(row.sameSite),
        },
        nowSeconds: input.nowSeconds,
      }),
    );
  }

  if (input.definition === undefined) {
    return yield* new CookieImportError({
      reason: "database_unreadable",
      detail: "This browser is missing the Keychain details needed to decrypt its cookies.",
    });
  }
  const keys = yield* resolveDecryptionKeys({
    platform: input.platform,
    definition: input.definition,
  });
  const rows = yield* Effect.scoped(
    readDatabaseFromCopy(input.cookiePath, "Cookies", readCookieRows),
  );
  return rows.map((row) => {
    const encrypted = Buffer.from(row.encrypted_value ?? new Uint8Array());
    const value =
      encrypted.length > 0
        ? decryptChromiumCookieValue(encrypted, keys)
        : (row.value ?? null) || null;
    return mapChromiumCookie({ row, value, nowSeconds: input.nowSeconds });
  });
});

/**
 * Import every cookie from one browser profile into `session`, returning a
 * summary rather than failing on individual cookies: one undecryptable value
 * should not abandon the other few thousand.
 */
export const importCookiesIntoSession = Effect.fn("desktop.cookieImport.importIntoSession")(
  function* (input: ImportCookiesInput) {
    const mappings = yield* readCookieMappings(input);

    let summary: CookieImportSummary = emptyImportSummary();
    for (const mapping of mappings) {
      if (mapping.kind !== "write") {
        summary = tallyMapping(summary, mapping);
        continue;
      }
      // Electron rejects cookies whose domain/URL pair it considers invalid;
      // count those as domain problems instead of failing the whole import.
      // A cookie counts as imported if it landed in at least one session.
      const writes = yield* Effect.all(
        input.sessions.map((target) =>
          Effect.tryPromise(() => target.cookies.set(mapping.cookie)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const written = writes.some(Boolean);
      summary = tallyMapping(
        summary,
        written ? mapping : { kind: "skip", reason: "invalid_domain" },
      );
    }
    return summary;
  },
);
