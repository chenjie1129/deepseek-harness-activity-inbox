# Architecture

## Product boundary

Activity Inbox is a read-and-triage layer over existing Harness authority. It does not control an agent, answer an approval, mutate session history, or generate a summary.

```text
durable session logs ──backfill──┐
live session/event ──────────────┼─> Host activity + Presence index ─> Host Remote
approval/request lifecycle ──────┤                │
operator actions ────────────────> preference file│
                                                  └─> authenticated Unix socket
```

## Host half

The Host plugin subscribes to canonical `session/event` publications before it starts a cold-history scan. It also folds constructor-seeded live sessions because seed events are not re-published. A sequence watermark per session prevents an older asynchronous backfill from overwriting a newer live observation.

The event classifier is intentionally closed:

| `turn/end` reason | Inbox treatment |
|---|---|
| `completed` | Completed |
| `blocked` | Needs action |
| `error`, `max-tokens`, `interrupted` | Failed |
| `aborted` | omitted; cancellation is not a failure |
| unknown plugin extension | omitted until explicitly classified |

Only the latest terminal activity per session is kept. A subsequent `turn/start` clears the prior terminal row while work is in progress. The same Host store tracks running turns, unresolved `ask_user_question` calls, and approval waits. Historical backfill never creates transient running or waiting state.

Historical facts are rebuilt from the configured `sessionPersistence` provider. They are not copied into a second plugin database. The plugin-owned JSON file contains only follow/review/snooze/archive preferences and a monotonic revision.

## Browser half

The client mounts in the additive root-scoped `sidebar.footer.action` list slot. It combines:

- Host terminal facts, durable preferences, and the authoritative Presence projection from the `activityInbox` Typert Remote namespace on Harness `0.1.2-alpha.1`, with `/activity-inbox` Connection RPC retained for `0.1.1-rc.2`;
- session titles, current selection, and parent navigation from the standard `useSessions` feed.

It refreshes on connection reset, browser focus/visibility, panel open, a five-second interval, and relevant live session status edges. Browser state triggers refreshes but does not independently classify Presence.

The Remote contract is registered at runtime with strict mutation and snapshot validators. It does not import or bundle an unpublished alpha Harness package, so the packed plugin remains standalone and the Host remains the authority for persisted state.

The browser-safe `./presence` export contains the shared Pet projector and the
versioned auth/subscribe/snapshot/unchanged protocol. The Node-only
`./presence/host` export binds it to an NDJSON Unix domain socket. On macOS the
Host stores a random bearer token in Keychain, locks the containing directory
to `0700`, locks the socket to `0600`, and requires authentication before
subscription. Presence revisions are pushed from the Store rather than polled.
The stable endpoint points to a random per-instance socket in the same private
directory. Startup refuses to replace an active listener, while shutdown
removes the stable path only if it still targets the current Host.

## Desktop half

The `desktop/` package is an independently buildable Tauri 2 application.
Its Rust process reads Keychain credentials, owns the Unix socket connection,
validates bounded protocol messages, preserves the reconnect cursor, and emits
only validated Presence snapshots to the WebView. JavaScript never receives
the bearer token.

The React surface applies the same shared Pet projection as the sidebar. The
native window is transparent, undecorated, always-on-top by default, and
restores its position. Window movement snaps only within the configured edge
proximity. Click-through, visibility, and recentering remain recoverable from
the menu bar so the Pet cannot permanently lock the user out of its controls.

The Host also owns an optional desktop lifecycle controller. It discovers only
configured or known local Activity Pet builds, launches them with the exact
Presence endpoint and Keychain descriptor, tracks the child process, and
publishes a bounded lifecycle state through the existing Activity Inbox RPC.
Browser requests select only `start`, `stop`, or `restart`; they cannot supply
an executable, arguments, environment variables, or arbitrary process IDs.
Automatic launch is opt-in, and orderly Host disposal stops only the process
that Host instance created.

## Re-arm semantics

Review and archive watermarks are event sequences. Snooze carries the sequence it suppressed. If a later terminal event has a larger sequence, the item becomes visible again automatically. Stale actions must match the current terminal sequence or the Host rejects them.

## Navigation and evidence

The terminal event sequence is shown as evidence. The Open action uses the existing session runtime. A known subagent address opens the child; a hidden child falls back to its recorded parent. Harness does not currently expose a stable event-level navigation anchor, so v0.1 does not claim event deep links.
