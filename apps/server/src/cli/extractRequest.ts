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
}

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
  const { selector, offset, limit, cellSelector, attributes } = normalizeExtractOptions(options);
  const json = (value: string) => JSON.stringify(value);
  return `(() => {
  const matches = Array.from(document.querySelectorAll(${json(selector)}));
  const total = matches.length;
  const slice = matches.slice(${offset}, ${offset + limit});
  const clean = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, ${MAX_CELL_CHARS});
  const fieldSpec = ${JSON.stringify(options.fields ?? [])};
  const rows = slice.map((element, position) => {
    const cells = Array.from(element.querySelectorAll(${json(cellSelector)})).map((cell) => clean(cell.innerText));
    const row = { index: ${offset} + position, text: clean(element.innerText) };
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
  });
  return { selector: ${json(selector)}, total, offset: ${offset}, limit: ${limit}, rows };
})()`;
}

/** Attaches the pagination cursor once the page has answered. */
export function withNextOffset(result: ExtractResult): ExtractResult {
  const consumed = result.offset + result.rows.length;
  return consumed < result.total ? { ...result, nextOffset: consumed } : result;
}
