/**
 * `t3 browser` — drive the collaborative browser from a terminal.
 *
 * This is the CLI face of the same automation the MCP `preview_*` tools use, so
 * an agent that cannot speak MCP (or a human debugging one) can open, inspect,
 * and interact with the tab a running T3 Code app is showing. Commands talk to
 * the local server's `/api/preview/*` routes with a short-lived session token
 * minted from this machine's auth store.
 */
import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  type PreviewAutomationOperation,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import { T3CODE_THREAD_ID_ENV } from "../provider/sessionEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  BrowserCommandInputError,
  buildAppearanceInput,
  buildClickInput,
  buildNavigateTarget,
  buildResizeInput,
  buildScrollInput,
  buildTargetedInput,
  buildWaitInput,
  parseModifiers,
  projectSnapshotForCli,
} from "./browserRequest.ts";
import {
  buildExtractExpression,
  DEFAULT_EXTRACT_LIMIT,
  DEFAULT_MAX_SCROLLS,
  MAX_EXTRACT_LIMIT,
  MAX_SCROLLS_CEILING,
  parseFieldSpec,
} from "./extractRequest.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

class BrowserCommandError extends CliError.UserError {
  override get message() {
    return String(this.cause);
  }
}

const browserCommandError = (detail: string) => new BrowserCommandError({ cause: detail });

/** Command output is JSON so agents can pipe it straight into a parser. */
const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });
const encodePrettyJson = Schema.encodeEffect(PrettyJson);

const printJson = (value: unknown) =>
  encodePrettyJson(value).pipe(
    Effect.orElseSucceed(() => String(value)),
    Effect.flatMap(Console.log),
  );

const targetFlags = {
  ...projectLocationFlags,
  tab: Flag.string("tab").pipe(
    Flag.withDescription("Collaborative browser tab id. Defaults to this thread's current tab."),
    Flag.optional,
  ),
  thread: Flag.string("thread").pipe(
    Flag.withDescription(
      "Thread that owns the tab. Defaults to the calling agent's thread when T3CODE_THREAD_ID is set, otherwise a shared CLI browser thread.",
    ),
    Flag.optional,
  ),
} as const;

interface BrowserTargetFlags extends CliAuthLocationFlags {
  readonly tab: Option.Option<string>;
  readonly thread: Option.Option<string>;
}

const elementFlag = Flag.string("element").pipe(
  Flag.withDescription("Element ref from the latest snapshot, e.g. @e3. Preferred over selectors."),
  Flag.optional,
);
const noObserveFlag = Flag.boolean("no-observe").pipe(
  Flag.withDescription("Skip the post-action page read that reports what changed."),
  Flag.withDefault(false),
);
const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDescription("Maximum wait in milliseconds (default 15000, maximum 60000)."),
  Flag.optional,
);
const locatorFlag = Flag.string("locator").pipe(
  Flag.withDescription(
    "Playwright selector, preferably role/text based, e.g. role=button[name='Send'].",
  ),
  Flag.optional,
);
const selectorFlag = Flag.string("selector").pipe(
  Flag.withDescription("Legacy CSS selector. Prefer --locator."),
  Flag.optional,
);

const orUndefined = <A>(option: Option.Option<A>): A | undefined => Option.getOrUndefined(option);

const withInputError = <A>(build: () => A) =>
  Effect.try({
    try: build,
    catch: (cause) =>
      browserCommandError(
        cause instanceof BrowserCommandInputError ? cause.message : String(cause),
      ),
  });

/**
 * Resolve the running server, mint a scoped session token for one command, and
 * hand back a caller that speaks the environment HTTP API.
 */
const withLiveServer = <A>(
  flags: CliAuthLocationFlags,
  run: (call: {
    readonly origin: string;
    readonly token: string;
  }) => Effect.Effect<A, BrowserCommandError, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    // Output is JSON on stdout, and the auth store logs its migrations at info
    // level on the way up. Stay quiet unless the caller asked for detail.
    const minimumLogLevel = Option.getOrElse(logLevel, (): LogLevel.LogLevel => "Warn");
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* browserCommandError(
        "No running T3 Code server was found. Start one with `t3` (or open the desktop app) and try again.",
      );
    }
    const origin = runtimeState.value.origin;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({
          scopes: AuthAdministrativeScopes,
          label: "t3 browser cli",
        }),
        (issued) => run({ origin, token: issued.token }),
        (issued) =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

