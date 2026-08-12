/**
 * Structured extraction: reading data out of a page in one call.
 *
 * `snapshot` answers "where am I and what can I click". It is budgeted and
 * viewport-shaped, which is right for orientation and wrong for data. Reading
 * a 200-row table through it means scrolling and re-snapshotting, paying for
 * the nav and chrome on every pass, and risking double-counted rows.
 *
 * The DOM already holds every row regardless of scroll position, so extraction
 * queries it directly and paginates over the *result set* rather than over
 * pixels: deterministic, resumable, and one round trip per page of rows.
 *
 * Scrolling remains necessary only for virtualized lists, where rows genuinely
 * do not exist until rendered. That is a separate fallback, not the default.
 */
import * as Schema from "effect/Schema";

/** Rows-per-call ceiling. Large enough for a full table, small enough to bound the payload. */
export const DEFAULT_EXTRACT_LIMIT = 100;
export const MAX_EXTRACT_LIMIT = 1000;
/** Per-cell text cap: one runaway cell should not blow the whole page of rows. */
export const MAX_CELL_CHARS = 500;

export class ExtractInputError extends Schema.TaggedErrorClass<ExtractInputError>()(
  "ExtractInputError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ExtractOptions {
  readonly selector: string;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  /** Optional per-row sub-selector; defaults to table cells. */
  readonly cellSelector?: string | undefined;
  /** Include href/src/value attributes alongside text. */
  readonly attributes?: boolean | undefined;
  /**
   * Named sub-selectors, for layouts with no row/cell semantics. Card grids
   * have no `table` and no `[role=row]`, so positional cells mean nothing and
   * the only way to read them is to name each part.
   */
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly selector: string }> | undefined;
  /**
   * Scroll the list and accumulate rows instead of reading the DOM once.
   * Only for virtualized lists — it is slower, and on an ordinary list it
   * cannot find anything a single read did not already have.
   */
  readonly scroll?: boolean | undefined;
  /**
   * Element to scroll. Defaults to the nearest scrollable ancestor of the
   * first match, then the window.
   */
  readonly scrollContainer?: string | undefined;
  /** Ceiling on scroll passes, so a list that never settles still returns. */
  readonly maxScrolls?: number | undefined;
}

/** Scroll passes before giving up on a list that keeps producing rows. */
export const DEFAULT_MAX_SCROLLS = 40;
export const MAX_SCROLLS_CEILING = 200;
/** Passes with no new rows before the list counts as exhausted. */
const STABLE_PASSES_REQUIRED = 2;
/** Time for a virtualized list to render after a scroll, per pass. */
const SCROLL_SETTLE_MS = 120;

/** Parses `name:selector,other:selector` into field pairs. */
export function parseFieldSpec(
  spec: string,
): ReadonlyArray<{ readonly name: string; readonly selector: string }> {
  const fields: Array<{ name: string; selector: string }> = [];
  // Split on commas that separate pairs, not commas inside a selector list —
  // a pair always starts with `name:`, so scan for that boundary.
  for (const part of spec.split(/,(?=[^,:]+:)/)) {
    const separator = part.indexOf(":");
    if (separator <= 0) {
      return raise(`Field "${part.trim()}" must look like name:selector.`);
    }
    const name = part.slice(0, separator).trim();
    const selector = part.slice(separator + 1).trim();
    if (name.length === 0 || selector.length === 0) {
      return raise(`Field "${part.trim()}" must look like name:selector.`);
    }
    fields.push({ name, selector });
  }
  if (fields.length === 0) return raise("--fields needs at least one name:selector pair.");
  return fields;
}

export interface ExtractRow {
  readonly index: number;
  readonly text: string;
  readonly cells?: ReadonlyArray<string>;
  readonly fields?: Readonly<Record<string, string | null>>;
  readonly href?: string;
  readonly value?: string;
}

export interface ExtractResult {
  readonly selector: string;
  /** Total matches in the DOM, independent of this page of results. */
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly rows: ReadonlyArray<ExtractRow>;
  /** Present when more rows exist; pass it as --offset to continue. */
  readonly nextOffset?: number;
  /** Set when rows were gathered by scrolling rather than one DOM read. */
  readonly scrolled?: boolean;
  /**
   * False when the scroll cap was reached with rows still arriving, so
   * `total` is a floor rather than a count. Silence here would read as a
   * complete answer.
   */
  readonly complete?: boolean;
  readonly scrollPasses?: number;
}

export function normalizeExtractOptions(options: ExtractOptions): {
  readonly selector: string;
  readonly offset: number;
  readonly limit: number;
  readonly cellSelector: string;
  readonly attributes: boolean;
} {
  const selector = options.selector.trim();
  if (selector.length === 0) {
    return raise('A CSS selector is required, for example --selector "table tbody tr".');
  }
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    return raise("--offset must be a whole number of rows, starting at 0.");
  }
  const limit = options.limit ?? DEFAULT_EXTRACT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_EXTRACT_LIMIT) {
    return raise(`--limit must be between 1 and ${MAX_EXTRACT_LIMIT}.`);
  }
  return {
    selector,
    offset,
    limit,
    cellSelector: options.cellSelector?.trim() || "td,th",
    attributes: options.attributes === true,
  };
}

const raise = (detail: string): never => {
  throw new ExtractInputError({ detail });
};

/**
 * Builds the page-side expression.
 *
 * `total` is computed before slicing so the caller can tell how much is left
 * without fetching it, which is what makes cursor pagination honest: the count
 * never depends on how many rows happened to come back.
 */
