/**
 * Recovering a desktop error's tag after it crosses Electron IPC.
 *
 * `ipcRenderer.invoke` rejections arrive as plain `Error` objects: Electron
 * serializes the name and message and drops every custom property, so the
 * `_tag` an Effect `TaggedErrorClass` carries in the main process is gone by
 * the time the renderer sees it. Code that branched on `cause._tag` therefore
 * never matched, and every typed automation failure collapsed into the generic
 * "execution failed" the caller eventually saw.
 *
 * What Electron does preserve is the error's name inside the message:
 *
 *   Error invoking remote method 'desktop:preview-click': PreviewAutomationInvalidSelectorError: ...
 *
 * For a `TaggedErrorClass` the class name is the tag, so the tag can be read
 * back out of that prefix. Parsing a message is not as good as structured
 * transport — the real fix is an error envelope in the IPC layer — but it is
 * accurate for these errors and does not require changing every IPC method.
 */

/** `Error invoking remote method '<channel>': ` — Electron's rejection prefix. */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/;
/** A tag is a class name: capitalised, no spaces, followed by `: `. */
const LEADING_ERROR_NAME = /^([A-Z][A-Za-z0-9_]*(?:Error|Exception))\s*:/;

/**
 * The originating error's tag, or null when the cause carries no recognisable
 * one. Prefers a real `_tag` so a same-process error (or a future structured
 * envelope) keeps working without going through the string.
 */
export function desktopErrorTag(cause: unknown): string | null {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = (cause as { readonly _tag: unknown })._tag;
    if (typeof tag === "string" && tag.length > 0) return tag;
  }

  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : typeof cause === "object" && cause !== null && "message" in cause
          ? String((cause as { readonly message: unknown }).message)
          : null;
  if (message === null) return null;

  const withoutPrefix = message.replace(REMOTE_METHOD_PREFIX, "");
  return LEADING_ERROR_NAME.exec(withoutPrefix)?.[1] ?? null;
}

/** Whether a cause originated as the given desktop error, across IPC or not. */
export function isDesktopError(cause: unknown, tag: string): boolean {
  return desktopErrorTag(cause) === tag;
}

/**
 * The message a person should read, with Electron's plumbing removed.
 *
 * A rejection arrives as `Error invoking remote method
 * 'desktop:preview-cookie-import-run': CookieImportError: <the actual
 * message>`. Shown as-is, two thirds of the line is a channel name and a class
 * name, and the sentence that tells the user what to do about it starts
 * halfway through. Falls back to the whole message rather than an empty one
 * when there is no prefix to strip.
 */
export function desktopErrorMessage(cause: unknown, fallback: string): string {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : typeof cause === "object" && cause !== null && "message" in cause
          ? String((cause as { readonly message: unknown }).message)
          : "";
  const withoutPrefix = message.replace(REMOTE_METHOD_PREFIX, "");
  const withoutName = withoutPrefix.replace(LEADING_ERROR_NAME, "").trim();
  return withoutName.length > 0 ? withoutName : withoutPrefix.trim() || fallback;
}
