import { describe, expect, it } from "vite-plus/test";

import {
  choiceValue,
  describeCookieInventory,
  describeImportResult,
  toChoices,
  type CookieImportSourceList,
} from "./BrowserSettings.logic";

const sources: CookieImportSourceList = [
  {
    browserId: "chrome",
    label: "Google Chrome",
    profiles: [
      { directory: "Default", displayName: "Personal" },
      { directory: "Profile 1", displayName: "Work" },
    ],
  },
  {
    browserId: "brave",
    label: "Brave",
    profiles: [{ directory: "Default", displayName: "Person 1" }],
  },
];

const noSkips = {
  device_bound: 0,
  decryption_failed: 0,
  expired: 0,
  invalid_domain: 0,
  empty_name: 0,
  rejected: 0,
};

describe("toChoices", () => {
  it("names the profile only when a browser has more than one", () => {
    expect(toChoices(sources).map((choice) => choice.label)).toEqual([
      "Google Chrome — Personal",
      "Google Chrome — Work",
      "Brave",
    ]);
  });

  it("keeps values unique across browsers that share a profile directory", () => {
    const values = toChoices(sources).map((choice) => choice.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(choiceValue("brave", "Default"));
  });

  it("drops browsers with no readable profile", () => {
    expect(toChoices([{ browserId: "arc", label: "Arc", profiles: [] }])).toEqual([]);
  });
});

describe("describeImportResult", () => {
  it("reports a clean import without a skip clause", () => {
    expect(describeImportResult({ status: "imported", imported: 1204, skipped: noSkips })).toBe(
      "1,204 cookies imported.",
    );
  });

  it("explains why cookies were skipped", () => {
    expect(
      describeImportResult({
        status: "imported",
        imported: 900,
        skipped: { ...noSkips, device_bound: 12, expired: 6 },
      }),
    ).toBe("900 cookies imported. 18 skipped (12 device-bound, 6 expired).");
  });

  it("singularizes a lone cookie", () => {
    expect(describeImportResult({ status: "imported", imported: 1, skipped: noSkips })).toBe(
      "1 cookie imported.",
    );
  });

  it("says nothing about counts when the user cancelled", () => {
    expect(describeImportResult({ status: "cancelled", imported: 0, skipped: noSkips })).toBe(
      "Import cancelled.",
    );
  });
});

describe("describeImportResult for a withheld permission", () => {
  it("does not report a blocked import as a successful one", () => {
    // Falls through to the imported-count wording if the status is ignored,
    // which would tell the user "0 cookies imported." and leave them with no
    // idea that a permission is the reason.
    const described = describeImportResult({
      status: "permission_required",
      imported: 0,
      skipped: noSkips,
      detail: "macOS keeps Safari's cookies behind Full Disk Access.",
    });
    expect(described).not.toContain("imported.");
    expect(described).toContain("Full Disk Access");
  });
});

/**
 * A one-way door is a bug: import has a way in and a way out, and this is the
 * way to see it. Without it the only signal that cookies were ever imported is
 * a status line that disappears when the page is reloaded.
 */
describe("describeCookieInventory", () => {
  it("says the browser is empty rather than showing a zero", () => {
    expect(describeCookieInventory({ cookies: 0, sites: 0 })).toBe(
      "The preview browser has no cookies.",
    );
  });

  it("counts cookies and the sites they belong to", () => {
    expect(describeCookieInventory({ cookies: 2667, sites: 412 })).toBe(
      "2,667 cookies from 412 sites.",
    );
  });

  it("reads naturally for a single cookie or a single site", () => {
    expect(describeCookieInventory({ cookies: 1, sites: 1 })).toBe("1 cookie from 1 site.");
  });

  it("reports nothing when the count is not known yet", () => {
    // Null while the count is loading. Rendering "0 cookies" there would be a
    // lie that corrects itself, which is worse than showing nothing.
    expect(describeCookieInventory(null)).toBeNull();
  });
});
