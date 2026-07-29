---
description: A machine joining a group for the first time used to give up forever if its very first connection attempt was refused; it now keeps retrying until it gets in, aims those retries at the right machine, and the behaviour is covered by tests.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, docs/architecture.md
difficulty: medium
---

# Complete: cold-start bootstrap retry

## The bug that was fixed

A node joining an existing party applies a **seed** — a signed bundle naming the party's
owner machines and their addresses. Applying a seed dialed those owners exactly **once**,
best-effort; a throw was logged and swallowed and the seed still reported success.

Nothing ever dialed again. The periodic control-cohort reconcile pass enumerates peers
from the **replicated** `CadrePeer` table, which at cold start is empty precisely because
no connection was ever established — filling it needs a connection, and getting a
connection needed it. A node whose one dial lost the race was stranded permanently.

## What the implementation landed (commit `eb9376c`)

- `CadreNode.controlBootstrapPeers` — peerId → the multiaddrs a seed listed, holding only
  the owner-flagged peers of seeds this node accepted. Filled by
  `recordSeedBootstrapPeers` from **both** intake paths (the `CadreNode.applySeed` wrapper
  via `noteAppliedSeed`, and the inbound `/sereus/seed/1.0.0` handler via `onSeedApplied`,
  which gained the applied seed as a third argument).
- `runReconcileControlCohort` no longer returns at `siblings.length === 0`; it calls
  `dialColdStartBootstrap()`, which skips already-connected peers and dials the rest
  best-effort. Retries are unbounded and unbacked-off, gated by "still no siblings".
- `ApplySeedResult` gained required `ownerDialsAttempted` / `ownerDialsFailed`, so callers
  can separate "seeded and connected" from "seeded and stranded" without overloading
  `success`.
- `control-cohort-cold-start-retry.integration.ts` — regression scenario with no test
  doubles: B applies A's seed while unvouched (A's membership gate refuses the dial), A
  vouches B afterwards, and B — which listens on nothing, so only B can start a connection
  — must re-dial its way in and then observe a row A writes later.

## What this review changed

- **Self-exclusion.** `createSeed` projects *every* `CadrePeer` row, so an owner applying
  a seed minted after it joined finds itself in the owner list. `recordSeedBootstrapPeers`
  now skips self, and `SeedBootstrapService.applySeed`'s owner-dial loop skips self too.
- **Peer-id binding on the retry dial.** `bootstrapDialAddrs` binds each retained address
  to the peer id it was retained under before dialing: an address naming a *different*
  peer is dropped, one naming none has `/p2p/<id>` encapsulated.
- **`trailingPeerId(addr)`** added to `peer-record.ts` — the last `/p2p/` component of a
  multiaddr (a circuit address names the relay first, the target last), replacing the
  deprecated `Multiaddr.getPeerId()`.
- **Unit coverage** for the cold-start branch and for seed retention (see below).
- **Docs**: the architecture bullet now states the self-exclusion, the peer-id binding, and
  the restart hole; the adjacent bullet's "cold start is still **broken** by the existing
  seed/bootstrap/relay paths" was a typo for "**brokered** by" that now read as a
  contradiction, and is fixed.

## Review findings

### Checked and clean

- **Both seed intake paths.** The wrapper path and the wire path each reach
  `recordSeedBootstrapPeers` exactly once (`applySeed` does not fire `onSeedApplied`; only
  the protocol handler does), so no double-record and no missed path.
- **Rejected seeds never pollute the retry set** — `noteAppliedSeed` returns early on
  `success === false`, and `onSeedApplied` only fires on success.
- **Shutdown/teardown re-guards.** `dialColdStartBootstrap` re-checks `_running` and
  `controlNode` inside its loop, matching the steady-state pass; now unit-proven.
- **`ApplySeedResult` construction sites.** The two new fields are required; only
  `seed-bootstrap.ts` constructs the type (`reference-app-ns` / `reference-app-rn` merely
  pass it through as a return annotation). All-workspace typecheck confirms.
- **Solo cadre is unaffected** — an empty bootstrap map early-returns before any work.
- **`isOwner` as a dial-target selector** is sound: the whole seed is signature-checked
  against a trust anchor first, and a dial grants no authority. Same reasoning the existing
  `applySeed` owner-dial loop and the reconcile pass's owner preference already rely on.

### Found and fixed in this pass (minor)

- **Self-dial loop.** A node retained *itself* as a bootstrap target whenever it applied a
  seed listing it as an owner, then dialed itself every reconcile pass forever. The same
  omission in `applySeed`'s owner-dial loop counted the guaranteed self-dial failure into
  the new `ownerDialsFailed`, so a perfectly healthy owner reported "seeded but stranded".
  Both now skip self.
