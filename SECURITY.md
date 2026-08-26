# Security policy

## Supported version

Security fixes are provided for the latest tagged release.

## Reporting

Please report suspected vulnerabilities privately through GitHub's security-advisory flow for this repository. Do not include credentials, private session text, or exploit data in a public issue.

## Security model

- RPC accepts loopback browsers by default. `trusted-host` is an explicit deployment choice.
- RPC payloads are JSON-shape checked and capped at 16 KiB by default.
- State-changing actions use exact terminal-event sequences, preventing a stale tab from reviewing or archiving a newer outcome.
- The plugin state file contains operator preferences, not chat messages, prompts, tool arguments, credentials, or copied session logs.
- Preference writes replace the state file atomically and create temporary files with owner-only permissions.
- Error text displayed in the UI is bounded. It comes from Harness's structured turn failure, not from an AI-generated interpretation.
- Unknown extension-defined turn outcomes are omitted rather than guessed into a security-sensitive category.

This plugin does not add authentication to Harness. Keep the Host on its supported loopback/trusted-origin deployment boundary and follow the Harness security guidance.
