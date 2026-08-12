import { describe, expect, it } from "vite-plus/test";

import {
  buildExtractExpression,
  DEFAULT_EXTRACT_LIMIT,
  MAX_EXTRACT_LIMIT,
  parseFieldSpec,
  normalizeExtractOptions,
  withNextOffset,
  type ExtractResult,
} from "./extractRequest.ts";

describe("normalizeExtractOptions", () => {
  it("defaults limit and cell selector", () => {
    const normalized = normalizeExtractOptions({ selector: "tr" });
    expect(normalized).toEqual({
      selector: "tr",
      offset: 0,
      limit: DEFAULT_EXTRACT_LIMIT,
      cellSelector: "td,th",
      attributes: false,
    });
  });

  it("rejects input that would silently produce nothing", () => {
    expect(() => normalizeExtractOptions({ selector: "   " })).toThrow(/selector is required/);
    expect(() => normalizeExtractOptions({ selector: "tr", offset: -1 })).toThrow(/--offset/);
    expect(() => normalizeExtractOptions({ selector: "tr", limit: 0 })).toThrow(/--limit/);
    expect(() => normalizeExtractOptions({ selector: "tr", limit: MAX_EXTRACT_LIMIT + 1 })).toThrow(
      /--limit/,
    );
  });
});

describe("buildExtractExpression", () => {
  it("escapes the selector so quotes cannot break out of the expression", () => {
    const expression = buildExtractExpression({ selector: 'div[data-x="a\'b"]' });
    expect(expression).toContain(String.raw`"div[data-x=\"a'b\"]"`);
    // The built expression must remain syntactically valid JavaScript.
    expect(() => new Function(`return ${expression}`)).not.toThrow();
  });

  it("slices by the requested window", () => {
    const expression = buildExtractExpression({ selector: "tr", offset: 100, limit: 50 });
    expect(expression).toContain("matches.slice(100, 150)");
    expect(expression).toContain("offset: 100");
    expect(expression).toContain("limit: 50");
  });

  it("counts every match before slicing, so totals do not depend on the page size", () => {
    const expression = buildExtractExpression({ selector: "tr", offset: 10, limit: 5 });
    const totalLine = expression.indexOf("const total = matches.length");
    const sliceLine = expression.indexOf("matches.slice");
    expect(totalLine).toBeGreaterThan(-1);
    expect(totalLine).toBeLessThan(sliceLine);
  });

  it("only reads attributes when asked", () => {
    expect(buildExtractExpression({ selector: "a" })).not.toContain('getAttribute("href")');
    expect(buildExtractExpression({ selector: "a", attributes: true })).toContain(
      'getAttribute("href")',
    );
  });
});

describe("extraction against a real DOM shape", () => {
  /** Runs the generated expression against a minimal document stub. */
  const run = (
    html: ReadonlyArray<ReadonlyArray<string>>,
    options: Parameters<typeof buildExtractExpression>[0],
  ) => {
    const rows = html.map((cells) => ({
      innerText: cells.join(" "),
      querySelectorAll: () => cells.map((cell) => ({ innerText: cell })),
      getAttribute: () => null,
    }));
    const document = { querySelectorAll: () => rows };
    return new Function("document", `return ${buildExtractExpression(options)}`)(
      document,
    ) as ExtractResult;
  };

  const table = Array.from({ length: 200 }, (_, index) => [`Country ${index}`, `${index * 1000}`]);

  it("returns every row's cells in one call, independent of viewport", () => {
    const result = run(table, { selector: "tr", limit: 200 });
    expect(result.total).toBe(200);
    expect(result.rows).toHaveLength(200);
    expect(result.rows[0]).toEqual({ index: 0, text: "Country 0 0", cells: ["Country 0", "0"] });
    expect(result.rows[199]?.cells).toEqual(["Country 199", "199000"]);
  });

  it("paginates over the result set without overlap or gaps", () => {
    const first = run(table, { selector: "tr", offset: 0, limit: 100 });
    const second = run(table, { selector: "tr", offset: 100, limit: 100 });
    expect(first.total).toBe(200);
    expect(second.total).toBe(200);
    expect(first.rows.at(-1)?.index).toBe(99);
    expect(second.rows[0]?.index).toBe(100);
    const seen = new Set([...first.rows, ...second.rows].map((row) => row.index));
    expect(seen.size).toBe(200);
  });

  it("reports a total larger than the page, so a partial read is obvious", () => {
    const result = withNextOffset(run(table, { selector: "tr", limit: 50 }));
    expect(result.total).toBe(200);
    expect(result.rows).toHaveLength(50);
    expect(result.nextOffset).toBe(50);
  });

  it("omits the cursor once the result set is exhausted", () => {
    const result = withNextOffset(run(table, { selector: "tr", offset: 150, limit: 100 }));
    expect(result.rows).toHaveLength(50);
    expect(result.nextOffset).toBeUndefined();
  });
});

describe("withNextOffset", () => {
  const base: ExtractResult = { selector: "tr", total: 10, offset: 0, limit: 5, rows: [] };

  it("advances by the rows actually returned", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ index, text: "x" }));
    expect(withNextOffset({ ...base, rows }).nextOffset).toBe(5);
  });

  it("stops when nothing more remains", () => {
    expect(withNextOffset({ ...base, total: 0 }).nextOffset).toBeUndefined();
  });
});

describe("parseFieldSpec", () => {
  it("parses name:selector pairs", () => {
    expect(parseFieldSpec("name:h3,status:.badge")).toEqual([
      { name: "name", selector: "h3" },
      { name: "status", selector: ".badge" },
    ]);
  });

  it("keeps commas that belong to a selector list", () => {
    expect(parseFieldSpec("name:h3,h4")).toEqual([{ name: "name", selector: "h3,h4" }]);
  });

  it("rejects malformed pairs", () => {
    expect(() => parseFieldSpec("justaname")).toThrow(/name:selector/);
    expect(() => parseFieldSpec("name:")).toThrow(/name:selector/);
  });
});

describe("extract with named fields", () => {
  it("reads card layouts that have no row or cell semantics", () => {
    const cards = [
      { name: "web-app", status: "Ready" },
      { name: "api", status: "Building" },
    ].map((card) => ({
      innerText: `${card.name} ${card.status}`,
      querySelectorAll: () => [],
      querySelector: (sel: string) =>
        sel === "h3"
          ? { innerText: card.name, getAttribute: () => null }
          : sel === ".badge"
            ? { innerText: card.status, getAttribute: () => null }
            : null,
    }));
    const document = { querySelectorAll: () => cards };
    const result = new Function(
      "document",
      `return ${buildExtractExpression({
        selector: "[data-testid=project-card]",
        fields: [
          { name: "name", selector: "h3" },
          { name: "status", selector: ".badge" },
          { name: "missing", selector: ".nope" },
        ],
      })}`,
    )(document) as ExtractResult;

    expect(result.total).toBe(2);
    expect(result.rows[0]?.fields).toEqual({ name: "web-app", status: "Ready", missing: null });
    expect(result.rows[1]?.fields).toEqual({ name: "api", status: "Building", missing: null });
  });
});
