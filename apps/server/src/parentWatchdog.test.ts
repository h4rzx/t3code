import { describe, expect, it } from "vite-plus/test";

import { isOrphaned } from "./parentWatchdog.ts";

describe("isOrphaned", () => {
  it("is false while the original parent is still the parent", () => {
    expect(isOrphaned({ startParentId: 4242, currentParentId: 4242 })).toBe(false);
  });

  it("is true once the process has been reparented", () => {
    // The only way the parent id changes is the parent exiting, which is the
    // exact case the desktop's own cleanup cannot cover.
    expect(isOrphaned({ startParentId: 4242, currentParentId: 1 })).toBe(true);
  });

  it("treats reparenting to any other process as orphaned", () => {
    // Not every system reparents to pid 1; some use a subreaper.
    expect(isOrphaned({ startParentId: 4242, currentParentId: 99 })).toBe(true);
  });

  it("never reports a process that started without a parent", () => {
    // A server launched directly by init has nothing to watch, and shutting it
    // down here would kill a legitimate deployment.
    expect(isOrphaned({ startParentId: 1, currentParentId: 1 })).toBe(false);
    expect(isOrphaned({ startParentId: 0, currentParentId: 1 })).toBe(false);
  });
});
