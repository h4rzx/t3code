# Browser automation

The collaborative browser can be driven from two entry points that share one implementation:

- **MCP tools** (`preview_status`, `preview_open`, `preview_click`, …) for agents running in a
  thread with an MCP credential. Defined in `apps/server/src/mcp/toolkits/preview/`.
- **`t3 browser` CLI** for anything without a provider session — a shell, a script, or an agent
  whose harness has no MCP. Defined in `apps/server/src/cli/browser.ts`.

Both funnel into `PreviewAutomationBroker.invoke`, which routes an operation to a connected
client (desktop Electron runtime, or the web app hosting a webview) and awaits its response. A
tab opened by the CLI is the same collaborative tab a human sees.

## Request path

```
t3 browser <cmd>
  → POST /api/preview/automation      (EnvironmentPreviewHttpApi, bearer session token)
    → decodePreviewAutomationInvocation   (validates against the MCP tool's input schema)
      → PreviewAutomationBroker.invoke
        → WS previewAutomation stream → client host → response
```

`apps/server/src/preview/http.ts` implements the group; `apps/server/src/preview/
automationRequest.ts` holds the pieces that must stay identical between MCP and HTTP.

### Why the payload is untyped on the wire

`EnvironmentPreviewAutomationRequest.input` is `Schema.Unknown`, decoded server-side against the
schema for `operation`. That keeps one operation registry: adding an MCP tool input field makes
it available over HTTP with no contract change, and the CLI cannot accept something the MCP tool
would reject.

## Scope and thread binding

The broker keys everything on an `McpInvocationScope`. CLI callers have no provider session, so
`makeCliPreviewScope` synthesizes one:

- `threadId` defaults to `t3-cli-browser`. Preview sessions are keyed by `(threadId, tabId)` and
  the id is only a key — nothing requires a real chat thread. `--thread` targets a real one when
  you want the tab an agent opened.
- `providerSessionId` is derived from the thread id and is therefore stable across invocations.
  The broker leases one desktop runtime per `(environmentId, providerSessionId)`, so a multi-step
  CLI flow keeps the same cookies and DOM state instead of hopping between windows.

## Auth

The CLI reads the running server's origin from persisted runtime state, mints a short-lived
administrative session through `EnvironmentAuth`, and revokes it when the command finishes. The
automation route requires `orchestration:operate`; listing tabs requires `orchestration:read`.

## Failure shape

Broker errors are mapped to `EnvironmentPreviewAutomationError` (HTTP 502) carrying the
originating `PreviewAutomation*Error` tag in `reason`, so callers can branch on the cause without
the HTTP contract re-declaring every broker error. The common one in practice is
`PreviewAutomationNoAvailableHostError`: the server is up but no client is connected to host a
webview.

## Known gaps

Kept here rather than in a tracker because each one is a trap for the next person reading
this code, and several look fixed from the outside.

### Typed errors flatten to `execution_failed`

The desktop raises specific errors (`PreviewAutomationInvalidSelectorError` and friends), but
callers see `preview_execution_failed`. Verified from traces: the desktop side is correct and
the server's `classifyResponseError` receives a tag it does not recognise.

`previewAutomationErrors.ts` maps desktop tags to host errors in `fromCause`, and only
`PreviewAutomationTargetNotEditableError` was ever mapped. It is not yet established whether
that mapping fires either — if it does not, _every_ typed error has been flattening, and the
fix belongs at the IPC boundary rather than in per-tag mappings. Settle it by logging the
shape of `cause` inside `fromCause` before adding more cases.

### Snapshots cannot capture a hidden preview

`capturePage()` never settles when the webview has not painted, and `Page.captureScreenshot`
does not help — Chromium still needs the renderer to produce a frame. Snapshots therefore
return `screenshot: null` whenever the preview panel is closed, which is exactly the
background-automation case. `Emulation.setDeviceMetricsOverride` or `Page.startScreencast`
can force frame production; neither is implemented.

### `extract` only sees the DOM

Virtualized lists (react-window and similar) do not have their rows in the DOM until
rendered, so `extract` reports only what happens to be materialised. There is no
scroll-until-stable fallback, and no dedup by row key to make one safe.

For API-backed dashboards, in-page `fetch('/api/...')` through `eval` is cheaper and more
reliable than any DOM read. It is documented in the skill but is not a first-class command.

### Snapshot shape is text, not structure

`visibleText` plus a flat element list needs ~20k characters to convey what an accessibility
tree conveys in a fraction of that, and it discards the structure that would tell a caller a
table is a table. Playwright's aria snapshot is the better shape; switching is a contract
change touching both the web UI and MCP.

### Cookie import

- Values with bytes above 0x7F are rejected by `session.cookies.set()` and counted as skips
  (~0.3% of a real profile). Writing the partition's SQLite directly and swapping it in at
  cold start is the known fix.
- Safari needs Full Disk Access; without it the read fails with `EPERM`. Untested end to end.
- Windows (DPAPI) and Linux v11 (login keyring) are unimplemented; Linux v10 works.

### Dev loop

Killing the Electron parent does not reap its server child, leaving an orphan holding the
server port. The next launch cannot bind, and the app fails to boot with a
`PrimaryEnvironmentRequestError` from `fetch-session-state` that looks like an auth bug.
`dev-electron.mjs` should terminate the child on parent exit.

### Test coverage

The pure layers are well covered; the seams are not. Cookie decryption, extraction shaping,
and browser detection have unit tests, but nothing exercises a real profile, a real page, or
a real automation round trip. The `expires_utc` overflow broke every Chromium import and the
suite stayed green throughout, because it lived in the one layer with no test.

`CookieImportService.ts` has no tests at all: `it.effect` does not run in this repo
("Vitest failed to find the current suite"), which rules out testing Effect services.
