import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import * as DesktopObservability from "./DesktopObservability.ts";

const logDate = DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-19T10:00:00.000Z"));

describe("DesktopObservability console mirroring", () => {
  it("ignores broken pipe errors", () => {
    const error = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    const stream = {
      destroyed: false,
      writable: true,
      write: () => {
        throw error;
      },
    };

    DesktopObservability.writeNodeStreamBestEffortSync(stream, new Uint8Array([104, 105]));
  });

  it("keeps the stream error listener through a failed write callback", () => {
    const error = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    let errorListener: ((error: unknown) => void) | undefined;
    let detachedDuringWrite = false;
    const stream = {
      destroyed: false,
      writable: true,
      once: (_event: "error", listener: (error: unknown) => void) => {
        errorListener = listener;
      },
      off: (_event: "error", listener: (error: unknown) => void) => {
        if (errorListener === listener) {
          detachedDuringWrite = true;
          errorListener = undefined;
        }
      },
      write: (_chunk: Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(error);
        return false;
      },
    };

    DesktopObservability.writeNodeStreamBestEffortSync(stream, new Uint8Array([104, 105]));

    expect(detachedDuringWrite).toBe(false);
    expect(errorListener).toBeDefined();

    errorListener?.(error);
  });

  it("writes desktop logger records through best-effort streams", () => {
    const output: string[] = [];
    const streams = {
      stdout: {
        write: (chunk: Uint8Array) => {
          output.push(new TextDecoder().decode(chunk));
          return true;
        },
      },
      stderr: {
        write: () => true,
      },
    };

    DesktopObservability.writeDesktopConsoleLogRecordSync(
      {
        date: logDate,
        logLevel: "Info",
        message: ["desktop ready", { port: 6074 }],
        fiberId: 7,
        annotations: { component: "desktop-main" },
      },
      streams,
    );

    expect(output).toEqual([
      '[2026-06-19T10:00:00.000Z] INFO (#7) desktop ready {"port":6074} component=desktop-main\n',
    ]);
  });

  it("ignores broken pipe errors from desktop logger records", () => {
    const error = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    const streams = {
      stdout: {
        write: () => {
          throw error;
        },
      },
      stderr: {
        write: () => {
          throw error;
        },
      },
    };

    DesktopObservability.writeDesktopConsoleLogRecordSync(
      {
        date: logDate,
        logLevel: "Info",
        message: "stdout closed",
      },
      streams,
    );
    DesktopObservability.writeDesktopConsoleLogRecordSync(
      {
        date: logDate,
        logLevel: "Error",
        message: "stderr closed",
      },
      streams,
    );
  });
});
