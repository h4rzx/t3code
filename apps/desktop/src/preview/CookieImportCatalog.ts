/**
 * Where installed browsers keep their cookies, and what to call them.
 *
 * Everything here is pure: paths are derived from an explicit platform and home
 * directory rather than read from the environment, so profile discovery can be
 * tested on any machine without the browsers installed. Decryption and the
 * session write live elsewhere — this module only answers "what exists, and
 * where".
 */

export type CookieImportPlatform = "darwin" | "win32" | "linux";

/**
 * A Chromium-family browser. `keychainService`/`keychainAccount` name the macOS
 * Keychain entry holding the key that decrypts cookie values; the convention is
 * "<Browser> Safe Storage", which Helium notably breaks.
 */
export interface ChromiumBrowserDefinition {
  readonly id: string;
  readonly label: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly macRoot?: string;
  readonly winRoot?: string;
  readonly linuxRoot?: string;
  /** macOS app bundle name, used to confirm the browser is actually installed. */
  readonly macApp?: string;
}

export const CHROMIUM_BROWSERS: ReadonlyArray<ChromiumBrowserDefinition> = [
  {
    id: "chrome",
    macApp: "Google Chrome.app",
    label: "Google Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macRoot: "Google/Chrome",
    winRoot: "Google/Chrome/User Data",
    linuxRoot: "google-chrome",
  },
  {
    id: "edge",
    macApp: "Microsoft Edge.app",
    label: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macRoot: "Microsoft Edge",
    winRoot: "Microsoft/Edge/User Data",
    linuxRoot: "microsoft-edge",
  },
  {
    id: "brave",
    macApp: "Brave Browser.app",
    label: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macRoot: "BraveSoftware/Brave-Browser",
    winRoot: "BraveSoftware/Brave-Browser/User Data",
    linuxRoot: "BraveSoftware/Brave-Browser",
  },
  {
    id: "arc",
    macApp: "Arc.app",
    // Arc ships macOS and Windows builds only.
    label: "Arc",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
    macRoot: "Arc/User Data",
  },
  {
    id: "comet",
    macApp: "Comet.app",
    label: "Comet",
    keychainService: "Comet Safe Storage",
    keychainAccount: "Comet",
    macRoot: "Comet",
    winRoot: "Comet/User Data",
  },
  {
    id: "helium",
    macApp: "Helium.app",
    // Helium's Keychain entry is literally "Helium Storage Key", not the
    // "<Browser> Safe Storage" convention every other Chromium build follows.
    label: "Helium",
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
    macRoot: "net.imput.helium",
  },
];

/**
 * Firefox keeps profiles under a `Profiles` root with `<random>.<name>` dirs
 * and an unencrypted `cookies.sqlite`, so it needs no Keychain step.
 */
export function firefoxProfilesRoot(paths: CookieImportPaths): string | null {
  switch (paths.platform) {
    case "darwin":
      return joinPath(paths.homeDir, "Library/Application Support/Firefox/Profiles");
    case "win32":
      return paths.appData === undefined
        ? null
        : joinPath(paths.appData, "Mozilla/Firefox/Profiles");
    case "linux":
      return joinPath(paths.homeDir, ".mozilla/firefox");
  }
}

/**
 * Firefox profile dirs are `<random>.<name>`; the label is the part after the
 * dot. `default-release` is the profile a normal install actually uses, so it
 * sorts first.
 */
export function describeFirefoxProfiles(
  entries: ReadonlyArray<string>,
): ReadonlyArray<BrowserProfile> {
  const rank = (entry: string): number =>
    entry.includes("default-release") ? 0 : entry.includes("default") ? 1 : 2;
  return [...entries]
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
    .map((directory) => ({
      directory,
      label: directory.includes(".") ? directory.split(".").slice(1).join(".") : directory,
    }));
}

/**
 * Safari's jar lives in its sandbox container on modern macOS; the bare
 * `~/Library/Cookies` path is the pre-container location. Both are checked, in
 * that order, matching where Safari actually writes.
 */
export function safariCookieCandidatePaths(paths: CookieImportPaths): ReadonlyArray<string> {
  if (paths.platform !== "darwin") return [];
  return [
    joinPath(paths.homeDir, "Library/Cookies/Cookies.binarycookies"),
    joinPath(
      paths.homeDir,
      "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    ),
  ];
}

/**
 * Profile directories become path segments, and `Local State` is metadata we
 * do not control, so a name that could escape the profile root is rejected.
 */
export function isSafeProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== "." &&
    !directory.includes("\0") &&
    !directory.includes("/") &&
    !directory.includes("\\") &&
    !directory.includes("..")
  );
}

export interface CookieImportPaths {
  readonly platform: CookieImportPlatform;
  readonly homeDir: string;
  /** %LOCALAPPDATA% on Windows; ignored elsewhere. */
  readonly localAppData?: string | undefined;
  /** %APPDATA% on Windows, where Firefox keeps profiles; ignored elsewhere. */
  readonly appData?: string | undefined;
}