/**
 * Which thread owns the tab. A provider session exports `T3CODE_THREAD_ID`, so
 * an agent shelling out to this CLI drives the tab in its own preview panel —
 * the human sees the page without the agent having to know its thread id.
 */
const resolveThreadId = Effect.fnUntraced(function* (flags: BrowserTargetFlags) {
  if (Option.isSome(flags.thread)) return ThreadId.make(flags.thread.value);
  const fromEnvironment = yield* Config.string(T3CODE_THREAD_ID_ENV).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  );
  const trimmed = fromEnvironment?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? ThreadId.make(trimmed) : undefined;
});

const automationRequest = (
  flags: BrowserTargetFlags & { readonly noObserve?: boolean },
  operation: PreviewAutomationOperation,
  input: Record<string, unknown>,
  threadId: ThreadId | undefined,
) => ({
  operation,
  input,
  ...(flags.noObserve === true ? { observe: false } : {}),
  ...(Option.isSome(flags.tab) ? { tabId: flags.tab.value } : {}),
  ...(threadId === undefined ? {} : { threadId }),
});

/** Every browser subcommand funnels through here so failures read the same. */
const invokeAutomation = (
  flags: BrowserTargetFlags,
  operation: PreviewAutomationOperation,
  buildInput: () => Record<string, unknown>,
  onResult?: (result: unknown) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const input = yield* withInputError(buildInput);
    const threadId = yield* resolveThreadId(flags);
    return yield* withLiveServer(flags, ({ origin, token }) =>
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
        const response = yield* client.preview.automation({
          headers: { authorization: `Bearer ${token}` },
          payload: automationRequest(flags, operation, input, threadId),
        });
        if (onResult) {
          yield* onResult(response.result);
          return;
        }
        // The envelope carries `observed` — what moved on the page — so a caller
        // can skip the reflex snapshot after every action.
        yield* printJson({
          tabId: response.tabId,
          result: response.result ?? null,
          ...(response.observed === undefined ? {} : { observed: response.observed }),
        });
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.catch(reportFailure)),
    );
  });

/**
 * Failures are printed to stderr as JSON with a stable `failure` code and a
 * `recovery` command, so an agent can act on the next step instead of parsing
 * prose. The exit code stays non-zero.
 */
const reportFailure = (error: unknown) =>
  Effect.gen(function* () {
    const payload = failurePayload(error);
    yield* encodePrettyJson({ error: payload }).pipe(
      Effect.orElseSucceed(() => payload.message),
      Effect.flatMap(Console.error),
    );
    return yield* browserCommandError(payload.message);
  });

const failurePayload = (
  error: unknown,
): { readonly failure: string; readonly message: string; readonly recovery?: string } => {
  if (typeof error === "object" && error !== null && "failure" in error) {
    const typed = error as {
      readonly failure?: unknown;
      readonly detail?: unknown;
      readonly recovery?: unknown;
    };
    return {
      failure: typeof typed.failure === "string" ? typed.failure : "preview_execution_failed",
      message: typeof typed.detail === "string" ? typed.detail : String(error),
      ...(typeof typed.recovery === "string" ? { recovery: typed.recovery } : {}),
    };
  }
  return { failure: "cli_request_failed", message: describeFailure(error) };
};

const describeFailure = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return String(error);
};

const statusCommand = Command.make("status", targetFlags).pipe(
  Command.withDescription("Report tab availability, URL, title, loading state, and viewport."),
  Command.withHandler((flags) => invokeAutomation(flags, "status", () => ({}))),
);

const listTabs = (flags: CliAuthLocationFlags & { readonly thread: Option.Option<string> }) =>
  Effect.gen(function* () {
    const threadId = yield* resolveThreadId({ ...flags, tab: Option.none() });
    return yield* withLiveServer(flags, ({ origin, token }) =>
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
        const response = yield* client.preview.tabs({
          headers: { authorization: `Bearer ${token}` },
          payload: threadId === undefined ? {} : { threadId },
        });
        yield* printJson(response);
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.catch(reportFailure)),
    );
  });

