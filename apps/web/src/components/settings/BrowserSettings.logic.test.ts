import { describe, expect, it } from "vite-plus/test";

import {
  choiceValue,
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
