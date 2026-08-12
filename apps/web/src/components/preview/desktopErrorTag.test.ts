import { describe, expect, it } from "vite-plus/test";

import { desktopErrorTag, isDesktopError } from "./desktopErrorTag";

describe("desktopErrorTag", () => {
  it("recovers the tag from an Electron IPC rejection", () => {
    // Verbatim shape Electron produces; the custom `_tag` field is gone by here.
    const cause = new Error(
      "Error invoking remote method 'desktop:preview-click': PreviewAutomationInvalidSelectorError: click rejected selector (5 characters) in tab x",
    );
    expect(desktopErrorTag(cause)).toBe("PreviewAutomationInvalidSelectorError");
  });

  it("prefers a real _tag when the error did not cross IPC", () => {
    expect(desktopErrorTag({ _tag: "PreviewAutomationTimeoutError", message: "..." })).toBe(
      "PreviewAutomationTimeoutError",
    );
  });

  it("reads a bare error name with no remote-method prefix", () => {
    expect(desktopErrorTag(new Error("CookieImportError: the database could not be read"))).toBe(
      "CookieImportError",
    );
  });

  it("returns null when there is no tag to recover", () => {
    expect(desktopErrorTag(new Error("something went wrong"))).toBeNull();
    expect(desktopErrorTag(new Error("lowercase: not a class name"))).toBeNull();
    expect(desktopErrorTag(null)).toBeNull();
    expect(desktopErrorTag(undefined)).toBeNull();
    expect(desktopErrorTag(42)).toBeNull();
  });

  it("does not mistake a message that merely contains a tag for the cause", () => {
    // The name must lead the message, or any error quoting another one would
    // be misreported as that error.
    expect(
      desktopErrorTag(new Error("wrapped: PreviewAutomationTimeoutError happened earlier")),
    ).toBeNull();
  });

  it("handles a string cause", () => {
    expect(desktopErrorTag("PreviewAutomationTabNotFoundError: no tab")).toBe(
      "PreviewAutomationTabNotFoundError",
    );
  });
});

describe("isDesktopError", () => {
  it("matches across the IPC boundary", () => {
    const cause = new Error(
      "Error invoking remote method 'desktop:preview-type': PreviewAutomationTargetNotEditableError: needs an editable target",
    );
    expect(isDesktopError(cause, "PreviewAutomationTargetNotEditableError")).toBe(true);
    expect(isDesktopError(cause, "PreviewAutomationInvalidSelectorError")).toBe(false);
  });
});
