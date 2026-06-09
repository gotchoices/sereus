priority: 4
description: Optional local-UI / HTTP entry path for cadre-host push (FCM/APNs) credentials. The CLI (`cadre-host push {fcm,apns,options,status,clear}`) already provisions credentials directly on disk; this is a convenience surface so an operator can configure push from the running manager's local UI instead of the shell. Future concern — not blocking; the CLI fully satisfies the entry-path requirement today.
files: packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/push/index.ts, packages/cadre-host/src/server/server.ts, packages/cadre-host/src/server/settings-store.ts, packages/cadre-host/src/installer/config.ts
----

## Use case

A self-hoster running `cadre-host` with the local management UI open wants to enter their FCM/APNs push credentials (and the bundle id / sandbox toggle / cooldown-debounce tuning) from a Settings screen, rather than dropping to a terminal to run `cadre-host push fcm …` / `push apns …`.

Today the **only** entry path is the CLI subcommands, which write directly to the data dir's secret store + `host.config.json` (the same direct-on-disk pattern as `install`, deliberately not going through the HTTP API). That fully provisions push and is the shipped, tested path. This ticket is the optional HTTP/UI convenience layer on top.

## Expected behavior

- An authenticated `PUT`/`POST` route on the manager's HTTP server (mirroring the existing settings/update routes) that accepts a push-credential payload, writes the secret bits to the secret store (`setFcmSecret` / `setApnsSecret` / `clearPushSecret`, already exported from `@serfab/cadre-host`) and the non-secret bits to `host.config.json` (`PushSettings`), exactly as the CLI does.
- A read route exposing `pushStatus` (configured-platforms + non-secret bundle/sandbox/cooldown/debounce) — **never** returning any private key or other secret material.
- A Svelte Settings field in the local UI that drives those routes (private key entry should accept a file upload / paste, and make clear the key is write-only — status shows "configured", never the value).
- Changes take effect on the **next authority-node respawn** (same as the CLI path — the `pushResolver` re-reads the secret store + config on every spawn), so the UI should surface a "restart to apply" affordance like the CLI does.

## Notes / constraints

- Reuse the existing `src/push/` module (`resolvePushCredentials`, `setFcmSecret`, `setApnsSecret`, `clearPushSecret`, `pushStatus`) — do not re-implement secret handling in the server layer.
- Secret hygiene is the hard requirement: private keys live only in the secret store, never in `host.config.json`, never in `state.json`, never logged, and never returned by a read route.
- This is a UI/ergonomics enhancement, not a correctness gap. The push subsystem is fully functional via the CLI without it.
