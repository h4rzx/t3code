import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  CLI_BROWSER_THREAD_ID,
  cliPreviewProviderSessionId,
  decodePreviewAutomationInvocation,
  makeCliPreviewScope,
} from "./automationRequest.ts";

describe("decodePreviewAutomationInvocation", () => {
  it.effect("splits routing fields out of the operation payload", () =>
    Effect.gen(function* () {
      const invocation = yield* decodePreviewAutomationInvocation("click", {
        tabId: "tab-1",
        locator: "role=button[name='Send']",
        timeoutMs: 2000,
      });
      expect(invocation).toEqual({
        input: { locator: "role=button[name='Send']", timeoutMs: 2000 },
        tabId: "tab-1",
        timeoutMs: 2000,
      });
    }),
  );

  it.effect("applies open's defaults so HTTP and MCP callers behave identically", () =>
    Effect.gen(function* () {
      expect(yield* decodePreviewAutomationInvocation("open", { url: "t3.chat" })).toEqual({
        input: { url: "t3.chat", open: true, show: true, reuseExistingTab: true },
      });
    }),
  );

  it.effect("treats a missing payload as an empty one for tab-only operations", () =>
    Effect.gen(function* () {
      expect(yield* decodePreviewAutomationInvocation("snapshot", undefined)).toEqual({
        input: {},
      });
    }),
  );

  it.effect("rejects payloads the matching MCP tool would also reject", () =>
    Effect.gen(function* () {
      // navigate takes exactly one of url/target.
      const bothTargets = yield* Effect.result(
        decodePreviewAutomationInvocation("navigate", {
          url: "t3.chat",
          target: { kind: "url", url: "t3.chat" },
        }),
      );
      expect(bothTargets._tag).toBe("Failure");
      const missingKey = yield* Effect.result(decodePreviewAutomationInvocation("press", {}));
      expect(missingKey._tag).toBe("Failure");
      const evaluate = yield* Effect.result(
        decodePreviewAutomationInvocation("evaluate", { expression: "document.title" }),
      );
      expect(evaluate._tag).toBe("Success");
    }),
  );
});

describe("makeCliPreviewScope", () => {
  it("keeps every command for a thread on one host lease", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const scope = makeCliPreviewScope({
      environmentId,
      threadId: CLI_BROWSER_THREAD_ID,
      issuedAt: 1,
    });
    expect(scope.providerSessionId).toBe(cliPreviewProviderSessionId(CLI_BROWSER_THREAD_ID));
    expect(scope.capabilities.has("preview")).toBe(true);
    expect(
      makeCliPreviewScope({ environmentId, threadId: ThreadId.make("other"), issuedAt: 2 })
        .providerSessionId,
    ).not.toBe(scope.providerSessionId);
  });
});
