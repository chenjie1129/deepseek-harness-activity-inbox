# DeepSeek Harness Activity Inbox

A standalone DeepSeek Harness plugin that turns exact agent outcomes into a calm, deterministic inbox. It adds one **Activity** button to the sidebar and does not patch Harness core.

## MVP

- **Needs action** — live approvals, questions, plan reviews, and turns that explicitly reported `blocked`.
- **Failed** — exact `turn/end` outcomes for errors, token-limit stops, and crash interruptions.
- **Completed** — exact completed turns for deterministic catch-up.
- **Following** — tasks the operator wants to keep visible, including running or idle tasks.
- **Reviewed, snoozed, archived** — durable single-operator workflow state. A newer terminal event automatically re-arms an older reviewed, snoozed, or archived task.
- **Subagent routing** — child outcomes identify their visible parent; the Open action routes to the child when addressable and otherwise to the parent task.
- **Evidence, not summaries** — every terminal row comes from the durable Harness session log and displays its source event sequence. No model call generates the inbox.
- **Ambient Pet** — the sidebar companion reflects the same deterministic activity facts with running, waiting, ready, blocked, failed, idle, and offline states.
- **Desktop-ready Presence protocol** — the Host owns live state and exports a versioned, browser-safe `./presence` contract with restart-aware revisions.
- **Authenticated local Presence** — macOS publishes revisions over an owner-only Unix socket and keeps its bearer token in Keychain rather than a plaintext file.
- **Native desktop Pet** — the Tauri client in `desktop/` provides a transparent always-on-top window, edge snapping, click-through mode, and menu-bar recovery.
- **Host-managed lifecycle** — the Inbox can start or stop a discovered desktop build without exposing executable paths or process control to the browser.
- **Verified platform artifacts** — macOS builds use a full-bundle hash manifest, atomic activation, one-release rollback, version handshake, and single-instance recovery.

The attention badge counts unresolved live waits plus unreviewed blocked or failed outcomes. Ordinary completions remain available for catch-up without making the badge noisy.

## Install from a packed artifact

Requirements: DeepSeek Harness `0.1.1-rc.2` or `0.1.2-alpha.1` through the pre-`0.2` line, Node.js 22.19+ (or 24+), and the web profile.

Download `chenjie1129-dsh-activity-inbox-plugin-0.1.2.tgz` from the [v0.1.2 GitHub release](https://github.com/chenjie1129/deepseek-harness-activity-inbox/releases/tag/v0.1.2). To build the same package from a clone instead, run `npm install` followed by `npm pack` in this repository.

```bash
cd /path/to/deepseek-harness
npm run dsh -- plugin --profile web add /absolute/path/to/chenjie1129-dsh-activity-inbox-plugin-0.1.2.tgz
npm run dsh -- --profile web
```

The plugin stores only operator preferences on disk at:

```text
$DSH_HOME/activity-inbox/state-v1.json
```

On macOS, the local Presence bridge is enabled by default at:

```text
$DSH_HOME/activity-inbox/presence-v1.sock
```

Its directory and socket modes are `0700` and `0600`. The 256-bit transport
token is stored in macOS Keychain under service
`com.deepseek-harness.activity-inbox.presence`; the account is derived from the
absolute socket path. No plaintext token file is created.

Override the paths, disable the desktop bridge, or change the legacy RPC
authority in the composed Cordis entry when needed:

```yaml
- id: activity-inbox
  name: '@chenjie1129/dsh-activity-inbox-plugin'
  config:
    statePath: /absolute/path/to/activity-inbox.json
    authority: loopback
    backfillConcurrency: 4
    presenceSocketEnabled: true
    presenceSocketPath: /absolute/path/to/presence-v1.sock
    presenceAuthTimeoutMs: 5000
    presenceMaxClients: 8
```

Harness `0.1.2-alpha.1` uses the supported Typert Remote API. The plugin automatically retains its bounded Connection RPC carrier for `0.1.1-rc.2`; `loopback` is the safe default for that fallback. Use `trusted-host` only when the legacy Harness Host's trusted-origin policy is deliberately configured for remote browser access.

Desktop clients use newline-delimited JSON. They first send
`presence/auth`, then `presence/subscribe`; the Host responds with
`presence/snapshot` or `presence/unchanged` and pushes later revisions. The
Node-only `./presence/host` export provides the Keychain descriptor and socket
helpers for local integrations.

Build the macOS desktop client after starting a compatible Harness Host:

```bash
cd desktop
npm install
npm run check
npm run tauri -- build
```

The Host discovers a local release build automatically during repository
development. Packaged deployments can set `desktopPetExecutablePath`.
`desktopPetAutoStart` is disabled by default, and
`desktopPetStopOnHostExit` defaults to enabled.
Release automation may point `DSH_ACTIVITY_PET_ARTIFACT` or
`desktopPetArtifactPath` at a platform package; explicit artifacts fail closed
when manifest validation fails.

Build a publishable package for the current macOS architecture after the Tauri
release build:

```bash
npm run desktop:artifact
npm pack --dry-run desktop/artifacts/darwin-arm64
```

## What v0.1 does not claim

- No Slack/Discord integration, push notification, email digest, or mobile client.
- No multi-user read state, assignment, team permissions, or shared inbox semantics.
- No AI-written catch-up summary. Rows show deterministic outcome facts only.
- No deep link to an individual event; current Harness UI exposes task navigation, not stable event anchors.
- No historical backfill for a session log the configured persistence provider cannot read. The panel reports the number of backfill failures.

See [Architecture](docs/ARCHITECTURE.md), [Pets Architecture](docs/PETS_ARCHITECTURE.md), [Testing](docs/TESTING.md), and [Security](SECURITY.md).

## Development

```bash
npm install
npm run check
npm audit --omit=dev
```

MIT licensed.
