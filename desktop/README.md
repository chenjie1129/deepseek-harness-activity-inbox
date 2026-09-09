# Activity Pet Desktop

The D3 desktop client is a Tauri 2 application that renders the shared
Activity Presence projection outside the Harness browser window.

## Runtime boundary

- Rust reads the bearer token from macOS Keychain.
- Rust connects to `$DSH_HOME/activity-inbox/presence-v1.sock`.
- The WebView receives validated snapshots through Tauri events.
- The bearer token is never sent to JavaScript.
- `DSH_WEB_URL` is accepted only for loopback HTTP URLs.

Optional environment overrides:

```text
DSH_HOME
DSH_PRESENCE_SOCKET
DSH_PRESENCE_KEYCHAIN_SERVICE
DSH_PRESENCE_KEYCHAIN_ACCOUNT
DSH_WEB_URL
```

## Interaction

- Drag handle: move freely; after movement settles within 48 pixels of a
  display edge, snap to that edge.
- Pet click: expand or collapse evidence.
- Pet double-click: open the configured Harness URL.
- Toolbar: toggle always-on-top, motion, or click-through.
- Menu bar icon: restore or recenter the window, or disable click-through when
  the window itself cannot receive pointer input.
- Closing the window hides it; Quit in the menu bar terminates the app.

Window position and presentation settings are stored locally. They never alter
Host activity facts.

## Host-managed lifecycle

The Activity Inbox Host can discover this release bundle and expose Start/Stop
controls in the Harness sidebar. It passes the Presence endpoint and Keychain
descriptor through the child environment; the browser cannot choose a binary,
arguments, environment variables, or process ID. Automatic startup remains
opt-in.

Transparent macOS windows require Tauri's `macOSPrivateApi`; this build is
intended for direct signed distribution and is not eligible for the Mac App
Store.

## Development

```bash
npm install
npm run check
npm run tauri -- build --debug --no-bundle
```
