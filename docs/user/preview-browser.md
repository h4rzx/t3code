# The preview browser

Previews open in a browser that both you and your agent can drive. You watch the page while the
agent works, and either of you can take over — it is one browser, not a recording of one.

It keeps its own cookies, separate from Chrome or Safari. That is why a preview of a site you are
signed in to elsewhere often opens on a login screen: as far as that site is concerned, this is a
browser it has never seen.

## Importing your logins

**Settings → Browser** copies your signed-in sessions from a browser you already use, so previews
can open pages that need a login.

Open it from Settings, or search for "import browser cookies" in the command palette.

Pick a browser and profile, then choose **Import**. T3 Code asks you to confirm first, and names the
browser it is about to read. Your other browser is never modified.

Supported: Chrome, Edge, Brave, Arc, Comet, Helium, Safari, and Firefox. Only browsers actually
installed on this machine are offered.

Import is available in the desktop app, on macOS and Linux. It is deliberately something you do by
hand: agents cannot start an import, because copying a live login is your decision to make.

### What this means for agents

An agent that can drive the preview browser can act as you on any site whose cookies you import.
It can read your dashboards, and on sites where it can click, it can change things.

Import the browser whose logins you actually want available, and use **Clear data** when you are
done with them.

### Some cookies are skipped

The result line says how many cookies were imported and why the rest were not. This is normal — a
clean import still skips some:

- **Device-bound** cookies are tied to the browser that created them. They would not work here, and
  copying them can invalidate the session in your real browser.
- **Expired** cookies are already dead.
- **Rejected** cookies hold a value this browser will not accept. Rare, and the site usually still
  works without them.

If a site still asks you to sign in after an import, its session was probably device-bound. Sign in
once inside the preview browser and it will stay signed in.

### Safari needs permission

macOS keeps Safari's cookies behind Full Disk Access. When you import from Safari, T3 Code offers
to open the right settings pane — enable T3 Code there, then quit and reopen the app. macOS only
notices the change when the app starts.

Other browsers need no permission.

## Seeing what you have

Settings → Browser shows how many cookies the preview browser holds and how many sites they
belong to. If that number is lower than you expected, or the browser is empty, nothing was
imported yet.

## Clearing what you imported

**Settings → Browser → Clear data** removes every cookie and all site data from the preview browser,
including anything imported. Sites will ask you to sign in again.

Clearing affects the preview browser only. Your other browsers are untouched.
