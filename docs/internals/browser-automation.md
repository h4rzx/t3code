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

### Refs are ours, not Playwright's

The snapshot carries server-assigned refs (`@e1`) resolved through selectors, while the
aria tree is rendered in `autoexpect` mode specifically so it emits none of its own —
two ref schemes in one payload would be worse than none. Playwright's `aria-ref=` engine
is more robust than selector round-tripping, and unifying on it would remove the
`refRegistry` entirely, but it is a larger change to ref resolution and staleness than it
looks.

### `extract --scroll` cannot see what the list never renders

The scroll fallback finds rows a virtualized list materialises as it goes, and reports
`complete: false` when the cap is reached with rows still arriving. It still cannot see a
list that paginates on the server, and it deduplicates by row content, so two genuinely
identical rows collapse into one. For an API-backed dashboard, in-page `fetch('/api/...')`
through `eval` remains cheaper and exact.

### Cookie import

- Values Chromium's parser refuses are counted as `rejected` and dropped (~0.3% of a real
  profile). Recovering them means either altering the value, which breaks it for the site,
  or writing the encrypted store directly and swapping it in at cold start.
- Safari needs Full Disk Access; without it the read fails with `EPERM`. Untested end to
  end.
- Windows (DPAPI) and Linux v11 (login keyring) are unimplemented; Linux v10 works.

### Test coverage

The pure layers are well covered, and the cookie read seam now has a real SQLite fixture —
`CookieImportService.test.ts` reproduces the `expires_utc` overflow that broke every
Chromium import while the suite stayed green.

Nothing exercises a real page or a real automation round trip. The snapshot path, ref
resolution, and the scroll fallback are all verified by hand against live sites, which
means a regression in any of them reaches a user before it reaches CI. The blocker is a
host: automation needs a connected client, and there is no headless one.

Note for anyone who reads an older version of this file: `it.effect` does work in this
repo. It fails only when `it` is imported from `vite-plus/test` instead of
`@effect/vitest`.
