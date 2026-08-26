# Testing and release gates

`npm run check` is the source-tree gate:

1. deterministic store and view-model tests;
2. strict TypeScript checking;
3. Host and browser bundle builds;
4. npm pack dry run.

The test suite covers:

- completed, failed, blocked, and cancellation classification;
- newer live events winning over delayed historical backfill;
- persisted follow, review, snooze, and archive preferences;
- stale event-sequence mutation rejection;
- pending-interaction precedence and badge policy;
- a new terminal event re-arming old archive/snooze state;
- hidden subagent fallback to its visible parent.

Before a release, additionally verify the exact generated `.tgz`:

1. inspect its file list and bundled configuration patch;
2. run `npm audit --omit=dev`;
3. install the tarball into a fresh, isolated `$DSH_HOME` web profile;
4. inspect the composed configuration for the Host and client halves;
5. boot Harness and exercise the UI in a real browser;
6. confirm completion, failure, reconnect, page reload, the explicit Close control, review, snooze, follow, archive, and restore behavior;
7. audit the published GitHub tree and release asset against the tested commit and tarball checksum.

Passing deterministic tests proves the inbox mechanism. It does not prove third-party provider availability, natural-language quality, or multi-user behavior.
