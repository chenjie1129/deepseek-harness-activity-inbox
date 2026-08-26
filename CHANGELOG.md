# Changelog

## 0.1.0 — 2026-08-26

- Add a root sidebar Activity inbox with Needs action, Failed, Completed, Following, and Archived views.
- Fold exact durable and live `turn/end` outcomes with race-safe event watermarks.
- Merge live approvals, questions, and plan-review waits from the client session runtime.
- Persist follow, review, snooze, and archive preferences with sequence-based re-arm semantics.
- Route subagent activity to the child when addressable and otherwise to its visible parent.
- Add bounded loopback RPC, atomic state writes, deterministic tests, and release documentation.
