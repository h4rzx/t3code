#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

const devRunnerPath = NodeURL.fileURLToPath(new URL("./dev-runner.ts", import.meta.url));

class DevSandboxError extends Data.TaggedError("DevSandboxError")<{
  readonly message: string;
}> {}

const resolveSandboxEnvironment = Effect.gen(function* () {
  const path = yield* Path.Path;
  const productionHome = path.resolve(path.join(NodeOS.homedir(), ".t3"));
  const sandboxHome = path.resolve(
    process.env.T3CODE_HOME?.trim() || path.join(NodeOS.homedir(), ".t3-dev"),
  );
  const devInstance = process.env.T3CODE_DEV_INSTANCE?.trim() || "dev";
  const workspaceLayout = process.env.T3CODE_WORKSPACE_LAYOUT?.trim() || "1";

  if (sandboxHome === productionHome && process.env.T3CODE_ALLOW_PROD_HOME !== "1") {
    return yield* new DevSandboxError({
      message: [
        "[dev-sandbox] Refusing to use the production T3 Code data directory.",
        `T3CODE_HOME=${sandboxHome}`,
        "Use a dev directory such as T3CODE_HOME=$HOME/.t3-dev, or set T3CODE_ALLOW_PROD_HOME=1 if this is intentional.",
      ].join("\n"),
    });
  }

  return { devInstance, sandboxHome, workspaceLayout };
});

const runDevSandbox = Effect.gen(function* () {
  const { devInstance, sandboxHome, workspaceLayout } = yield* resolveSandboxEnvironment;

  yield* Effect.logWarning(
    `[dev-sandbox] instance=${devInstance} home=${sandboxHome} workspaceLayout=${workspaceLayout}`,
  );

  const env = {
    ...process.env,
    T3CODE_DEV_INSTANCE: devInstance,
    T3CODE_HOME: sandboxHome,
    T3CODE_WORKSPACE_LAYOUT: workspaceLayout,
  };

  const child = yield* ChildProcess.make(
    process.execPath,
    [devRunnerPath, "dev:desktop", ...process.argv.slice(2)],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      detached: false,
      forceKillAfter: "1500 millis",
    },
  );

  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new DevSandboxError({ message: `dev-runner exited with code ${exitCode}` });
  }
});

runDevSandbox.pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
  NodeRuntime.runMain,
);
