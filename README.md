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

The attention badge counts unresolved live waits plus unreviewed blocked or failed outcomes. Ordinary completions remain available for catch-up without making the badge noisy.

## Install from a packed artifact

Requirements: DeepSeek Harness `0.1.1-rc.2` or `0.1.2-alpha.1` through the pre-`0.2` line, Node.js 22.19+ (or 24+), and the web profile.

Download `chenjie1129-dsh-activity-inbox-plugin-0.1.2.tgz` from the [v0.1.2 GitHub release](https://github.com/chenjie1129/deepseek-harness-activity-inbox/releases/tag/v0.1.2). To build the same package from a clone instead, run `npm install` followed by `npm pack` in this repository.

```bash
cd /path/to/deepseek-harness
npm run dsh -- plugin --profile web add /absolute/path/to/chenjie1129-dsh-activity-inbox-plugin-0.1.2.tgz
npm run dsh -- --profile web
```

The plugin stores only operator preferences at:

```text
$DSH_HOME/activity-inbox/state-v1.json
```

Override the location or legacy RPC authority in the composed Cordis entry when needed:

```yaml
- id: activity-inbox
  name: '@chenjie1129/dsh-activity-inbox-plugin'
  config:
    statePath: /absolute/path/to/activity-inbox.json
    authority: loopback
    backfillConcurrency: 4
```

Harness `0.1.2-alpha.1` uses the supported Typert Remote API. The plugin automatically retains its bounded Connection RPC carrier for `0.1.1-rc.2`; `loopback` is the safe default for that fallback. Use `trusted-host` only when the legacy Harness Host's trusted-origin policy is deliberately configured for remote browser access.

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
