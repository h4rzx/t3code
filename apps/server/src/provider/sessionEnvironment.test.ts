import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  providerSessionEnvironment,
  t3CliCommandFor,
  T3CODE_CLI_COMMAND_ENV,
  T3CODE_THREAD_ID_ENV,
} from "./sessionEnvironment.ts";

describe("providerSessionEnvironment", () => {
  it("exports the thread id so shelled-out tools can address the calling thread", () => {
    expect(providerSessionEnvironment({ threadId: ThreadId.make("thread-1") })).toEqual({
      [T3CODE_THREAD_ID_ENV]: "thread-1",
    });
  });

  it("names the CLI so an agent never probes for a binary that is not installed", () => {
    expect(
      providerSessionEnvironment({
        threadId: ThreadId.make("thread-1"),
        cliCommand: "node /repo/apps/server/src/bin.ts",
      })[T3CODE_CLI_COMMAND_ENV],
    ).toBe("node /repo/apps/server/src/bin.ts");
  });

  it("pins the T3 home so a spawned CLI targets this server, not the default install", () => {
    expect(
      providerSessionEnvironment({ threadId: ThreadId.make("thread-1"), baseDir: "/tmp/home" }),
    ).toEqual({
      [T3CODE_THREAD_ID_ENV]: "thread-1",
      T3CODE_HOME: "/tmp/home",
    });
  });
});

describe("t3CliCommandFor", () => {
  const resolve = t3CliCommandFor;

  it("points at the built entry a dev desktop app actually launches", () => {
    // Regression: this resolved to "t3", which is not on PATH in a checkout, so
    // agents burned a probe on `t3 --help` before falling back.
    expect(resolve("/repo/apps/server/dist/bin.mjs")).toBe("node /repo/apps/server/dist/bin.mjs");
  });

  it("points at source entries too", () => {
    expect(resolve("/repo/apps/server/src/bin.ts")).toBe("node /repo/apps/server/src/bin.ts");
  });

  it("uses the bare command for a packaged install", () => {
    expect(resolve("/usr/local/lib/t3/bin.mjs")).toBe("t3");
  });
});
