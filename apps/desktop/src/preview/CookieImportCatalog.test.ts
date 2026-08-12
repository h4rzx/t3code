import { describe, expect, it } from "vite-plus/test";

import {
  browserApplicationPaths,
  browserRootPath,
  CHROMIUM_BROWSERS,
  chromiumCookieCandidatePaths,
  describeFirefoxProfiles,
  describeProfiles,
  firefoxProfilesRoot,
  isSafeProfileDirectory,
  parseProfileDisplayNames,
  profileDirectoryNames,
  safariCookieCandidatePaths,
  safariCookiePath,
  type ChromiumBrowserDefinition,
} from "./CookieImportCatalog.ts";

const byId = (id: string): ChromiumBrowserDefinition => {
  const found = CHROMIUM_BROWSERS.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing browser ${id}`);
  return found;
};

describe("browserRootPath", () => {
  it("resolves per platform", () => {
    expect(browserRootPath(byId("chrome"), { platform: "darwin", homeDir: "/Users/x" })).toBe(
      "/Users/x/Library/Application Support/Google/Chrome",
    );
    expect(
      browserRootPath(byId("chrome"), {
        platform: "win32",
        homeDir: "C:/Users/x",
        localAppData: "C:/Users/x/AppData/Local",
      }),
    ).toBe("C:/Users/x/AppData/Local/Google/Chrome/User Data");
    expect(browserRootPath(byId("brave"), { platform: "linux", homeDir: "/home/x" })).toBe(
      "/home/x/.config/BraveSoftware/Brave-Browser",
    );
  });

  it("returns null for a platform the browser does not ship", () => {
    // Arc has no Linux build; Helium is macOS-only.
    expect(browserRootPath(byId("arc"), { platform: "linux", homeDir: "/home/x" })).toBeNull();
    expect(
      browserRootPath(byId("helium"), {
        platform: "win32",
        homeDir: "C:/Users/x",
        localAppData: "C:/Users/x/AppData/Local",
      }),
    ).toBeNull();
  });

  it("returns null on Windows when LOCALAPPDATA is unknown", () => {
    expect(
      browserRootPath(byId("chrome"), { platform: "win32", homeDir: "C:/Users/x" }),
    ).toBeNull();
  });
});

describe("cookie database locations", () => {
  it("prefers the Chromium 96+ location and keeps the legacy fallback", () => {
    expect(chromiumCookieCandidatePaths("/root/Default")).toEqual([
      "/root/Default/Network/Cookies",
      "/root/Default/Cookies",
    ]);
  });

  it("only offers Safari on macOS", () => {
    expect(safariCookiePath({ platform: "darwin", homeDir: "/Users/x" })).toBe(
      "/Users/x/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    );
    expect(safariCookiePath({ platform: "linux", homeDir: "/home/x" })).toBeNull();
  });
});

describe("profile discovery", () => {
  it("keeps profile directories, drops everything else, and puts Default first", () => {
    expect(
      profileDirectoryNames(["Profile 2", "Crashpad", "Default", "Profile 1", "ShaderCache"]),
    ).toEqual(["Default", "Profile 1", "Profile 2"]);
  });

  it("labels profiles from Local State", () => {
    const localStateJson = JSON.stringify({
      profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } },
    });
    expect(describeProfiles({ entries: ["Default", "Profile 1"], localStateJson })).toEqual([
      { directory: "Default", label: "Personal" },
      { directory: "Profile 1", label: "Work" },
    ]);
  });

  it("falls back to directory names when Local State is missing or malformed", () => {
    expect(parseProfileDisplayNames("not json").size).toBe(0);
    expect(parseProfileDisplayNames(JSON.stringify({ profile: {} })).size).toBe(0);
    expect(describeProfiles({ entries: ["Default"], localStateJson: "{" })).toEqual([
      { directory: "Default", label: "Default" },
    ]);
  });
});

describe("safari and firefox discovery", () => {
  const paths = { platform: "darwin", homeDir: "/Users/h" } as const;

  it("checks both Safari jar locations, container last", () => {
    expect(safariCookieCandidatePaths(paths)).toEqual([
      "/Users/h/Library/Cookies/Cookies.binarycookies",
      "/Users/h/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    ]);
    expect(safariCookieCandidatePaths({ platform: "linux", homeDir: "/home/h" })).toEqual([]);
  });

  it("resolves the Firefox profiles root per platform", () => {
    expect(firefoxProfilesRoot(paths)).toBe(
      "/Users/h/Library/Application Support/Firefox/Profiles",
    );
    expect(firefoxProfilesRoot({ platform: "linux", homeDir: "/home/h" })).toBe(
      "/home/h/.mozilla/firefox",
    );
    expect(firefoxProfilesRoot({ platform: "win32", homeDir: "C:/u", appData: "C:/AppData" })).toBe(
      "C:/AppData/Mozilla/Firefox/Profiles",
    );
    expect(firefoxProfilesRoot({ platform: "win32", homeDir: "C:/u" })).toBeNull();
  });

  it("puts default-release first and labels Firefox dirs by their suffix", () => {
    expect(describeFirefoxProfiles(["abc.work", "xyz.default-release", "def.default"])).toEqual([
      { directory: "xyz.default-release", label: "default-release" },
      { directory: "def.default", label: "default" },
      { directory: "abc.work", label: "work" },
    ]);
  });

  it("rejects profile directories that could escape the browser root", () => {
    expect(isSafeProfileDirectory("Default")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../evil"]) {
      expect(isSafeProfileDirectory(bad)).toBe(false);
    }
  });

  it("falls back to Default when a Chromium root has no readable Local State", () => {
    expect(describeProfiles({ entries: [] })).toEqual([{ directory: "Default", label: "Default" }]);
    expect(describeProfiles({ entries: [], localStateJson: "{bad json" })).toEqual([
      { directory: "Default", label: "Default" },
    ]);
  });
});

describe("browserApplicationPaths", () => {
  const paths = { platform: "darwin", homeDir: "/Users/h" } as const;

  it("checks the system and per-user Applications folders", () => {
    expect(browserApplicationPaths(byId("brave"), paths)).toEqual([
      "/Applications/Brave Browser.app",
      "/Users/h/Applications/Brave Browser.app",
    ]);
  });

  it("gives every Chromium browser a bundle name so uninstalls are detectable", () => {
    for (const definition of CHROMIUM_BROWSERS) {
      expect(browserApplicationPaths(definition, paths).length).toBe(2);
    }
  });

  it("returns nothing off macOS, so detection falls back to the data directory", () => {
    expect(
      browserApplicationPaths(byId("chrome"), { platform: "linux", homeDir: "/home/h" }),
    ).toEqual([]);
  });
});
