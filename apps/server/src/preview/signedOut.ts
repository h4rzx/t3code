/**
 * Detecting that the page is a sign-in wall.
 *
 * Imported cookies expire. Without this, an agent asked "how many paywalls do
 * I have" lands on a login screen, finds no rows, and reports zero — the worst
 * kind of wrong, because it looks like an answer.
 *
 * This is a heuristic over the URL and title, deliberately biased toward
 * missing a login page rather than calling a real page a login page: a false
 * positive tells the user to re-import cookies they did not need to.
 */

/** Path segments that mean "authenticate", not "a page about authentication". */
const SIGN_IN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "login",
  "log-in",
  "signin",
  "sign-in",
  "auth",
  "oauth",
  "sso",
]);

/** Multi-segment paths, matched as a suffix rather than a single segment. */
const SIGN_IN_PATH_SUFFIXES: ReadonlyArray<string> = ["session/new", "account/login"];

const SIGN_IN_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^sign\s?in\b/i,
  /^log\s?in\b/i,
  /^login\b/i,
  /\bsign\s?in\s+to\b/i,
  /\bsign\s?in\s*[-|·—]/i,
  /^authenticate\b/i,
  /^session\s+expired\b/i,
  /\byour\s+session\s+has\s+expired\b/i,
];

/**
 * Words that mean the page is *about* auth rather than asking for it — docs,
 * settings, and API references routinely have "login" in the path or title.
 */
const NOT_A_LOGIN_WALL: ReadonlyArray<RegExp> = [
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\bblog\b/i,
  /\bapi\b/i,
  /\bguide\b/i,
  /\bhelp\b/i,
  /\bsupport\b/i,
  /\bsettings\b/i,
  /\bhistory\b/i,
];

const pathOf = (url: string): string | null => {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Whether the page appears to be asking the user to sign in.
 *
 * Checked against the URL path and the document title only — no page content —
 * so it stays cheap enough to run on every observation.
 */
export function looksSignedOut(input: {
  readonly url: string | null;
  readonly title: string | null;
}): boolean {
  const title = input.title ?? "";
  // A documentation page about login is not a login wall.
  if (NOT_A_LOGIN_WALL.some((pattern) => pattern.test(title))) return false;

  if (SIGN_IN_TITLE_PATTERNS.some((pattern) => pattern.test(title.trim()))) return true;

  const path = input.url === null ? null : pathOf(input.url);
  if (path === null) return false;
  if (NOT_A_LOGIN_WALL.some((pattern) => pattern.test(path))) return false;

  // Match whole path segments so "/blogin" and "/plugins" do not qualify.
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => SIGN_IN_PATH_SEGMENTS.has(segment))) return true;
  return SIGN_IN_PATH_SUFFIXES.some((candidate) => path.includes(`/${candidate}`));
}
