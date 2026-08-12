import type { PreviewAutomationElement } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewRefs } from "./automationRequest.ts";
import { assignPreviewRefs, isPreviewRef, previewRefSelectors } from "./refRegistry.ts";

const element = (name: string, selector: string): PreviewAutomationElement => ({
  tag: "button",
  role: "button",
  name,
  selector,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
});

describe("preview refs", () => {
  const elements = [element("Send", "#send"), element("Cancel", "#cancel")];

  it("numbers elements in snapshot order", () => {
    expect(assignPreviewRefs(elements).map((entry) => entry.ref)).toEqual(["@e1", "@e2"]);
    expect(previewRefSelectors(elements).get("@e2")).toBe("#cancel");
  });

  it("recognizes refs and leaves locators alone", () => {
    expect(isPreviewRef("@e12")).toBe(true);
    expect(isPreviewRef("role=button[name='Send']")).toBe(false);
    expect(isPreviewRef("@element")).toBe(false);
  });
});

describe("resolvePreviewRefs", () => {
  const refs = previewRefSelectors([element("Send", "#send")]);

  it("swaps a ref for the selector the snapshot recorded", () => {
    expect(resolvePreviewRefs({ locator: "@e1", timeoutMs: 1000 }, refs)).toEqual({
      input: { selector: "#send", timeoutMs: 1000 },
    });
  });

  it("passes ordinary locators through untouched", () => {
    const input = { locator: "role=button[name='Send']" };
    expect(resolvePreviewRefs(input, refs)).toEqual({ input });
  });

  it("reports a ref that no longer resolves instead of clicking the wrong thing", () => {
    expect(resolvePreviewRefs({ locator: "@e9" }, refs).staleRef).toBe("@e9");
  });
});
