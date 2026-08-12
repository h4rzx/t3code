/**
 * Pure request shaping for `t3 browser`. The CLI layer only collects flags and
 * prints JSON; everything that can be wrong about a command is decided here so
 * it can be tested without a running server.
 */
import type {
  BrowserNavigationTarget,
  PreviewAutomationColorScheme,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";

export class BrowserCommandInputError extends Error {
  override readonly name = "BrowserCommandInputError";
}

const fail = (message: string): never => {
  throw new BrowserCommandInputError(message);
};

const MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** `Meta,Shift` — case-insensitive, so `meta,shift` works from a shell too. */
export function parseModifiers(value: string | undefined): ReadonlyArray<Modifier> | undefined {
  if (value === undefined) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const match = MODIFIERS.find((modifier) => modifier.toLowerCase() === entry.toLowerCase());
      return match ?? fail(`Unknown modifier "${entry}". Use Alt, Control, Meta, or Shift.`);
    });
  return parsed.length === 0 ? undefined : parsed;
}

/** `1024x768`. */
export function parseViewportSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    return fail(`Invalid size "${value}". Use WIDTHxHEIGHT, for example 1024x768.`);
  }
  return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
}

export function buildNavigateTarget(input: {
  readonly url: string | undefined;
  readonly port: number | undefined;
  readonly protocol: "http" | "https" | undefined;
  readonly path: string | undefined;
}): { readonly url: string } | { readonly target: BrowserNavigationTarget } {
  if (input.url !== undefined && input.port !== undefined) {
    return fail("Provide either a URL or --port, not both.");
  }
  if (input.url !== undefined) {
    if (input.protocol !== undefined || input.path !== undefined) {
      return fail("--protocol and --path only apply to --port.");
    }
    return { url: input.url };
  }
  if (input.port === undefined) {
    return fail("Provide a URL or --port <port> for a dev server in this environment.");
  }
  return {
    target: {
      kind: "environment-port",
      port: input.port,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.path === undefined ? {} : { path: input.path }),
    },
  };
}

export function buildResizeInput(input: {
  readonly size: string | undefined;
  readonly preset: string | undefined;
  readonly orientation: "portrait" | "landscape" | undefined;
}): Record<string, unknown> {
  if (input.size !== undefined && input.preset !== undefined) {
    return fail("Provide either --size or --preset, not both.");
  }
  if (input.preset !== undefined) {
    return {
      mode: "preset",
      preset: input.preset,
      ...(input.orientation === undefined ? {} : { orientation: input.orientation }),
    };
  }
  if (input.orientation !== undefined) {
    return fail("--orientation only applies to --preset.");
  }
  if (input.size === undefined) {
    // No dimensions asked for: follow the preview panel.
    return { mode: "fill" };
  }
  return { mode: "freeform", ...parseViewportSize(input.size) };
}

export function buildTargetedInput(input: {
  readonly locator: string | undefined;
  readonly selector: string | undefined;
}): Record<string, unknown> {
  if (input.locator !== undefined && input.selector !== undefined) {
    return fail("Provide either --locator or --selector, not both.");
  }
  return {
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    ...(input.selector === undefined ? {} : { selector: input.selector }),
  };
}

