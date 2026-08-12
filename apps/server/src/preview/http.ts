import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentPreviewAutomationError,
  type EnvironmentPreviewFailureCode,
  type EnvironmentPreviewObservation,
  type PreviewAutomationError,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import {
  CLI_BROWSER_THREAD_ID,
  decodePreviewAutomationInvocation,
  isMutatingPreviewOperation,
  makeCliPreviewScope,
  resolvePreviewRefs,
} from "./automationRequest.ts";
import { PreviewManager } from "./Manager.ts";
import { assignPreviewRefs, PreviewRefRegistry, previewTabKey } from "./refRegistry.ts";
import { looksSignedOut } from "./signedOut.ts";

/**
 * Every failure an agent can hit, paired with the command that usually clears
 * it. Prose changes freely; `failure` and `recovery` are the contract.
 */
const failureFromBrokerError = (
  error: PreviewAutomationError,
): { readonly failure: EnvironmentPreviewFailureCode; readonly recovery: string } => {
  switch (error._tag) {
    case "PreviewAutomationNoAvailableHostError":
      return {
        failure: "preview_no_host",
        recovery:
          "Open the T3 Code desktop app so a browser host is connected, then retry. `t3 browser status` confirms it.",
      };
    case "PreviewAutomationTabNotFoundError":
      return {
        failure: "preview_tab_not_found",
        recovery:
          "Run `t3 browser tabs` to list live tabs, or `t3 browser open <url>` to create one.",
      };
    case "PreviewAutomationTimeoutError":
      return {
        failure: "preview_timeout",
        recovery:
          "Retry with a larger --timeout, or `t3 browser wait --text <text>` for the state you expect first.",
      };
    case "PreviewAutomationInvalidSelectorError":
      return {
        failure: "preview_invalid_selector",
        recovery:
          "Run `t3 browser snapshot` and act on a ref from interactiveElements (for example --locator @e3).",
      };
    case "PreviewAutomationTargetNotEditableError":
      return {
        failure: "preview_target_not_editable",
        recovery:
          "Run `t3 browser snapshot` and pick an input element's ref, or click the field before typing.",
      };
    case "PreviewAutomationResultTooLargeError":
      return {
        failure: "preview_result_too_large",
        recovery: "Return less from the expression, for example a field instead of a whole object.",
      };
    case "PreviewAutomationUnsupportedClientError":
      return {
        failure: "preview_unsupported_operation",
        recovery: "Update the T3 Code desktop app; this host is too old for that operation.",
      };
    case "PreviewAutomationClientDisconnectedError":
    case "PreviewAutomationRequestQueueClosedError":
    case "PreviewAutomationRemoteUnavailableError":
      return {
        failure: "preview_host_disconnected",
        recovery:
          "The browser host went away mid-operation. Check `t3 browser status`, then retry.",
      };
    default:
      return {
        failure: "preview_execution_failed",
        // Operation-neutral on purpose: this branch also catches a failing
        // snapshot, and telling the caller to run the command that just failed
        // sends it into a loop.
        recovery:
          "The page rejected the operation. Check `t3 browser status`, confirm the tab is on the page you expect, then retry.",
      };
  }
};

const failPreview = (input: {
  readonly failure: EnvironmentPreviewFailureCode;
  readonly reason: string;
  readonly detail: string;
  readonly recovery: string;
}) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentPreviewAutomationError({
          code: "preview_automation_failed",
          failure: input.failure,
          reason: input.reason,
          detail: input.detail,
          recovery: input.recovery,
          traceId,
        }),
      ),
    ),
  );

const failFromBroker = (error: PreviewAutomationError) =>
  failPreview({ ...failureFromBrokerError(error), reason: error._tag, detail: error.message });

const readTabId = (result: unknown): PreviewTabId | null => {
  if (typeof result !== "object" || result === null || !("tabId" in result)) return null;
  const tabId = (result as { readonly tabId?: unknown }).tabId;
  return typeof tabId === "string" ? (tabId as PreviewTabId) : null;
};

/**
 * HTTP twin of the MCP preview toolkit, for callers without a provider session.
 * Both routes run against the same broker and preview manager the collaborative
 * browser already uses, so a `t3 browser` command and an in-thread agent tool
 * call are indistinguishable to the host.
 */