const tabsCommand = Command.make("tabs", {
  ...projectLocationFlags,
  thread: targetFlags.thread,
}).pipe(
  Command.withDescription("List the collaborative browser tabs owned by a thread."),
  Command.withHandler((flags) => listTabs(flags)),
);

const tabListCommand = Command.make("list", {
  ...projectLocationFlags,
  thread: targetFlags.thread,
}).pipe(
  Command.withDescription("List the collaborative browser tabs owned by a thread."),
  Command.withHandler((flags) => listTabs(flags)),
);

const tabCreateCommand = Command.make("create", {
  ...targetFlags,
  url: Argument.string("url").pipe(
    Argument.withDescription("Optional initial URL."),
    Argument.optional,
  ),
  background: Flag.boolean("background").pipe(
    Flag.withDescription("Do not reveal the inline preview to the human."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Create a new tab, leaving existing tabs untouched."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "open", () => ({
      ...(Option.isSome(flags.url) ? { url: flags.url.value } : {}),
      open: !flags.background,
      reuseExistingTab: false,
    })),
  ),
);

const tabSwitchCommand = Command.make("switch", targetFlags).pipe(
  Command.withDescription("Bring an existing tab to the front. Requires --tab."),
  Command.withHandler((flags) =>
    Option.isNone(flags.tab)
      ? Effect.fail(browserCommandError("Provide --tab <id>. `t3 browser tab list` shows them."))
      : invokeAutomation(flags, "open", () => ({ open: true })),
  ),
);

const tabCloseCommand = Command.make("close", targetFlags).pipe(
  Command.withDescription("Close a tab, or every tab of the thread when --tab is omitted."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* resolveThreadId(flags);
      return yield* withLiveServer(flags, ({ origin, token }) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
          const response = yield* client.preview.closeTab({
            headers: { authorization: `Bearer ${token}` },
            payload: {
              ...(threadId === undefined ? {} : { threadId }),
              ...(Option.isSome(flags.tab) ? { tabId: flags.tab.value } : {}),
            },
          });
          yield* printJson(response);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.catch(reportFailure)),
      );
    }),
  ),
);

const tabCommand = Command.make("tab").pipe(
  Command.withDescription("Manage collaborative browser tabs."),
  Command.withSubcommands([tabListCommand, tabCreateCommand, tabSwitchCommand, tabCloseCommand]),
);

const openCommand = Command.make("open", {
  ...targetFlags,
  url: Argument.string("url").pipe(
    Argument.withDescription("Optional initial URL."),
    Argument.optional,
  ),
  background: Flag.boolean("background").pipe(
    Flag.withDescription("Do not reveal the inline preview to the human; automate silently."),
    Flag.withDefault(false),
  ),
  newTab: Flag.boolean("new-tab").pipe(
    Flag.withDescription("Always create a new tab instead of reusing the current one."),
    Flag.withDefault(false),
  ),
  noObserve: noObserveFlag,
}).pipe(
  Command.withDescription("Open or reuse a collaborative browser tab."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "open", () => ({
      ...(Option.isSome(flags.url) ? { url: flags.url.value } : {}),
      open: !flags.background,
      ...(flags.newTab ? { reuseExistingTab: false } : {}),
    })),
  ),
);

