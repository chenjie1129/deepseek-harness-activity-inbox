# Pets Presentation Architecture

## Status

- Decision: approved for implementation in the Activity Inbox plugin.
- Scope: PR1 through PR3 plus desktop milestones D1 through D3.
- Product boundary: a deterministic ambient view of Harness activity, not an
  autonomous companion, game, or AI-generated summary.

## Goals

1. Reuse the existing durable event index, live session state, navigation, and
   operator preferences.
2. Give operators a glanceable view of whether work is running, ready, blocked,
   failed, or waiting for input.
3. Preserve an evidence path from every visible Pet state to a session and,
   where available, a terminal event sequence.
4. Keep the Inbox and Pet surfaces independent so either can change or fail
   without changing the other.
5. Add no model calls, network assets, notification sounds, or background work
   while the page is hidden.

## Non-goals

- Custom Pet imports or an asset marketplace.
- Pet personality, chat, memory, progression, or rewards.
- Cross-application activity sources.
- Multi-user state or assignment.
- Replacing the Activity Inbox.
- A new Host persistence format for presentation-only preferences.

## Architecture

```text
Harness session events ──┐
durable session logs ────┼──> ActivityInboxStore
approval lifecycle ──────┤           │
operator preferences ────┘           v
                              PresenceSnapshot
                                │          │
                                v          v
                         Inbox projection  Pet projection
                                              │
                                    Pet presentation runtime
                                web sidebar / Tauri desktop app
```

The Host is the authority for terminal facts, live running state, pending
interactions, and durable workflow preferences. A shared, pure Presence
projection produces normalized activity entries. The browser session feed is
used only to decorate rows with titles, current selection, and navigation
availability; it does not decide semantic Presence state.

## Layers

### Facts

Existing Host behavior remains unchanged:

- subscribe to canonical `session/event` publications;
- fold constructor-seeded sessions;
- backfill durable session logs;
- reject stale terminal-event mutations;
- persist follow, review, snooze, and archive preferences atomically.

The browser contributes current session titles, parent routing, and current
selection. Live browser state changes trigger a Host refresh to minimize
transport latency without becoming a second state authority.

### Activity domain

The shared domain model contains no Pet or Inbox rendering concepts.

```ts
type AgentPresenceState =
  | 'offline'
  | 'idle'
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'failed'
  | 'ready'

interface AgentActivity {
  sessionId: string
  state: AgentPresenceState
  detail: string
  updatedAt: number
  sourceSeq: number
  followed: boolean
  reviewed: boolean
  archived: boolean
  openTargetId?: string
}
```

`sourceSeq` uses the newest durable question, turn, or terminal event. It is
`-1` only for a transient approval with no durable turn anchor. Presentation
code must never invent an event sequence.

Host-side transient state is reconstructed as follows:

- `turn/start` and `turn/end` own running state;
- an unresolved `ask_user_question` tool call owns question or plan-review
  state;
- an `approval/request` waterfall observer owns approval state while delegating
  the decision to the next handler;
- historical backfill never resurrects running or pending state.

### Inbox projection

The Inbox adapter maps domain states to the existing categories and keeps the
current filtering and badge policy. This is a compatibility requirement for
PR1.

### Pet projection

The Pet adapter selects one deterministic focus from all non-archived
activities. Priority is:

```text
needs-input > blocked > failed > ready > running > idle > offline
```

Within the same state:

```text
current session > followed session > newer update > lexical session id
```

The output includes the selected session, attention count, label, detail, and
evidence. Clicking the Pet opens the same target the Inbox would open.

### Pet presentation runtime

The runtime maps semantic state to a visual track:

| Presence state | Visual track |
| --- | --- |
| `idle` | `idle` |
| `running` | `running` |
| `needs-input` | `waiting` |
| `ready` | `review` |
| `blocked` | `blocked` |
| `failed` | `failed` |
| `offline` | `offline` |

Animation is presentation-only. A missing visual track falls back to `idle`;
it never rewrites the domain state.

PR2 uses a bundled CSS Pet with no remote asset dependency. A later asset
system may replace the renderer behind the same projection contract.

## State Semantics

- A live pending interaction takes precedence over an older terminal event.
- An unreviewed completed turn is `ready`; a reviewed completion no longer
  claims attention.
- A reviewed failure remains visible in the Inbox but no longer controls the
  global Pet.
- Snoozed terminal activity does not control the Pet until it is re-armed.
- A new terminal sequence re-arms review, archive, and snooze watermarks.
- Disconnected or uninitialized transport is `offline`, not `idle`.
- No visible activities with a healthy connection is `idle`.

## Transition Policy

Semantic state changes are immediate. Visual transitions are stabilized by a
small presentation delay:

- attention states (`needs-input`, `blocked`, `failed`) bypass the delay;
- ordinary state changes settle for 300 ms before changing animation;
- duplicate transition keys do not restart animation;
- hidden pages pause animation and resume from the current semantic state;
- reduced-motion mode renders a stable frame with no periodic animation.

The transition key is derived from state, target session, and source sequence.

## UI Placement

The Pet is rendered next to the existing Activity sidebar action:

- wide sidebar: Pet, status label, and attention count;
- narrow rail: compact Pet with an accessible trigger label;
- click: open the Activity Inbox;
- task navigation remains the explicit `Open task` or `Open parent` action;
- no draggable or free-floating viewport overlay in PR1-PR3.

This placement avoids obscuring the editor and preserves the sidebar as the
single activity entry point.

