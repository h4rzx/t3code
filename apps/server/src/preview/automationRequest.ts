/**
 * Shared shaping for browser automation requests that arrive over plain HTTP
 * instead of MCP. The MCP toolkit gets its validation from tool parameter
 * schemas; this module applies the same schemas to an untyped HTTP payload so
 * both entry points accept exactly the same inputs.
 */
import {
  type EnvironmentId,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  type PreviewAutomationOperation,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  type PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { isPreviewRef } from "./refRegistry.ts";
import { normalizePreviewOpenInput } from "../mcp/toolkits/preview/handlers.ts";

/**
 * The thread every `t3 browser` command shares unless `--thread` names another
 * one. Preview sessions are keyed by `(threadId, tabId)` and the id is just a
 * key, so CLI tabs live beside agent tabs without colliding with a real thread.
 */
export const CLI_BROWSER_THREAD_ID = ThreadId.make("t3-cli-browser");

const CLI_BROWSER_PROVIDER_INSTANCE_ID = ProviderInstanceId.make("t3-cli-browser");

/**
 * One synthetic provider session per thread. The broker leases a desktop
 * runtime per `(environmentId, providerSessionId)`, so a stable id keeps every
 * CLI invocation on the same Electron runtime — and therefore the same cookies
 * and DOM state — instead of hopping between windows mid-flow.
 */
export const cliPreviewProviderSessionId = (threadId: ThreadId): string =>
  `t3-cli-browser:${threadId}`;

export const makeCliPreviewScope = (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly issuedAt: number;
}): McpInvocationContext.McpInvocationScope => ({
  environmentId: input.environmentId,
  threadId: input.threadId,
  providerSessionId: cliPreviewProviderSessionId(input.threadId),
  providerInstanceId: CLI_BROWSER_PROVIDER_INSTANCE_ID,
  capabilities: new Set(["preview" as const]),
  issuedAt: input.issuedAt,
});

const operationInputSchemas = {
  status: PreviewAutomationTabTargetInput,
  open: PreviewAutomationOpenInput,
  navigate: PreviewAutomationNavigateInput,
  snapshot: PreviewAutomationTabTargetInput,
  click: PreviewAutomationClickInput,
  type: PreviewAutomationTypeInput,
  press: PreviewAutomationPressInput,
  scroll: PreviewAutomationScrollInput,
  evaluate: PreviewAutomationEvaluateInput,
  waitFor: PreviewAutomationWaitForInput,
  recordingStart: PreviewAutomationTabTargetInput,
  recordingStop: PreviewAutomationTabTargetInput,
  resize: PreviewAutomationResizeInput,
  setColorScheme: PreviewAutomationSetColorSchemeInput,
} as const satisfies Record<PreviewAutomationOperation, Schema.Top>;

const decoders = Object.fromEntries(
  Object.entries(operationInputSchemas).map(([operation, schema]) => [
    operation,
    Schema.decodeUnknownEffect(schema as Schema.Top),
  ]),
) as Record<
  PreviewAutomationOperation,
  (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
>;

export interface PreviewAutomationInvocation {
  /** Operation payload with routing fields removed, as the broker expects. */
  readonly input: Record<string, unknown>;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

/**
 * Decode an untyped payload for `operation` and split it into the parts the
 * broker routes on (`tabId`, `timeoutMs`) and the parts the host executes.
 */
export const decodePreviewAutomationInvocation = Effect.fn("preview.decodeAutomationInvocation")(
  function* (operation: PreviewAutomationOperation, rawInput: unknown) {
    const decoded = yield* decoders[operation](rawInput ?? {});
    const normalized =
      operation === "open"
        ? normalizePreviewOpenInput(decoded as PreviewAutomationOpenInput)
        : (decoded as Record<string, unknown>);
    const { tabId, ...operationInput } = normalized as Record<string, unknown> & {
      readonly tabId?: PreviewTabId;
      readonly timeoutMs?: number;
    };
    return {
      input: operationInput,
      ...(tabId === undefined ? {} : { tabId }),
      ...(typeof operationInput.timeoutMs === "number"
        ? { timeoutMs: operationInput.timeoutMs }
        : {}),
    } satisfies PreviewAutomationInvocation;
  },
);

/** Operations that can change the page, and therefore deserve an observation. */
const MUTATING_OPERATIONS = new Set<PreviewAutomationOperation>([
  "open",
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "setColorScheme",
]);

export const isMutatingPreviewOperation = (operation: PreviewAutomationOperation): boolean =>
  MUTATING_OPERATIONS.has(operation);

export interface PreviewRefResolution {
  readonly input: Record<string, unknown>;
  /** A ref the caller used that no longer resolves, if any. */
  readonly staleRef?: string;
}

/**
 * Swap `@e3`-style refs for the selector the last snapshot recorded. Anything
 * that is not a ref passes through untouched, so locators and CSS selectors
 * keep working.
 */
export function resolvePreviewRefs(
  input: Record<string, unknown>,
  refs: ReadonlyMap<string, string>,
): PreviewRefResolution {
  const resolveField = (value: unknown): string | undefined =>
    typeof value === "string" && isPreviewRef(value) ? value.trim() : undefined;
  for (const field of ["locator", "selector"] as const) {
    const ref = resolveField(input[field]);
    if (ref === undefined) continue;
    const selector = refs.get(ref);
    if (selector === undefined) return { input, staleRef: ref };
    const { locator: _locator, selector: _selector, ...rest } = input;
    return { input: { ...rest, selector } };
  }
  return { input };
}