export function buildExtractExpression(options: ExtractOptions): string {
  if (options.scroll === true) return buildScrollingExtractExpression(options);
  const { selector, offset, limit } = normalizeExtractOptions(options);
  const json = (value: string) => JSON.stringify(value);
  return `(() => {
  ${rowBuilderSource(options)}
  const matches = Array.from(document.querySelectorAll(${json(selector)}));
  const total = matches.length;
  const rows = matches.slice(${offset}, ${offset + limit}).map((element, position) => buildRow(element, ${offset} + position));
  return { selector: ${json(selector)}, total, offset: ${offset}, limit: ${limit}, rows };
})()`;
}

/**
 * The page-side `buildRow(element, index)` both extraction paths share, so a
 * row read by scrolling is shaped identically to one read in place.
 */
function rowBuilderSource(options: ExtractOptions): string {
  const { cellSelector, attributes } = normalizeExtractOptions(options);
  const json = (value: string) => JSON.stringify(value);
  return `const clean = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, ${MAX_CELL_CHARS});
  const fieldSpec = ${JSON.stringify(options.fields ?? [])};
  const buildRow = (element, index) => {
    const cells = Array.from(element.querySelectorAll(${json(cellSelector)})).map((cell) => clean(cell.innerText));
    const row = { index, text: clean(element.innerText) };
    if (cells.length > 0) row.cells = cells;
    if (fieldSpec.length > 0) {
      const fields = {};
      for (const field of fieldSpec) {
        const found = element.querySelector(field.selector);
        // Null rather than omitted: a missing field is signal, and dropping the
        // key makes rows look inconsistent instead of incomplete.
        fields[field.name] = found ? clean(found.innerText || found.getAttribute("content") || "") : null;
      }
      row.fields = fields;
    }
    ${
      attributes
        ? `const href = element.getAttribute("href") || (element.querySelector("a[href]") || {}).getAttribute?.("href");
    if (href) row.href = href;
    const value = element.value != null ? String(element.value) : null;
    if (value) row.value = clean(value);`
        : ""
    }
    return row;
  };`;
}

/**
 * The virtualized-list path: scroll, collect, repeat.
 *
 * react-window and its kin keep only the visible window in the DOM, so a
 * single read returns whatever happened to be on screen and says `total: 12`
 * for a list of nine hundred. That is worse than failing, because it looks
 * like an answer.
 *
 * Rows are deduplicated by content rather than by element, because a
 * virtualized list recycles its nodes — the same `<div>` is row 3, then row
 * 40. Content is the only identity that survives, and first-seen order is
 * kept so the result still reads top to bottom.
 *
 * The whole loop runs in one evaluation. Driving it from the CLI would mean a
 * round trip per scroll, and the list would keep rendering between them.
 */
export function buildScrollingExtractExpression(options: ExtractOptions): string {
  const { selector, offset, limit } = normalizeExtractOptions(options);
  const maxScrolls = options.maxScrolls ?? DEFAULT_MAX_SCROLLS;
  if (!Number.isInteger(maxScrolls) || maxScrolls <= 0 || maxScrolls > MAX_SCROLLS_CEILING) {
    return raise(`--max-scrolls must be between 1 and ${MAX_SCROLLS_CEILING}.`);
  }
  const json = (value: string) => JSON.stringify(value);
  const container = options.scrollContainer?.trim();
  return `(async () => {
  ${rowBuilderSource(options)}
  const settle = () => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), ${SCROLL_SETTLE_MS}));
  const scrollableAncestor = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const scrolls = /auto|scroll|overlay/.test(style.overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return null;
  };
  const first = document.querySelector(${json(selector)});
  const container = ${container ? `document.querySelector(${json(container)})` : "null"} || (first ? scrollableAncestor(first) : null);
  const scrollBy = (amount) => {
    if (container) container.scrollTop += amount;
    else window.scrollBy(0, amount);
  };
  const viewport = () => (container ? container.clientHeight : window.innerHeight);

  const seen = new Map();
  const collect = () => {
    for (const element of document.querySelectorAll(${json(selector)})) {
      const row = buildRow(element, 0);
      // Cells join the key so two rows that share a truncated text but differ
      // in their columns are not collapsed into one.
      const key = row.text + "\\u0000" + (row.cells || []).join("\\u0000");
      if (key.length > 1 && !seen.has(key)) seen.set(key, row);
    }
  };

  // Start from the top: a list already scrolled halfway would otherwise lose
  // everything above the current position.
  if (container) container.scrollTop = 0; else window.scrollTo(0, 0);
  await settle();
  collect();

  let passes = 0;
  let stable = 0;
  let complete = true;
  while (stable < ${STABLE_PASSES_REQUIRED}) {
    if (passes >= ${maxScrolls}) { complete = false; break; }
    const before = seen.size;
    // Overlap by a fraction of the viewport so a row straddling the fold is
    // never skipped between passes.
    scrollBy(Math.max(1, Math.floor(viewport() * 0.8)));
    await settle();
    collect();
    passes += 1;
    // Two quiet passes rather than one: a list that renders lazily can answer
    // a single scroll with nothing and still have more below.
    stable = seen.size === before ? stable + 1 : 0;
  }

  const all = Array.from(seen.values());
  const total = all.length;
  const rows = all.slice(${offset}, ${offset + limit}).map((row, position) => ({ ...row, index: ${offset} + position }));
  return { selector: ${json(selector)}, total, offset: ${offset}, limit: ${limit}, rows, scrolled: true, complete, scrollPasses: passes };
})()`;
}

/** Attaches the pagination cursor once the page has answered. */
export function withNextOffset(result: ExtractResult): ExtractResult {
  const consumed = result.offset + result.rows.length;
  return consumed < result.total ? { ...result, nextOffset: consumed } : result;
}