The D3 desktop client adds a separate 260 by 280 pixel transparent window. It
is undecorated, always-on-top by default, movable from an explicit drag handle,
and snaps only when released within 48 pixels of a display edge. Menu bar
actions restore interaction, show the window, or recenter it when click-through
is enabled, the window is hidden, or a display-layout change leaves it
inaccessible. The window never embeds Harness or receives the Presence bearer
token.

## Preferences

PR1-PR3 store presentation-only settings in browser storage:

```ts
interface PetSettings {
  version: 1
  enabled: boolean
  animationsEnabled: boolean
}
```

The Host preference file remains unchanged. Cross-device synchronization can
be added later with an explicit versioned Host contract.

## Desktop Protocol Boundary

The browser-safe `./presence` package exports the snapshot, Pet projector, and
transport-neutral reconnect protocol. D2 binds that contract to owner-only
NDJSON over a Unix domain socket:

```text
presence/auth(token)
presence/subscribe(cursor?)
presence/snapshot(snapshot)
presence/unchanged(cursor)
presence/error(code, message)
```

Snapshots carry an `instanceId` and monotonic revision. A client rejects an
older revision from the same Host instance, but accepts a lower revision when
the instance id changes after Host restart.

The default macOS endpoint is:

```text
$DSH_HOME/activity-inbox/presence-v1.sock
```

The containing directory is forced to mode `0700` and the socket to `0600`.
The bearer token is a 256-bit random value stored in macOS Keychain under
service `com.deepseek-harness.activity-inbox.presence`; it is never written to
the plugin state file or passed in process arguments. The account is a stable
hash of the absolute socket path, allowing a desktop client to derive the same
Keychain lookup without a plaintext discovery file.

Each connection must authenticate before subscribing. Requests are bounded
NDJSON frames, authentication has a deadline, client count and write buffering
are capped, and comparisons use fixed-length SHA-256 digests with
`timingSafeEqual`. The stable endpoint is a symlink to a random per-instance
socket in the same private directory. Startup probes the endpoint before
removing only a confirmed stale target; shutdown removes the stable path only
when it still points to the current instance.

## Failure Isolation

- Pet projection errors render the Inbox normally and suppress the Pet.
- Animation errors fall back to a static state.
- Missing browser storage uses defaults.
- Storage write failures affect only preference persistence.
- Connection loss produces the explicit `offline` state.
- Error details remain bounded by the existing Host contract.

## Performance Budget

- No React state update per animation frame.
- CSS transforms and opacity are the only continuously animated properties.
- No animation timers while `document.visibilityState !== 'visible'`.
- No remote asset requests in PR1-PR3.
- At most one Pet instance is mounted.
- Target idle CPU overhead: less than 0.5 percent on a typical desktop.

## Delivery Plan

### PR1: Shared activity domain

- Extract normalized activity derivation from the Inbox view model.
- Keep existing Inbox categories, filters, badge behavior, and exports.
- Add deterministic priority and compatibility tests.

### PR2: Single Pet surface

- Add the Pet projection.
- Add one bundled CSS Pet and semantic state tracks.
- Add status label, attention count, enable switch, and task navigation.
- Mount it through the existing sidebar contribution.

### PR3: Reliability and performance

- Add transition stabilization.
- Pause animation while hidden.
- Add reduced-motion behavior.
- Add offline and rendering fallback states.
- Add lifecycle, storage, projection, and integration tests.

### D1: Host Presence core

- Make Host events and interaction lifecycles authoritative for Presence.
- Publish a versioned `PresenceSnapshot` with evidence and revision.
- Export a browser-safe protocol and reconnect policy.
- Keep the local socket transport out of scope until D2.

### D2: Local authenticated transport

- Publish Host Presence over a permission-restricted Unix domain socket.
- Store and reuse the transport token in macOS Keychain with no plaintext
  credential file.
- Require authentication before subscription and push every new Presence
  revision to authenticated subscribers.
- Bound frames, connection count, authentication time, and buffered output.
- Reject active-socket replacement and clean up only the current Host's socket.
- Export Node-only transport utilities from `./presence/host`.

### D3: Native desktop presentation

- Add an independently buildable Tauri 2 application under `desktop/`.
- Keep Keychain access, Unix socket parsing, reconnect cursors, URL opening,
  tray actions, and window operations in Rust.
- Forward only validated runtime state to the React WebView.
- Render a transparent single-Pet surface with status, evidence, attention
  count, reduced-motion support, and no remote assets.
- Support drag, per-monitor edge snap, always-on-top, click-through, and
  menu-bar recovery.
- Persist window position and presentation preferences without changing Host
  facts.

## Verification Contract

The implementation is complete only when:

1. existing Inbox tests remain green;
2. every semantic state and priority rule has a deterministic unit test;
3. stale, reviewed, archived, snoozed, and live-pending behavior is covered;
4. reduced motion, hidden-page pause, offline state, and storage fallback are
   covered;
5. TypeScript, production bundles, and npm package dry-run pass;
6. a real browser renders the Pet without console errors or overlap at desktop
   and narrow viewport sizes.
7. desktop TypeScript, Rust tests, and a Tauri production build pass;
8. the real desktop executable renders a non-empty transparent window, consumes
   a live Host snapshot, and exposes recovery controls in the menu bar.

## Future Split Trigger

Create a separate Companion product when any two of these become committed:

- cross-application event sources;
- operating-system-level floating windows;
- cloud-synchronized Pet identity;
- conversational personality or long-term Pet memory;
- marketplace or generated assets;
- independent release cadence from the Harness Activity Inbox.