export const previewHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "preview",
  Effect.fnUntraced(function* (handlers) {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const previewManager = yield* PreviewManager;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const refRegistry = yield* PreviewRefRegistry;

    return handlers
      .handle(
        "automation",
        Effect.fn("environment.preview.automation")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const environmentId = yield* serverEnvironment.getEnvironmentId;
          const threadId = args.payload.threadId ?? CLI_BROWSER_THREAD_ID;
          const operation = args.payload.operation;
          const invocation = yield* decodePreviewAutomationInvocation(
            operation,
            args.payload.input,
          ).pipe(Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")));
          const tabId = args.payload.tabId ?? invocation.tabId;
          const key = previewTabKey(threadId, tabId);
          const memory = yield* refRegistry.read(key);
          const resolved = resolvePreviewRefs(invocation.input, memory.refs);
          if (resolved.staleRef !== undefined) {
            return yield* failPreview({
              failure: "preview_stale_ref",
              reason: "PreviewRefNotFound",
              detail: `Ref ${resolved.staleRef} is not from the latest snapshot of this tab.`,
              recovery: "Run `t3 browser snapshot` and retry with a ref from that result.",
            });
          }
          const issuedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          const scope = makeCliPreviewScope({ environmentId, threadId, issuedAt });
          const invoke = <A>(
            operationName: typeof operation,
            input: Record<string, unknown>,
            timeoutMs?: number,
          ) =>
            broker.invoke<A>({
              scope,
              operation: operationName,
              input,
              ...(tabId === undefined ? {} : { tabId }),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            });

          const result = yield* invoke<unknown>(
            operation,
            resolved.input,
            invocation.timeoutMs,
          ).pipe(Effect.catch(failFromBroker));

          if (operation === "snapshot") {
            const snapshot = result as PreviewAutomationSnapshot;
            const elements = assignPreviewRefs(snapshot.interactiveElements ?? []);
            yield* refRegistry.recordSnapshot(key, {
              elements,
              url: snapshot.url ?? null,
              title: snapshot.title ?? null,
            });
            return {
              threadId,
              tabId: tabId ?? null,
              result: { ...snapshot, interactiveElements: elements },
            };
          }

          const resultTabId = readTabId(result) ?? tabId ?? null;
          if (!isMutatingPreviewOperation(operation) || args.payload.observe === false) {
            return { threadId, tabId: resultTabId, result: result ?? null };
          }

          // One cheap status read beats the full snapshot an agent would
          // otherwise take after every action just to learn whether the page
          // moved. Never fail the operation over the follow-up read.
          const status = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (status === undefined) {
            return { threadId, tabId: resultTabId, result: result ?? null };
          }
          const urlChanged = memory.url !== null && status.url !== memory.url;
          const observed: EnvironmentPreviewObservation = {
            url: status.url,
            title: status.title,
            loading: status.loading,
            urlChanged,
            titleChanged: memory.title !== null && status.title !== memory.title,
            refsStale: memory.refs.size > 0 && (urlChanged || memory.refUrl !== status.url),
            // Only surfaced when true: an absent field reads as "fine", and a
            // `signedOut: false` on every response is noise the caller ignores.
            ...(looksSignedOut({ url: status.url, title: status.title })
              ? { signedOut: true }
              : {}),
          };
          yield* refRegistry.recordPageState(key, { url: status.url, title: status.title });
          return {
            threadId,
            tabId: status.tabId ?? resultTabId,
            result: result ?? null,
            observed,
          };
        }),
      )
      .handle(
        "closeTab",
        Effect.fn("environment.preview.closeTab")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const threadId = args.payload.threadId ?? CLI_BROWSER_THREAD_ID;
          yield* previewManager
            .close({
              threadId,
              ...(args.payload.tabId === undefined ? {} : { tabId: args.payload.tabId }),
            })
            .pipe(
              Effect.catch((cause) =>
                failPreview({
                  failure: "preview_tab_not_found",
                  reason: cause._tag,
                  detail: cause.message,
                  recovery: "Run `t3 browser tab list` to see which tabs exist.",
                }),
              ),
            );
          return { threadId, closed: true };
        }),
      )
      .handle(
        "tabs",
        Effect.fn("environment.preview.tabs")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const threadId = args.payload.threadId ?? CLI_BROWSER_THREAD_ID;
          const listed = yield* previewManager.list({ threadId });
          return { threadId, tabs: listed.sessions };
        }),
      );
  }),
);
