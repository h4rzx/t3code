const guardedConsoleStreams = new WeakSet<NodeJS.WriteStream>();

export function isIgnorableConsoleStreamError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const errorCode = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  return errorCode === "EPIPE" || errorCode === "ERR_STREAM_DESTROYED";
}

export function ensureConsoleStreamGuard(output: NodeJS.WriteStream): void {
  if (guardedConsoleStreams.has(output)) return;
  guardedConsoleStreams.add(output);
  output.on("error", (cause) => {
    if (isIgnorableConsoleStreamError(cause)) return;
    throw cause;
  });
}

function guardConsoleMethod<T extends (...args: Array<unknown>) => void>(method: T): T {
  return ((...args: Parameters<T>) => {
    try {
      method(...args);
    } catch (cause) {
      if (!isIgnorableConsoleStreamError(cause)) {
        throw cause;
      }
    }
  }) as T;
}

export function installDesktopConsoleGuards(): void {
  ensureConsoleStreamGuard(process.stdout);
  ensureConsoleStreamGuard(process.stderr);
  console.log = guardConsoleMethod(console.log.bind(console));
  console.info = guardConsoleMethod(console.info.bind(console));
  console.warn = guardConsoleMethod(console.warn.bind(console));
  console.error = guardConsoleMethod(console.error.bind(console));
  console.debug = guardConsoleMethod(console.debug.bind(console));
}

installDesktopConsoleGuards();
