import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

/**
 * System panes the app is allowed to open, and the URLs that address them.
 *
 * Deliberately a fixed map rather than a widening of the protocol allowlist.
 * `openExternal` refuses everything but http and https so a page — or an agent
 * driving one — cannot reach arbitrary URL handlers through the renderer.
 * Opening a settings pane needs a non-web scheme, so the renderer names the
 * pane and the URL never leaves this file. Nothing the caller sends can become
 * part of it.
 */
const SYSTEM_SETTINGS_PANES = {
  /** Privacy & Security → Full Disk Access. */
  "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
} as const;

export type SystemSettingsPane = keyof typeof SYSTEM_SETTINGS_PANES;

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly openSystemSettings: (pane: SystemSettingsPane) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openSystemSettings: (pane) =>
    Effect.promise(() =>
      Electron.shell.openExternal(SYSTEM_SETTINGS_PANES[pane]).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