const navigateCommand = Command.make("navigate", {
  ...targetFlags,
  url: Argument.string("url").pipe(
    Argument.withDescription("Website URL, e.g. https://t3.chat or localhost:5173."),
    Argument.optional,
  ),
  port: Flag.integer("port").pipe(
    Flag.withDescription("Dev-server port inside this environment (instead of a URL)."),
    Flag.optional,
  ),
  protocol: Flag.choice("protocol", ["http", "https"] as const).pipe(
    Flag.withDescription("Protocol for --port. Defaults to http."),
    Flag.optional,
  ),
  path: Flag.string("path").pipe(
    Flag.withDescription("Path, query, and fragment for --port, e.g. /settings?tab=account."),
    Flag.optional,
  ),
  noObserve: noObserveFlag,
  readiness: Flag.choice("readiness", ["load", "domContentLoaded", "none"] as const).pipe(
    Flag.withDescription("Readiness milestone before returning. Defaults to load."),
    Flag.optional,
  ),
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription("Navigate a tab to a URL or an environment dev-server port."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "navigate", () => ({
      ...buildNavigateTarget({
        url: orUndefined(flags.url),
        port: orUndefined(flags.port),
        protocol: orUndefined(flags.protocol),
        path: orUndefined(flags.path),
      }),
      ...(Option.isSome(flags.readiness) ? { readiness: flags.readiness.value } : {}),
      ...(Option.isSome(flags.timeout) ? { timeoutMs: flags.timeout.value } : {}),
    })),
  ),
);

const resizeCommand = Command.make("resize", {
  ...targetFlags,
  size: Flag.string("size").pipe(
    Flag.withDescription("Freeform viewport as WIDTHxHEIGHT, e.g. 1024x768."),
    Flag.optional,
  ),
  preset: Flag.string("preset").pipe(
    Flag.withDescription("Named device preset, e.g. iphone-12-pro."),
    Flag.optional,
  ),
  orientation: Flag.choice("orientation", ["portrait", "landscape"] as const).pipe(
    Flag.withDescription("Orientation for --preset."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Resize the viewport. With no flags, follow the preview panel."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "resize", () =>
      buildResizeInput({
        size: orUndefined(flags.size),
        preset: orUndefined(flags.preset),
        orientation: orUndefined(flags.orientation),
      }),
    ),
  ),
);

const appearanceCommand = Command.make("appearance", {
  ...targetFlags,
  colorScheme: Argument.string("scheme").pipe(Argument.withDescription("system, light, or dark.")),
}).pipe(
  Command.withDescription("Emulate prefers-color-scheme in the page."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "setColorScheme", () => buildAppearanceInput(flags.colorScheme)),
  ),
);

const snapshotCommand = Command.make("snapshot", {
  ...targetFlags,
  screenshot: Flag.string("screenshot").pipe(
    Flag.withDescription("Write the PNG screenshot to this path and report it in the output."),
    Flag.optional,
  ),
  includeScreenshotData: Flag.boolean("include-screenshot-data").pipe(
    Flag.withDescription("Include the base64 PNG inline. Off by default; it is very large."),
    Flag.withDefault(false),
  ),
  includeAccessibilityTree: Flag.boolean("include-accessibility-tree").pipe(
    Flag.withDescription("Include the full accessibility tree. Off by default; it is very large."),
    Flag.withDefault(false),
  ),
  full: Flag.boolean("full").pipe(
    Flag.withDescription("Skip text and element budgets and return the whole snapshot."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Inspect the page: text, interactive elements, console, network, and a screenshot.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const screenshotPath = Option.isSome(flags.screenshot)
        ? path.resolve(yield* expandHomePath(flags.screenshot.value))
        : undefined;
      return yield* invokeAutomation(
        flags,
        "snapshot",
        () => ({}),
        (result) =>
          Effect.gen(function* () {
            const projection = projectSnapshotForCli(result, {
              screenshotPath,
              includeScreenshotData: flags.includeScreenshotData,
              includeAccessibilityTree: flags.includeAccessibilityTree,
              full: flags.full,
            });
            if (projection.screenshotBase64 !== null && screenshotPath !== undefined) {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(path.dirname(screenshotPath), { recursive: true });
              yield* fs.writeFile(
                screenshotPath,
                Buffer.from(projection.screenshotBase64, "base64"),
              );
            }
            yield* printJson(projection.json);
          }).pipe(Effect.orDie),
      );
    }),
  ),
);