const joinPath = (...segments: ReadonlyArray<string>): string =>
  segments.filter((segment) => segment.length > 0).join("/");

/** Root directory holding a browser's profiles, or null if it has no build for this platform. */
export function browserRootPath(
  definition: ChromiumBrowserDefinition,
  paths: CookieImportPaths,
): string | null {
  switch (paths.platform) {
    case "darwin":
      return definition.macRoot
        ? joinPath(paths.homeDir, "Library/Application Support", definition.macRoot)
        : null;
    case "win32":
      return definition.winRoot && paths.localAppData
        ? joinPath(paths.localAppData, definition.winRoot)
        : null;
    case "linux":
      return definition.linuxRoot ? joinPath(paths.homeDir, ".config", definition.linuxRoot) : null;
  }
}

/**
 * Where a browser's application bundle would live if it is installed.
 *
 * Uninstalling a browser on macOS removes the app but leaves
 * `~/Library/Application Support/<Browser>` behind, cookie database and all.
 * Detecting on data alone therefore offers browsers the user no longer has,
 * whose sessions are however old the leftover profile is. The app bundle is
 * the honest signal for "installed", so it gates detection.
 *
 * Returns an empty list when we have no bundle name for the platform, which
 * callers treat as "cannot verify, fall back to the data directory".
 */
export function browserApplicationPaths(
  definition: ChromiumBrowserDefinition,
  paths: CookieImportPaths,
): ReadonlyArray<string> {
  if (paths.platform !== "darwin" || definition.macApp === undefined) return [];
  return [
    joinPath("/Applications", definition.macApp),
    joinPath(paths.homeDir, "Applications", definition.macApp),
  ];
}

/**
 * Chromium 96+ moved the cookie database under `Network/`; older profiles keep
 * it at the profile root. Callers must check both, and in this order.
 */
export function chromiumCookieCandidatePaths(profileDir: string): ReadonlyArray<string> {
  return [joinPath(profileDir, "Network/Cookies"), joinPath(profileDir, "Cookies")];
}

/** Safari is not Chromium: one binary cookie jar, no per-profile split, no keychain key. */
export function safariCookiePath(paths: CookieImportPaths): string | null {
  return paths.platform === "darwin"
    ? joinPath(
        paths.homeDir,
        "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
      )
    : null;
}

export interface BrowserProfile {
  /** Directory name inside the browser root, e.g. `Default` or `Profile 1`. */
  readonly directory: string;
  /** Human label from Local State when available, otherwise the directory name. */
  readonly label: string;
}

/**
 * Chrome records profile display names in `Local State` under
 * `profile.info_cache`, which is what makes a picker readable ("Personal")
 * instead of cryptic ("Profile 3"). Unreadable or malformed state degrades to
 * directory names rather than failing the import.
 */
export function parseProfileDisplayNames(localStateJson: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStateJson);
  } catch {
    return names;
  }
  if (typeof parsed !== "object" || parsed === null) return names;
  const profile = (parsed as { readonly profile?: unknown }).profile;
  if (typeof profile !== "object" || profile === null) return names;
  const infoCache = (profile as { readonly info_cache?: unknown }).info_cache;
  if (typeof infoCache !== "object" || infoCache === null) return names;
  for (const [directory, value] of Object.entries(infoCache)) {
    if (typeof value !== "object" || value === null) continue;
    const name = (value as { readonly name?: unknown }).name;
    if (typeof name === "string" && name.trim().length > 0) {
      names.set(directory, name.trim());
    }
  }
  return names;
}

/** Directory names that hold a profile, given what the browser root contains. */
export function profileDirectoryNames(entries: ReadonlyArray<string>): ReadonlyArray<string> {
  return entries
    .filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry))
    .sort((left, right) =>
      left === "Default" ? -1 : right === "Default" ? 1 : left.localeCompare(right),
    );
}

/**
 * Profiles for a Chromium root. `Local State` is preferred because it carries
 * display names, but a browser whose state is missing or unreadable still gets
 * a `Default` candidate: the caller only keeps profiles that turn out to have a
 * cookie database, so guessing here costs nothing and rescues installs whose
 * state file we cannot parse.
 */
export function describeProfiles(input: {
  readonly entries: ReadonlyArray<string>;
  readonly localStateJson?: string | undefined;
}): ReadonlyArray<BrowserProfile> {
  const fallback: ReadonlyArray<BrowserProfile> = [{ directory: "Default", label: "Default" }];
  const names =
    input.localStateJson === undefined
      ? new Map<string, string>()
      : parseProfileDisplayNames(input.localStateJson);

  const fromState = [...names.keys()].filter(isSafeProfileDirectory);
  const directories =
    fromState.length > 0 ? profileDirectoryNames(fromState) : profileDirectoryNames(input.entries);
  if (directories.length === 0) return fallback;

  return directories.map((directory) => ({
    directory,
    label: names.get(directory) ?? directory,
  }));
}
