/**
 * Presentation logic for the cookie-import panel, kept out of the component so
 * the picker labels and the result summary can be tested without a desktop
 * bridge or a browser profile.
 */
import type { DesktopCookieImportResult, DesktopCookieImportSources } from "@t3tools/contracts";

export type CookieImportSourceList = DesktopCookieImportSources["sources"];

/** One selectable "browser + profile" pair, flattened for the picker. */
export interface ProfileChoice {
  readonly value: string;
  readonly label: string;
  readonly browserId: CookieImportSourceList[number]["browserId"];
  readonly profileDirectory: string;
}

export const choiceValue = (browserId: string, directory: string): string =>
  `${browserId}::${directory}`;

export function toChoices(sources: CookieImportSourceList): ReadonlyArray<ProfileChoice> {
  return sources.flatMap((source) =>
    source.profiles.map((profile) => ({
      value: choiceValue(source.browserId, profile.directory),
      // Only disambiguate by profile when the browser has more than one, so
      // the common single-profile case reads as just "Google Chrome".
      label: source.profiles.length > 1 ? `${source.label} — ${profile.displayName}` : source.label,
      browserId: source.browserId,
      profileDirectory: profile.directory,
    })),
  );
}

/**
 * Skips are summarized rather than hidden: "device-bound" in particular is
 * expected and benign, and a user who sees a smaller number than they expected
 * should be able to tell why without opening a log.
 */
export function describeImportResult(result: DesktopCookieImportResult): string {
  if (result.status === "cancelled") return "Import cancelled.";

  const { skipped } = result;
  const reasons: Array<string> = [];
  if (skipped.device_bound > 0) reasons.push(`${skipped.device_bound} device-bound`);
  if (skipped.decryption_failed > 0) reasons.push(`${skipped.decryption_failed} unreadable`);
  if (skipped.expired > 0) reasons.push(`${skipped.expired} expired`);
  if (skipped.invalid_domain > 0) reasons.push(`${skipped.invalid_domain} not applicable`);
  if (skipped.rejected > 0) reasons.push(`${skipped.rejected} rejected`);
  if (skipped.empty_name > 0) reasons.push(`${skipped.empty_name} unnamed`);

  const skippedTotal = Object.values(skipped).reduce((sum, count) => sum + count, 0);
  const imported = `${result.imported.toLocaleString()} cookie${result.imported === 1 ? "" : "s"} imported.`;
  return reasons.length === 0 || skippedTotal === 0
    ? imported
    : `${imported} ${skippedTotal} skipped (${reasons.join(", ")}).`;
}