const clickCommand = Command.make("click", {
  ...targetFlags,
  element: elementFlag,
  locator: locatorFlag,
  selector: selectorFlag,
  noObserve: noObserveFlag,
  x: Flag.float("x").pipe(
    Flag.withDescription("Viewport-relative X in CSS pixels. Pair with --y."),
    Flag.optional,
  ),
  y: Flag.float("y").pipe(
    Flag.withDescription("Viewport-relative Y in CSS pixels. Pair with --x."),
    Flag.optional,
  ),
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription("Click one target."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "click", () =>
      buildClickInput({
        locator: orUndefined(flags.element) ?? orUndefined(flags.locator),
        selector: orUndefined(flags.selector),
        x: orUndefined(flags.x),
        y: orUndefined(flags.y),
        timeoutMs: orUndefined(flags.timeout),
      }),
    ),
  ),
);

const typeCommand = Command.make("type", {
  ...targetFlags,
  text: Argument.string("text").pipe(Argument.withDescription("Literal text to insert.")),
  element: elementFlag,
  locator: locatorFlag,
  selector: selectorFlag,
  noObserve: noObserveFlag,
  clear: Flag.boolean("clear").pipe(
    Flag.withDescription("Clear the existing value before typing."),
    Flag.withDefault(false),
  ),
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription("Type into an input, or into the focused element when no target given."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "type", () => ({
      text: flags.text,
      ...buildTargetedInput({
        locator: orUndefined(flags.element) ?? orUndefined(flags.locator),
        selector: orUndefined(flags.selector),
      }),
      ...(flags.clear ? { clear: true } : {}),
      ...(Option.isSome(flags.timeout) ? { timeoutMs: flags.timeout.value } : {}),
    })),
  ),
);

const pressCommand = Command.make("press", {
  ...targetFlags,
  key: Argument.string("key").pipe(
    Argument.withDescription("Key name, e.g. Enter, Escape, ArrowDown, or a single character."),
  ),
  modifiers: Flag.string("modifiers").pipe(
    Flag.withDescription("Comma-separated modifiers held during the press, e.g. Meta,Shift."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Press one keyboard key."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "press", () => {
      const modifiers = parseModifiers(orUndefined(flags.modifiers));
      return { key: flags.key, ...(modifiers === undefined ? {} : { modifiers }) };
    }),
  ),
);

const scrollCommand = Command.make("scroll", {
  ...targetFlags,
  dx: Flag.float("dx").pipe(
    Flag.withDescription("Horizontal delta in CSS pixels. Positive scrolls right."),
    Flag.optional,
  ),
  dy: Flag.float("dy").pipe(
    Flag.withDescription("Vertical delta in CSS pixels. Positive scrolls down."),
    Flag.optional,
  ),
  element: elementFlag,
  locator: locatorFlag,
  selector: selectorFlag,
  noObserve: noObserveFlag,
}).pipe(
  Command.withDescription("Scroll the viewport, or a container matched by ref/locator/selector."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "scroll", () =>
      buildScrollInput({
        deltaX: orUndefined(flags.dx),
        deltaY: orUndefined(flags.dy),
        locator: orUndefined(flags.element) ?? orUndefined(flags.locator),
        selector: orUndefined(flags.selector),
      }),
    ),
  ),
);

const evalCommand = Command.make("eval", {
  ...targetFlags,
  expression: Argument.string("expression").pipe(
    Argument.withDescription("JavaScript evaluated in the page's main frame."),
  ),
  noAwait: Flag.boolean("no-await").pipe(
    Flag.withDescription("Do not await a returned Promise."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Evaluate JavaScript in the page and print the serialized result."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "evaluate", () => ({
      expression: flags.expression,
      ...(flags.noAwait ? { awaitPromise: false } : {}),
    })),
  ),
);

