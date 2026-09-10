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
- hidden subagent fallback to its visible parent;
- strict Remote descriptors, Remote-shaped source calls, and the legacy Connection RPC adapter.
- shared activity-domain compatibility when live running state leads a delayed
  terminal snapshot;
- deterministic Pet priority, attention count, and target selection;
- reviewed, snoozed, and archived activity suppression in the Pet projection;
- Pet settings corruption and storage-failure fallback;
- reduced-motion, hidden-page, and urgent-transition policy.
- Host-owned running, question, plan-review, and approval Presence lifecycles;
- historical backfill exclusion from transient running and waiting state;
- Presence protocol validation, stale-revision rejection, and Host-restart
  acceptance.
- Store-to-transport Presence revision notifications and unsubscribe behavior;
- macOS Keychain lookup, stdin-only token creation, create-race recovery, and
  malformed credential rejection;
- Unix socket directory and endpoint permissions, authenticated subscribe,
  revision push, frame bounds, active-server protection, and owned cleanup.

Before a release, additionally verify the exact generated `.tgz`:

1. inspect its file list and bundled configuration patch;
2. run `npm audit --omit=dev`;
3. install the tarball into a fresh, isolated `$DSH_HOME` web profile;
4. inspect the composed configuration for the Host and client halves;
5. boot the currently supported Harness alpha and exercise the UI in a real browser;
6. confirm historical counts load through Typert Remote, mutations persist across a full Host restart, and no Activity-specific browser error is emitted;
7. confirm completion, failure, reconnect, page reload, the explicit Close control, review, snooze, follow, archive, and restore behavior;
8. audit the published GitHub tree and release asset against the tested commit and tarball checksum.
9. on macOS, create/read/delete a disposable Keychain item without printing its
   value, then authenticate to the packed plugin's Unix socket and observe a
   valid Presence response.
10. run `npm --prefix desktop run check` and `cargo test` in
    `desktop/src-tauri`;
11. build the native executable and verify the transparent Pet window, live
    Presence state, drag/snap behavior, toolbar controls, and menu-bar recovery
    on a real macOS desktop.
12. verify lifecycle discovery and unavailable states, start and stop the Pet
    from the Activity Inbox, and confirm Host disposal terminates only its
    managed child.
13. generate the platform artifact, verify every manifest digest, exercise
    current/previous atomic switching and rollback, reject an incompatible
    handshake, and confirm a second launch does not create another window.

Passing deterministic tests proves the inbox mechanism. It does not prove third-party provider availability, natural-language quality, or multi-user behavior.
