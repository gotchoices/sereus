---
description: Replace NetworkTransactor's flat 30s timeout with a short, surfaceable per-peer dial deadline so unreachable cluster members fail fast and consensus retries elsewhere
files: ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/reference-peer/src/cli.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## Why this exists

`NetworkTransactor` is constructed with `timeoutMs: 30000` from both the
reference-peer CLI (`cli.ts:354`) and the browser reference app
(`optimystic.ts:63`). That ceiling is the cumulative budget; an
unreachable cluster member burns the entire window before consensus can
move on.

In the current Tier 2 e2e fixture, this manifested as the data-convergence
specs blowing past their 30s spec timeouts because browsers were undialable
cluster members. The companion ticket
`web-e2e-tier2-data-convergence-relay` fixes the reachability root cause
via circuit-relay reservations — but the timeout shape is still wrong for
a transactional layer, and a flaky peer in production will still hang a
transaction for the full budget.

## Desired behaviour

- A short per-peer dial deadline (~2-5s, tunable) so an unreachable
  member is dropped quickly and the consensus layer re-picks.
- The overall transaction still gets a sensible upper bound; the
  difference is *granularity*. A 30s transaction can afford ten 3s
  dial attempts against different peers rather than one 30s hang.
- Failures should be surfaceable enough that the UI (diagnostics
  panel, error ring buffer) can show "dialed peer X, timed out" rather
  than an opaque "network timeout".

## Non-goals

- Not aiming to make individual dials faster end-to-end — just to fail
  fast when they won't complete.
- Not changing the consensus quorum semantics or `findCluster` selection.

## Open questions

- Where does the current 30s actually apply — is it per-call, per-dial,
  or whole-transaction? Read the `NetworkTransactor` implementation
  carefully before designing.
- Does FRET / `Libp2pKeyPeerNetwork` already track per-peer dial
  reliability that could feed into selection? If so, the timeout fix
  may pair naturally with a reputation tweak.