- **Unauthenticated retry target.** The retry dialed the seed's raw addresses. An address
  without a `/p2p/` component connects to whoever answers it, and unlike the one-shot
  `applySeed` dial this repeats every 15 s indefinitely. Addresses are now bound to their
  peer id, and a mismatched one is dropped.
- **No unit coverage of the cold-start branch.** Eleven tests added to
  `cadre-node-control-cohort.spec.ts`: dials when the table has no siblings, skips
  already-connected peers, leaves bootstrap peers alone once a sibling exists, binds a
  bare address, drops a mismatched one, continues past a throwing dial, abandons the loop
  on stop; plus retention — owner-only, address-required, self excluded, re-seed replaces
  rather than accumulates, and the inbound `onSeedApplied` path retains.
- **`ownerDialsAttempted` never asserted.** The integration scenario now asserts it is `1`.
  `ownerDialsFailed` is deliberately *not* asserted, and the reason is written into the
  test: the receiver's gate denies after the dialer's upgrade completes, so the dial may
  or may not throw. That race is exactly the caveat already documented on the field, so
  the field is honest about what it means and safe to expose.

### Found and filed (major)

- **Seed bootstrap addresses are lost on restart** →
  `tickets/backlog/bug-seed-bootstrap-addrs-lost-on-restart.md`. `controlBootstrapPeers` is
  in-memory only, and applying a seed writes nothing durable, so a node that is seeded,
  fails to connect, and then restarts is stranded permanently again — the same defect class
  this ticket fixed, on a path that needs no unusual conditions (a phone app relaunch, a
  container restart). `cadre-cli start --seed` masks it by re-applying on every start;
  runtime seed delivery (the `/sereus/seed/1.0.0` protocol, the host donation flow) has no
  such second chance.

### Tripwires

- The existing `NOTE:` on `dialColdStartBootstrap` (add per-peer backoff **if** seeds ever
  carry many owner peers, or **if** the reconcile cadence drops well below its 15 s
  default) was reviewed and left as the right disposition — it is genuinely conditional and
  sits at the exact site.
- No new tripwire was added. The one other conditional noticed — `controlBootstrapPeers` is
  never evicted, so it would grow if a node ever applied seeds naming many distinct owners
  — is already stated in the field's own doc comment, and duplicating it would not tell a
  future reader anything the code does not.

### Not investigated (budget)

The run hit its token budget before the exhaustive test sweep. What was **not** re-run is
listed under Validation below; nothing was skipped, disabled, or loosened.

## Validation

Run on the reviewed tree, after the review's code changes:

| Check | Result |
| --- | --- |
| `yarn typecheck` (all workspaces) | **clean** |
| `yarn lint` (all workspaces) | **clean** |
| `yarn workspace @serfab/cadre-core build` | **clean** |
| `cadre-core` — `cadre-node-control-cohort`, `control-stream-authorization`, `seed-bootstrap`, `peer-record` specs | **119 passed** (4 files) |
| `control-cohort-cold-start-retry.integration.ts` | **pass**, 4.6 s |

Carried over from the implement run, on the same code apart from this pass's changes: full
`cadre-core` suite (829 passed / 1 skipped — the skip is `key-store.spec.ts`'s
`skipIf(win32)` POSIX-permissions test), full integration suite (29 files / 118 tests), and
a **negative control** — with the cold-start dial removed, the scenario failed exactly at
the re-dial assertion after 45 s, proving libp2p's own auto-dial does not recover this state.

**Not re-run in this pass:** the full `cadre-core` unit suite beyond the four files above,
and the full integration suite. The review's changes are confined to the cold-start dial
path, seed retention, and one new `peer-record` helper; the four specs re-run cover every
caller of the changed code, and lint + all-workspace typecheck are clean. A CI run should
still exercise both full suites.

Nothing was written to `tickets/.pre-existing-error.md` — no failure surfaced.

## Known gaps carried forward

- **Restart loses the bootstrap map** — filed, see above.
- **Timing margins are untested under load.** B recovers in ~4.6 s against a 45 s wait, on
  a developer machine, running alone with `fileParallelism: false`. Nothing has been run on
  slow or contended CI.
- **A seed carrying many owner peers is untested.** The scenario's seed nominates exactly
  one owner, so the unbounded-retry cost argument rests on that assumption holding in the
  field — which is what the backoff tripwire is for.
- **The inbound `/sereus/seed/1.0.0` path is still not proven over the wire.** Its retention
  seam is now unit-covered on both ends (`onSeedApplied` passes the seed; `CadreNode`
  retains from it), but no test delivers a seed over a real stream and then asserts the
  owner peers became retry targets.
