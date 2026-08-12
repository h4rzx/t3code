/**
 * Shutting down when the process that spawned this server is gone.
 *
 * The desktop app spawns the server as a child and terminates it on exit, which
 * works for every orderly shutdown. It does not work when the desktop process
 * dies without running its own cleanup — a crash, or the `kill -9` that ends a
 * wedged dev app. The server is then reparented and keeps running, still
 * holding the server port.
 *
 * The next launch cannot bind, and the failure surfaces as a
 * `PrimaryEnvironmentRequestError` from session bootstrap, which reads like an
 * auth bug rather than a stale process. That misdiagnosis is the actual cost
 * here; the orphan itself is cheap to kill once you know to look for it.
 *
 * There is no portable "die with my parent" primitive — Linux has
 * `PR_SET_PDEATHSIG`, macOS has nothing equivalent — so this polls instead.
 * Reparenting is the signal: a process whose parent exits is adopted by init
 * (or launchd), so the parent id changes exactly once, when the parent dies.
 */
import { HostProcessParentId } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

/**
 * Slow enough to be free, fast enough that a developer restarting the app does
 * not notice the old server holding the port.
 */
export const PARENT_WATCHDOG_POLL_INTERVAL = "2 seconds";

/**
 * Whether the parent this process started under has gone away.
 *
 * A changed parent id means reparenting, which only happens on parent exit. The
 * init check is a belt-and-braces case for a process that was already adopted
 * before the first observation.
 */
export function isOrphaned(input: {
  readonly startParentId: number;
  readonly currentParentId: number;
}): boolean {
  if (input.startParentId <= 1) return false;
  return input.currentParentId !== input.startParentId || input.currentParentId <= 1;
}

/**
 * Completes when this process is orphaned, and never otherwise. Intended to
 * race the server so that completing here tears the server down through its
 * normal shutdown path rather than exiting the process abruptly.
 */
export const awaitOrphaned = Effect.gen(function* () {
  const readParentId = yield* HostProcessParentId;
  const startParentId = readParentId();

  // Already adopted, or no parent to speak of: nothing to watch, so park
  // forever rather than shutting a legitimately parentless server down.
  if (startParentId <= 1) return yield* Effect.never;

  yield* Effect.sleep(PARENT_WATCHDOG_POLL_INTERVAL).pipe(
    Effect.repeat({
      until: () => isOrphaned({ startParentId, currentParentId: readParentId() }),
    }),
  );

  yield* Effect.logWarning(
    "Parent process exited; shutting down so the server port is not held by an orphan.",
    { startParentId },
  );
});
