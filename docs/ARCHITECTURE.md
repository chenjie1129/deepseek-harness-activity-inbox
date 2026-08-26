# Architecture

## Product boundary

Activity Inbox is a read-and-triage layer over existing Harness authority. It does not control an agent, answer an approval, mutate session history, or generate a summary.

```text
durable session logs ──backfill──┐
live session/event ──────────────┼─> deterministic latest-outcome index ─> Host RPC
live browser waits ───────────────────────────────────────────────────────> UI merge
operator actions ────────────────> plugin preference file ───────────────> Host RPC
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

Only the latest terminal activity per session is kept. A subsequent `turn/start` clears the prior terminal row while work is in progress.

Historical facts are rebuilt from the configured `sessionPersistence` provider. They are not copied into a second plugin database. The plugin-owned JSON file contains only follow/review/snooze/archive preferences and a monotonic revision.

## Browser half

The client mounts in the additive root-scoped `sidebar.footer.action` list slot. It combines:

- Host terminal facts and durable preferences from `/activity-inbox` RPC;
- live `pendingInteraction` state from the standard `useSessions` feed;
- session titles, running state, and parent navigation from that same feed.

It refreshes on connection reset, browser focus/visibility, panel open, and a five-second interval. v0.1 intentionally uses this bounded pull model instead of adding another push protocol.

## Re-arm semantics

Review and archive watermarks are event sequences. Snooze carries the sequence it suppressed. If a later terminal event has a larger sequence, the item becomes visible again automatically. Stale actions must match the current terminal sequence or the Host rejects them.

## Navigation and evidence

The terminal event sequence is shown as evidence. The Open action uses the existing session runtime. A known subagent address opens the child; a hidden child falls back to its recorded parent. Harness does not currently expose a stable event-level navigation anchor, so v0.1 does not claim event deep links.
