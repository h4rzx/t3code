import { describe, expect, it } from "vite-plus/test";

import {
  BrowserCommandInputError,
  DEFAULT_SNAPSHOT_ELEMENT_BUDGET,
  DEFAULT_SNAPSHOT_TEXT_BUDGET,
  buildAppearanceInput,
  buildClickInput,
  buildNavigateTarget,
  buildResizeInput,
  buildScrollInput,
  buildWaitInput,
  parseModifiers,
  parseViewportSize,
  projectSnapshotForCli,
} from "./browserRequest.ts";

const noTarget = { locator: undefined, selector: undefined } as const;

describe("buildNavigateTarget", () => {
  it("sends a bare URL through unchanged", () => {
    expect(
      buildNavigateTarget({
        url: "t3.chat",
        port: undefined,
        protocol: undefined,
        path: undefined,
      }),
    ).toEqual({ url: "t3.chat" });
  });

  it("builds an environment-port target with optional protocol and path", () => {
    expect(
      buildNavigateTarget({ url: undefined, port: 5173, protocol: "https", path: "/settings" }),
    ).toEqual({
      target: { kind: "environment-port", port: 5173, protocol: "https", path: "/settings" },
    });
  });

  it("rejects a URL combined with port-only flags", () => {
    expect(() =>
      buildNavigateTarget({
        url: "t3.chat",
        port: undefined,
        protocol: undefined,
        path: "/settings",
      }),
    ).toThrow(BrowserCommandInputError);
    expect(() =>
      buildNavigateTarget({ url: "t3.chat", port: 5173, protocol: undefined, path: undefined }),
    ).toThrow(BrowserCommandInputError);
  });

  it("requires a destination", () => {
    expect(() =>
      buildNavigateTarget({
        url: undefined,
        port: undefined,
        protocol: undefined,
        path: undefined,
      }),
    ).toThrow(BrowserCommandInputError);
  });
});

describe("buildResizeInput", () => {
  it("defaults to following the preview panel", () => {
    expect(
      buildResizeInput({ size: undefined, preset: undefined, orientation: undefined }),
    ).toEqual({ mode: "fill" });
  });

  it("parses freeform dimensions", () => {
    expect(
      buildResizeInput({ size: "1024x768", preset: undefined, orientation: undefined }),
    ).toEqual({ mode: "freeform", width: 1024, height: 768 });
  });

  it("keeps orientation with a preset and rejects it without one", () => {
    expect(
      buildResizeInput({ size: undefined, preset: "iphone-12-pro", orientation: "landscape" }),
    ).toEqual({ mode: "preset", preset: "iphone-12-pro", orientation: "landscape" });
    expect(() =>
      buildResizeInput({ size: "800x600", preset: undefined, orientation: "landscape" }),
    ).toThrow(BrowserCommandInputError);
  });

  it("rejects a malformed size", () => {
    expect(() => parseViewportSize("1024*768")).toThrow(BrowserCommandInputError);
  });
});