export function buildClickInput(input: {
  readonly locator: string | undefined;
  readonly selector: string | undefined;
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly timeoutMs: number | undefined;
}): Record<string, unknown> {
  const hasCoordinates = input.x !== undefined || input.y !== undefined;
  if (hasCoordinates && (input.x === undefined || input.y === undefined)) {
    return fail("Coordinates require both --x and --y.");
  }
  const target = buildTargetedInput(input);
  if (hasCoordinates && Object.keys(target).length > 0) {
    return fail("Provide exactly one click target: --locator, --selector, or --x/--y.");
  }
  if (!hasCoordinates && Object.keys(target).length === 0) {
    return fail("Provide a click target: --locator, --selector, or --x/--y.");
  }
  return {
    ...target,
    ...(hasCoordinates ? { x: input.x, y: input.y } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

export function buildScrollInput(input: {
  readonly deltaX: number | undefined;
  readonly deltaY: number | undefined;
  readonly locator: string | undefined;
  readonly selector: string | undefined;
}): Record<string, unknown> {
  if (input.deltaX === undefined && input.deltaY === undefined) {
    return fail("Provide --dx and/or --dy.");
  }
  return {
    ...buildTargetedInput(input),
    ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
    ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
  };
}

export function buildWaitInput(input: {
  readonly locator: string | undefined;
  readonly selector: string | undefined;
  readonly text: string | undefined;
  readonly urlIncludes: string | undefined;
  readonly timeoutMs: number | undefined;
}): Record<string, unknown> {
  const conditions = {
    ...buildTargetedInput(input),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.urlIncludes === undefined ? {} : { urlIncludes: input.urlIncludes }),
  };
  if (Object.keys(conditions).length === 0) {
    return fail(
      "Provide at least one condition: --locator, --selector, --text, or --url-includes.",
    );
  }
  return {
    ...conditions,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

export function buildAppearanceInput(colorScheme: string): Record<string, unknown> {
  const allowed: ReadonlyArray<PreviewAutomationColorScheme> = ["system", "light", "dark"];
  const match = allowed.find((entry) => entry === colorScheme.toLowerCase());
  if (!match) return fail(`Unknown appearance "${colorScheme}". Use system, light, or dark.`);
  return { colorScheme: match };
}

export const DEFAULT_SNAPSHOT_TEXT_BUDGET = 2000;
export const DEFAULT_SNAPSHOT_ELEMENT_BUDGET = 60;

/**
 * Rank elements so a truncated list still contains the ones worth acting on:
 * named, visible controls first, then document order.
 */
function rankInteractiveElements<T extends { readonly name: string; readonly y: number }>(
  elements: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return elements
    .map((element, index) => ({ element, index }))
    .sort((left, right) => {
      const named =
        Number(right.element.name.trim().length > 0) - Number(left.element.name.trim().length > 0);
      return named !== 0 ? named : left.index - right.index;
    })
    .map((entry) => entry.element);
}

export interface CliSnapshotProjection {
  readonly json: Record<string, unknown>;
  /** Base64 PNG to write to disk, when the caller asked for a screenshot file. */
  readonly screenshotBase64: string | null;
}

/**
 * A raw snapshot carries a base64 PNG and a full accessibility tree, which are
 * both far larger than a terminal (or an agent's context) wants by default.
 * Keep the readable parts inline and hand the heavy parts out on request.
 */
export function projectSnapshotForCli(
  result: unknown,
  options: {
    readonly screenshotPath: string | undefined;
    readonly includeScreenshotData: boolean;
    readonly includeAccessibilityTree: boolean;
    /** Skip every budget and return the snapshot as the host produced it. */
    readonly full?: boolean;
    readonly maxTextChars?: number;
    readonly maxElements?: number;
  },
): CliSnapshotProjection {
  if (typeof result !== "object" || result === null) {
    return { json: { result }, screenshotBase64: null };
  }
  const snapshot = result as PreviewAutomationSnapshot;
  const { screenshot, accessibilityTree, visibleText, ariaSnapshot, interactiveElements, ...rest } =
    snapshot;
  const wantsData = options.includeScreenshotData;
  const full = options.full === true;
  const textBudget = options.maxTextChars ?? DEFAULT_SNAPSHOT_TEXT_BUDGET;
  const elementBudget = options.maxElements ?? DEFAULT_SNAPSHOT_ELEMENT_BUDGET;
  const allElements = interactiveElements ?? [];
  const rankedElements = full ? allElements : rankInteractiveElements(allElements);
  const keptElements = full ? allElements : rankedElements.slice(0, elementBudget);
  // Prefer the aria tree. It carries the page's structure — this is a table,
  // that is a dialog over the top of it — in a fraction of the characters the
  // same page costs as flattened text, and structure is what a caller actually
  // reasons about. `visibleText` stays as the fallback for hosts that cannot
  // produce one, and is dropped when the tree is present so the two
  // representations of the same page are never paid for twice.
  const aria = typeof ariaSnapshot === "string" && ariaSnapshot.length > 0 ? ariaSnapshot : null;
  const text = aria ?? visibleText ?? "";
  const keptText = full || text.length <= textBudget ? text : text.slice(0, textBudget);
  // Say what was dropped: a silently truncated page reads as a complete one.
  // Totals come from the page when the host reports them, because the host
  // caps its own read (20k chars / 200 elements) before we ever see it —
  // comparing against what arrived would hide that second truncation and make
  // a cut page look whole.
  const hostSnapshot = snapshot as unknown as {
    readonly visibleTextTotal?: number;
    readonly interactiveElementsTotal?: number;
  };
  // The host's text total describes `visibleText`, so it says nothing about a
  // tree that was never flattened.
  const textTotal =
    aria === null ? Math.max(hostSnapshot.visibleTextTotal ?? 0, text.length) : text.length;
  const elementsTotal = Math.max(hostSnapshot.interactiveElementsTotal ?? 0, allElements.length);
  const truncated = {
    ...(keptText.length < textTotal
      ? {
          [aria === null ? "visibleTextChars" : "ariaSnapshotChars"]: {
            kept: keptText.length,
            total: textTotal,
          },
        }
      : {}),
    ...(keptElements.length < elementsTotal
      ? { interactiveElements: { kept: keptElements.length, total: elementsTotal } }
      : {}),
  };
  return {
    json: {
      ...rest,
      ...(aria === null ? { visibleText: keptText } : { ariaSnapshot: keptText }),
      interactiveElements: keptElements,
      ...(Object.keys(truncated).length > 0
        ? {
            truncated: {
              ...truncated,
              hint:
                full || keptText.length >= textTotal
                  ? "The page is larger than the host reads in one pass; scroll and snapshot again for the rest."
                  : "Re-run with --full for everything.",
            },
          }
        : {}),
      ...(options.includeAccessibilityTree ? { accessibilityTree } : {}),
      ...(screenshot
        ? {
            screenshot: {
              mimeType: screenshot.mimeType,
              width: screenshot.width,
              height: screenshot.height,
              ...(wantsData ? { data: screenshot.data } : {}),
              ...(options.screenshotPath === undefined ? {} : { path: options.screenshotPath }),
            },
          }
        : {}),
    },
    screenshotBase64:
      options.screenshotPath !== undefined && screenshot ? (screenshot.data ?? null) : null,
  };
}
