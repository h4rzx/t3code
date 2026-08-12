/**
 * Environment variables every provider session inherits, so tools an agent
 * shells out to can find their way back to the thread that spawned them.
 *
 * `t3 browser` is the first consumer: without `T3CODE_THREAD_ID` it can only
 * drive a synthetic thread nobody renders, which means the human never sees the
 * page. With it, `t3 browser open <url>` lands in the agent's own preview panel.
 */
import type { ThreadId } from "@t3tools/contracts";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { detectCliRunner, suggestedPackageSpec } from "../cli/invocation.ts";
import packageJson from "../../package.json" with { type: "json" };

export const T3CODE_THREAD_ID_ENV = "T3CODE_THREAD_ID";
export const T3CODE_CLI_COMMAND_ENV = "T3CODE_CLI_COMMAND";

export interface ProviderSessionEnvironmentInput {
  readonly threadId: ThreadId;
  /** T3 home for this server, so tools do not have to guess `~/.t3`. */
  readonly baseDir?: string | undefined;
  /** How to invoke this server's CLI, so agents never guess an executable. */
  readonly cliCommand?: string | undefined;
}

export function providerSessionEnvironment(
  input: ProviderSessionEnvironmentInput,
): Record<string, string> {
  return {
    [T3CODE_THREAD_ID_ENV]: input.threadId,
    // T3CODE_HOME is already the documented way to select a T3 home, and the
    // server config reader honors it, so a spawned `t3` command targets this
    // server rather than the developer's default install.
    ...(input.baseDir === undefined ? {} : { T3CODE_HOME: input.baseDir }),
    ...(input.cliCommand === undefined ? {} : { [T3CODE_CLI_COMMAND_ENV]: input.cliCommand }),
  };
}

/**
 * The command that invokes *this* server's CLI, so an agent never has to guess.
 *
 * A packaged install resolves to `t3`; a package-runner launch keeps its runner
 * (`npx t3`); a source checkout — where no `t3` is on PATH at all — resolves to
 * `node <repo>/apps/server/src/bin.ts`, which is the case that otherwise sends
 * agents hunting for a binary that does not exist yet.
 *
 * Pure so the resolution rules can be tested without a runtime; the Effect
 * below only supplies the process entry path.
 */
export function t3CliCommandFor(entryPath: string): string {
  const runner = detectCliRunner(entryPath);
  if (runner !== null) return `${runner} ${suggestedPackageSpec(packageJson.version)}`;
  const normalized = entryPath.replaceAll("\\", "/");
  // A checkout is any entry under apps/server, built or not. The dev desktop
  // app launches `apps/server/dist/bin.mjs`, which is neither a `.ts` file nor
  // under `src/`: claiming `t3` there sends the agent probing for a binary that
  // is not on PATH, which is exactly what this variable exists to prevent.
  const isCheckout =
    normalized.endsWith(".ts") ||
    normalized.includes("/apps/server/src/") ||
    normalized.includes("/apps/server/dist/");
  return isCheckout ? `node ${entryPath}` : "t3";
}

export const resolveT3CliCommand = Effect.map(HostProcessArguments, (processArguments) =>
  t3CliCommandFor(processArguments[1] ?? ""),
);
