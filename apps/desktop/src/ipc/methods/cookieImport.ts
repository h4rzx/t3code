/**
 * IPC surface for importing browser cookies into the preview browser.
 *
 * Two rules shape this module:
 *
 *   - It is human-only. These channels are reachable from the Settings screen,
 *     not from MCP tools or the `t3 browser` CLI, because copying a live login
 *     session is the user's decision, not an agent's.
 *   - Nothing is read before consent. The confirmation dialog runs first, in
 *     the main process, so declining it means we never touch the Keychain or
 *     the source browser's cookie database.
 */
import {
  DesktopCookieImportInputSchema,
  DesktopCookieImportResultSchema,
  DesktopCookieImportSourcesSchema,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import type { CookieImportPaths } from "../../preview/CookieImportCatalog.ts";
import {
  CookieImportError,
  importCookiesIntoSession,
  listImportableBrowsers,
} from "../../preview/CookieImportService.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * Windows stores the cookie key under DPAPI, which we do not unwrap yet, so
 * the picker reports the platform as unsupported rather than listing browsers
 * whose cookies would all fail to decrypt.
 */
const isSupportedPlatform = (platform: NodeJS.Platform): platform is "darwin" | "linux" =>
  platform === "darwin" || platform === "linux";

const resolvePaths = Effect.fn("desktop.ipc.cookieImport.resolvePaths")(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  if (!isSupportedPlatform(platform)) return null;
  return {
    platform,
    homeDir: NodeOS.homedir(),
    localAppData: environment["LOCALAPPDATA"],
  } satisfies CookieImportPaths;
});

export const listSources = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COOKIE_IMPORT_LIST_CHANNEL,
  payload: Schema.Void,
  result: DesktopCookieImportSourcesSchema,
  handler: Effect.fn("desktop.ipc.cookieImport.listSources")(function* () {
    const paths = yield* resolvePaths();
    if (paths === null) return { supported: false, sources: [] };
    const browsers = yield* listImportableBrowsers(paths);
    return {
      supported: true,
      sources: browsers.map((browser) => ({
        browserId: browser.id as "chrome",
        label: browser.label,
        profiles: browser.profiles.map((profile) => ({
          directory: profile.directory,
          displayName: profile.label,
        })),
      })),
    };
  }),
});

export const run = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COOKIE_IMPORT_RUN_CHANNEL,
  payload: DesktopCookieImportInputSchema,
  result: DesktopCookieImportResultSchema,
  handler: Effect.fn("desktop.ipc.cookieImport.run")(function* ({
    browserId,
    profileDirectory,
    environmentIds,
  }) {
    const paths = yield* resolvePaths();
    if (paths === null) {
      return yield* new CookieImportError({
        reason: "unsupported_platform",
        detail: "Importing browser cookies is not supported on this platform yet.",
      });
    }

    const browsers = yield* listImportableBrowsers(paths);
    const source = browsers.find((browser) => browser.id === browserId);
    const profile = source?.profiles.find((candidate) => candidate.directory === profileDirectory);
    if (source === undefined || profile === undefined) {
      return yield* new CookieImportError({
        reason: "database_unreadable",
        detail: `Could not find the ${profileDirectory} profile. It may have been removed since the list was loaded.`,
      });
    }

    // Consent before any read. Declining leaves the source browser untouched.
    const dialog = yield* ElectronDialog.ElectronDialog;
    const confirmation = yield* dialog.showMessageBox({
      type: "warning",
      buttons: ["Import Cookies", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      title: "Import browser cookies",
      message: `Import cookies from ${source.label} (${profile.label})?`,
      detail:
        "This copies your signed-in sessions into T3 Code's preview browser, so previews can open pages that need a login. " +
        "Any agent that controls the preview browser will be able to act as you on those sites. " +
        `${source.label} is not modified, and you can clear the imported cookies at any time from Settings.`,
    });
    if (confirmation.response !== 0) return { status: "cancelled" as const, ...EMPTY_COUNTS };

    const manager = yield* PreviewManager.PreviewManager;
    const sessions = yield* Effect.all(
      (environmentIds.length > 0 ? environmentIds : [undefined]).map((environmentId) =>
        manager.getBrowserSession(environmentId),
      ),
      { concurrency: "unbounded" },
    );

    const summary = yield* importCookiesIntoSession({
      platform: paths.platform,
      family: source.family,
      definition: source.definition,
      cookiePath: profile.cookiePath,
      sessions,
      nowSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    });
    return { status: "imported" as const, imported: summary.imported, skipped: summary.skipped };
  }),
});

const EMPTY_COUNTS = {
  imported: 0,
  skipped: {
    device_bound: 0,
    decryption_failed: 0,
    expired: 0,
    invalid_domain: 0,
    empty_name: 0,
    rejected: 0,
  },
};