describe("buildClickInput", () => {
  it("accepts exactly one target", () => {
    expect(
      buildClickInput({
        ...noTarget,
        locator: "role=button[name='Send']",
        x: undefined,
        y: undefined,
        timeoutMs: 2000,
      }),
    ).toEqual({ locator: "role=button[name='Send']", timeoutMs: 2000 });
    expect(buildClickInput({ ...noTarget, x: 10, y: 20, timeoutMs: undefined })).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("rejects partial coordinates, mixed targets, and no target", () => {
    expect(() =>
      buildClickInput({ ...noTarget, x: 10, y: undefined, timeoutMs: undefined }),
    ).toThrow(BrowserCommandInputError);
    expect(() =>
      buildClickInput({ ...noTarget, locator: "text=Go", x: 1, y: 2, timeoutMs: undefined }),
    ).toThrow(BrowserCommandInputError);
    expect(() =>
      buildClickInput({ ...noTarget, x: undefined, y: undefined, timeoutMs: undefined }),
    ).toThrow(BrowserCommandInputError);
  });
});

describe("buildScrollInput and buildWaitInput", () => {
  it("requires at least one delta", () => {
    expect(buildScrollInput({ ...noTarget, deltaX: undefined, deltaY: 400 })).toEqual({
      deltaY: 400,
    });
    expect(() => buildScrollInput({ ...noTarget, deltaX: undefined, deltaY: undefined })).toThrow(
      BrowserCommandInputError,
    );
  });

  it("requires at least one wait condition", () => {
    expect(
      buildWaitInput({
        ...noTarget,
        text: "Ready",
        urlIncludes: undefined,
        timeoutMs: 5000,
      }),
    ).toEqual({ text: "Ready", timeoutMs: 5000 });
    expect(() =>
      buildWaitInput({
        ...noTarget,
        text: undefined,
        urlIncludes: undefined,
        timeoutMs: undefined,
      }),
    ).toThrow(BrowserCommandInputError);
  });
});

describe("parseModifiers and buildAppearanceInput", () => {
  it("normalizes casing and rejects unknown values", () => {
    expect(parseModifiers("meta,shift")).toEqual(["Meta", "Shift"]);
    expect(parseModifiers(undefined)).toBeUndefined();
    expect(() => parseModifiers("hyper")).toThrow(BrowserCommandInputError);
    expect(buildAppearanceInput("DARK")).toEqual({ colorScheme: "dark" });
    expect(() => buildAppearanceInput("sepia")).toThrow(BrowserCommandInputError);
  });
});

describe("projectSnapshotForCli", () => {
  const snapshot = {
    url: "https://t3.chat",
    title: "T3 Chat",
    loading: false,
    visibleText: "hello",
    interactiveElements: [],
    accessibilityTree: { role: "document" },
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: { mimeType: "image/png", data: "aGk=", width: 100, height: 50 },
  };

  it("drops the screenshot payload and accessibility tree by default", () => {
    const projection = projectSnapshotForCli(snapshot, {
      screenshotPath: undefined,
      includeScreenshotData: false,
      includeAccessibilityTree: false,
    });
    expect(projection.screenshotBase64).toBeNull();
    expect(projection.json.accessibilityTree).toBeUndefined();
    expect(projection.json.screenshot).toEqual({
      mimeType: "image/png",
      width: 100,
      height: 50,
    });
    expect(projection.json.visibleText).toBe("hello");
  });

  it("hands back the PNG bytes and reports the path when a file was requested", () => {
    const projection = projectSnapshotForCli(snapshot, {
      screenshotPath: "/tmp/shot.png",
      includeScreenshotData: true,
      includeAccessibilityTree: true,
    });
    expect(projection.screenshotBase64).toBe("aGk=");
    expect(projection.json.accessibilityTree).toEqual({ role: "document" });
    expect(projection.json.screenshot).toEqual({
      mimeType: "image/png",
      width: 100,
      height: 50,
      data: "aGk=",
      path: "/tmp/shot.png",
    });
  });
});

describe("snapshot budgets", () => {
  const bigSnapshot = {
    url: "https://example.com",
    title: "Example",
    loading: false,
    visibleText: "x".repeat(5000),
    interactiveElements: Array.from({ length: 100 }, (_, index) => ({
      tag: "button",
      role: "button",
      name: index % 2 === 0 ? "" : `Button ${index}`,
      selector: `#b${index}`,
      x: 0,
      y: index,
      width: 10,
      height: 10,
    })),
    accessibilityTree: {},
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: { mimeType: "image/png", data: "aGk=", width: 1, height: 1 },
  };

  const project = (full: boolean) =>
    projectSnapshotForCli(bigSnapshot, {
      screenshotPath: undefined,
      includeScreenshotData: false,
      includeAccessibilityTree: false,
      full,
    });

  it("trims text and elements, and says what it dropped", () => {
    const json = project(false).json;
    expect((json.visibleText as string).length).toBe(DEFAULT_SNAPSHOT_TEXT_BUDGET);
    expect((json.interactiveElements as ReadonlyArray<unknown>).length).toBe(
      DEFAULT_SNAPSHOT_ELEMENT_BUDGET,
    );
    expect(json.truncated).toMatchObject({
      visibleTextChars: { kept: DEFAULT_SNAPSHOT_TEXT_BUDGET, total: 5000 },
      interactiveElements: { kept: DEFAULT_SNAPSHOT_ELEMENT_BUDGET, total: 100 },
    });
  });

  it("keeps every named element when it has to choose", () => {
    const kept = project(false).json.interactiveElements as ReadonlyArray<{ name: string }>;
    const named = kept.filter((element) => element.name.trim().length > 0);
    // 50 of the 100 fixtures are named; all of them survive a 60-element budget.
    expect(named.length).toBe(50);
    expect(kept.slice(0, 50).every((element) => element.name.trim().length > 0)).toBe(true);
  });

  it("returns everything under --full", () => {
    const json = project(true).json;
    expect((json.visibleText as string).length).toBe(5000);
    expect((json.interactiveElements as ReadonlyArray<unknown>).length).toBe(100);
    expect(json.truncated).toBeUndefined();
  });
});

describe("projectSnapshotForCli aria snapshot", () => {
  const base = {
    url: "https://example.com/",
    title: "Example",
    loading: false,
    interactiveElements: [],
    accessibilityTree: {},
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: null,
  };

  const project = (snapshot: Record<string, unknown>) =>
    projectSnapshotForCli(snapshot, {
      screenshotPath: undefined,
      includeScreenshotData: false,
      includeAccessibilityTree: false,
    }).json as Record<string, unknown>;

  it("prefers the aria tree and drops the flattened text", () => {
    // Emitting both would pay twice for two descriptions of the same page.
    const json = project({
      ...base,
      visibleText: "Example Domain More information...",
      ariaSnapshot: '- heading "Example Domain" [level=1]\n- link "More information"',
    });
    expect(json.ariaSnapshot).toContain("Example Domain");
    expect(json.visibleText).toBeUndefined();
  });

  it("falls back to visible text when the host produced no tree", () => {
    const json = project({ ...base, visibleText: "Example Domain" });
    expect(json.visibleText).toBe("Example Domain");
    expect(json.ariaSnapshot).toBeUndefined();
  });

  it("ignores an empty tree rather than reporting a blank page", () => {
    const json = project({ ...base, visibleText: "Example Domain", ariaSnapshot: "" });
    expect(json.visibleText).toBe("Example Domain");
  });

  it("does not borrow the host's text total for a tree it never measured", () => {
    // visibleTextTotal describes visibleText. Applying it to the tree would
    // report a truncation that never happened.
    const json = project({
      ...base,
      visibleText: "short",
      visibleTextTotal: 500_000,
      ariaSnapshot: '- heading "Example"',
    });
    expect(json.truncated).toBeUndefined();
  });
});
