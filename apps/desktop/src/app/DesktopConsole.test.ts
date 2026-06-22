import { assert, describe, it } from "@effect/vitest";

import "./DesktopConsole.ts";

describe("DesktopConsole", () => {
  it("ignores EPIPE thrown by console stdout writes", () => {
    const originalWrite = process.stdout.write;
    process.stdout.write = function () {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    } as typeof process.stdout.write;

    try {
      const guardedLog: (...data: Array<unknown>) => void = console["log"].bind(console);
      assert.doesNotThrow(() => guardedLog("ignored broken stdout"));
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("ignores EPIPE emitted by console stdout writes", async () => {
    const originalWrite = process.stdout.write;
    process.stdout.write = function (...args: Parameters<typeof process.stdout.write>) {
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      queueMicrotask(() => process.stdout.emit("error", error));
      for (const arg of args) {
        if (typeof arg === "function") arg();
      }
      return false;
    } as typeof process.stdout.write;

    try {
      const guardedLog: (...data: Array<unknown>) => void = console["log"].bind(console);
      guardedLog("ignored broken stdout");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
