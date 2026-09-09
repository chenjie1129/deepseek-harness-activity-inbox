# Changelog

## Unreleased

- Extract a shared deterministic activity domain for Inbox and Pet projections.
- Add a bundled ambient Pet with running, waiting, ready, blocked, failed, idle,
  and offline states.
- Add browser-local Pet visibility and motion preferences.
- Pause Pet animation when the page is hidden or reduced motion is requested.
- Move live Presence authority to the Host and expose a browser-safe
  `./presence` protocol for a future desktop client.
- Track running turns, unresolved user questions, plan reviews, and approval
  waits without requiring the Inbox browser surface to be open.
- Add Host-instance and revision semantics for reconnect synchronization.
- Document the presentation-layer boundary, priority policy, and future split
  criteria.

## 0.1.2 — 2026-08-29

- Restore Activity Inbox data loading on DeepSeek Harness `0.1.2-alpha.1` by moving the plugin's Host-to-browser calls to the supported Typert Remote API.
- Retain the legacy Connection RPC carrier as a fallback for `0.1.1-rc.2` profiles.
- Validate Remote mutations and snapshots at the plugin boundary without adding an unpublished Harness package dependency.

## 0.1.1 — 2026-08-26

- Add an explicit, labeled Close control to the Activity panel after usability testing showed that the sidebar toggle and Escape shortcut were not discoverable.
- Keep the Close control visible and comfortably tappable at narrow viewport sizes.

## 0.1.0 — 2026-08-26

- Add a root sidebar Activity inbox with Needs action, Failed, Completed, Following, and Archived views.
- Fold exact durable and live `turn/end` outcomes with race-safe event watermarks.
- Merge live approvals, questions, and plan-review waits from the client session runtime.
- Persist follow, review, snooze, and archive preferences with sequence-based re-arm semantics.
- Route subagent activity to the child when addressable and otherwise to its visible parent.
- Add bounded loopback RPC, atomic state writes, deterministic tests, and release documentation.