const extractCommand = Command.make("extract", {
  ...targetFlags,
  selector: Argument.string("selector").pipe(
    Argument.withDescription('CSS selector for the rows to read, e.g. "table tbody tr".'),
  ),
  offset: Flag.integer("offset").pipe(
    Flag.withDescription("Skip this many matches. Pass the previous result's nextOffset."),
    Flag.withDefault(0),
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDescription(`Rows per call (max ${MAX_EXTRACT_LIMIT}).`),
    Flag.withDefault(DEFAULT_EXTRACT_LIMIT),
  ),
  cells: Flag.string("cells").pipe(
    Flag.withDescription("Sub-selector for each row's cells. Defaults to td,th."),
    Flag.optional,
  ),
  attributes: Flag.boolean("attributes").pipe(
    Flag.withDescription("Also read href and value from each row."),
    Flag.withDefault(false),
  ),
  fields: Flag.string("fields").pipe(
    Flag.withDescription(
      'Named sub-selectors for card layouts with no rows, e.g. "name:h3,status:.badge".',
    ),
    Flag.optional,
  ),
  scroll: Flag.boolean("scroll").pipe(
    Flag.withDescription(
      "Scroll and accumulate rows. Only for virtualized lists, where rows do not exist in the DOM until rendered.",
    ),
    Flag.withDefault(false),
  ),
  scrollContainer: Flag.string("scroll-container").pipe(
    Flag.withDescription(
      "Element to scroll with --scroll. Defaults to the nearest scrollable ancestor of the first row.",
    ),
    Flag.optional,
  ),
  maxScrolls: Flag.integer("max-scrolls").pipe(
    Flag.withDescription(`Scroll passes before giving up (max ${MAX_SCROLLS_CEILING}).`),
    Flag.withDefault(DEFAULT_MAX_SCROLLS),
  ),
}).pipe(
  Command.withDescription(
    "Read structured rows from the page in one call. Queries the DOM directly, so it sees every match regardless of scroll position.",
  ),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "evaluate", () => ({
      expression: buildExtractExpression({
        selector: flags.selector,
        offset: flags.offset,
        limit: flags.limit,
        cellSelector: Option.getOrUndefined(flags.cells),
        attributes: flags.attributes,
        scroll: flags.scroll,
        maxScrolls: flags.maxScrolls,
        ...(Option.isSome(flags.scrollContainer)
          ? { scrollContainer: flags.scrollContainer.value }
          : {}),
        ...(Option.isSome(flags.fields) ? { fields: parseFieldSpec(flags.fields.value) } : {}),
      }),
    })),
  ),
);

const waitCommand = Command.make("wait", {
  ...targetFlags,
  element: elementFlag,
  locator: locatorFlag,
  selector: selectorFlag,
  text: Flag.string("text").pipe(
    Flag.withDescription("Case-sensitive substring that must appear in visible text."),
    Flag.optional,
  ),
  urlIncludes: Flag.string("url-includes").pipe(
    Flag.withDescription("Substring that must appear in the current URL."),
    Flag.optional,
  ),
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription("Wait until every supplied condition matches."),
  Command.withHandler((flags) =>
    invokeAutomation(flags, "waitFor", () =>
      buildWaitInput({
        locator: orUndefined(flags.element) ?? orUndefined(flags.locator),
        selector: orUndefined(flags.selector),
        text: orUndefined(flags.text),
        urlIncludes: orUndefined(flags.urlIncludes),
        timeoutMs: orUndefined(flags.timeout),
      }),
    ),
  ),
);

const recordStartCommand = Command.make("start", targetFlags).pipe(
  Command.withDescription("Start recording the tab."),
  Command.withHandler((flags) => invokeAutomation(flags, "recordingStart", () => ({}))),
);

const recordStopCommand = Command.make("stop", targetFlags).pipe(
  Command.withDescription("Stop recording and save the video as a local evidence artifact."),
  Command.withHandler((flags) => invokeAutomation(flags, "recordingStop", () => ({}))),
);

const recordCommand = Command.make("record").pipe(
  Command.withDescription("Record the tab."),
  Command.withSubcommands([recordStartCommand, recordStopCommand]),
);

export const browserCommand = Command.make("browser").pipe(
  Command.withDescription("Drive the collaborative browser in a running T3 Code app."),
  Command.withSubcommands([
    statusCommand,
    tabsCommand,
    tabCommand,
    openCommand,
    navigateCommand,
    resizeCommand,
    appearanceCommand,
    snapshotCommand,
    clickCommand,
    typeCommand,
    pressCommand,
    scrollCommand,
    evalCommand,
    extractCommand,
    waitCommand,
    recordCommand,
  ]),
);
