---
description: Tier 2 e2e data-convergence flake (3 specs, ~5–26% protocol-client dial:fail) root-caused. `findCluster` returns FRET cohort members with EMPTY multiaddrs for any cohort peer that isn't a live *direct* connection — which is always true for browser tabs (they reach the mesh only through a relay and never connect to each other). When a block's cohort straddles a browser tab, the coordinator's commit broadcast / read-repair dial to that member fails with `code=none msg="The dial request has no valid addresses"`, the replica goes stale, and tab B never sees tab A's write. Fix: keep relay-only (non-listening) peers out of storage cohorts so clusters consist only of dialable service peers. Harness gap (acceptance #1) already fixed in the working tree.
prereq:
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/cluster/spread-on-churn.ts, ../optimystic/packages/db-p2p/src/cluster/rebalance-monitor.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/network/network-manager-service.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## Root cause (reproduced + confirmed 2026-05-27)

Captured a fresh `OPTIMYSTIC_E2E_DEBUG=1` run of `two-tab-convergence.spec.ts`
**after** fixing the harness `%s`-interpolation gap (see "Harness gap" below).
The real, previously-lost `dial:fail` fields are now visible:

```
dial:fail peer=<browser-tab> protocol=.../db-p2p/sync/1.0.0 ms=1 code=none msg=The dial request has no valid addresses
```

dial breakdown for the run (15 fails / 290 ok / 0 timeout):

| count | protocol | code | msg |
|---|---|---|---|
| 14 | `db-p2p/sync/1.0.0` | none | **The dial request has no valid addresses** |
| 1  | `repo/1.0.0`        | none | `e[0].getComponents is not a function` (secondary, below) |

Per-peer dial outcomes pinned the cause exactly. Five peers in the mesh:

| peer | dial:ok | dial:fail | role |
|---|---|---|---|
| `…JnGdc6…` | 141 | 4 | service/bootstrap (directly connected) |
| `…A7i1qR3…` | 108 | 4 | service/bootstrap (directly connected) |
| `…CMugD6…` | 41 | 2 | service/bootstrap (directly connected) |
| `…KmapaF…` | **0** | 4 | **other browser tab** — never once dialable |
| `…DQT6…` | **0** | 1 | **other browser tab** — never once dialable |

The two browser tabs are **never** successfully dialed by each other; every
attempt fails immediately (`ms=1`) with *no valid addresses*. The service peers
fail only occasionally (transient, pre-identify races).

### Mechanism — the `findCluster` / `findCoordinator` asymmetry

`Libp2pKeyPeerNetwork.findCoordinator` (`libp2p-key-network.ts:331`) filters the
FRET cohort to peers that are **currently connected** (line 363-364:
`connectedSet.has(id) || id === self`). So the chosen *coordinator* is always a
live, dialable connection — good.

`Libp2pKeyPeerNetwork.findCluster` (`libp2p-key-network.ts:466`) does **not**.
It returns the *entire* FRET cohort (`assembleCohort(coord, clusterSize)`, line
470) and, for every member that is not the local peer, populates `multiaddrs`
**only from active direct connections** via `getConnectedAddrsByPeer()`
(line 447-456, 491-494):

```ts
const strings = connectedByPeer[idStr] ?? []   // <-- [] for any non-direct peer
peers[idStr] = { multiaddrs: this.parseMultiaddrs(strings), publicKey: … }
```

A browser tab reaches the mesh only through a service-peer **circuit relay** and
never opens a direct connection to the other tab, so `connectedByPeer[tabId]` is
always `[]` → the cohort entry for a browser tab carries `multiaddrs: []`. When
the coordinator later dials that cluster member (commit broadcast, or
read-repair fetch), libp2p has no address to dial → `code=none msg="The dial
request has no valid addresses"`.

### Why the 3 specs flake (and why this run happened to pass)

`clusterSize = 3` (browser distributed default, `optimystic.ts:149`). The mesh
has 3 storage peers + 2 browser tabs in the keyspace. For each block,
`assembleCohort` picks the 3 keyspace-nearest peers:

- Cohort = {3 service peers} → fully dialable → **converges** (this run: spec
  passed, the single read-repair event was a `noop` because data was already
  replicated).
- Cohort straddles a browser tab → that replica is undialable → commit
  broadcast can't reach it / supermajority of *reachable* replicas isn't met /
  the stale replica is exactly the one tab B reads from → **B never sees A's
  write** → 20–30s `toBeVisible` timeout.

The outcome is keyspace-hash-dependent per write, which is why the suite is
flaky (3-of-16 to 3-of-3 depending on the day's block IDs and the
shortened broadcast-retry budget from `web-e2e-tier2-consensus-broadcast-race`).

## Reconciliation with the prior `complete/web-e2e-tier2-*` chain

The earlier fixes were all real and correct, but each addressed a layer
*above* this one, so none could close the gap:

- **`web-e2e-tier2-cluster-supermajority`** — lowered the distributed threshold
  to `0.51` (`ceil(3*0.51)=2`). Correct, but a 2-of-3 supermajority is still
  unreachable when one of the 3 cohort members is an undialable browser tab.
- **`web-e2e-tier2-consensus-broadcast-race`** — shortened the commit-broadcast
  retry budget 60s→7.75s. This made the flake *deterministic-worse* precisely
  because the retries it shortened were retries against the undialable browser
  replica — they were never going to succeed regardless of budget.
- **`optimystic-coordinator-read-repair`** — added `CoordinatorRepo` read-repair
  (`'lazy'`, 10s). Confirmed live in this run (`cluster-tx:read-repair-triggered`
  → `…-noop`). It can't help here: read-repair fetches *from cluster peers*, and
  the missing data lives on / is owed-to an undialable browser replica.
- **`optimystic-circuit-relay-reservation-lifetime`** / **`circuit-relay-long-lived-spec-never-publishes`** — fixed relay limits + the regression spec. The
  browser→relay reservation itself works (the `connectToBootstrap`
  `/p2p-circuit/p2p/<self>` gate passes for every spec). The problem is not the
  reservation; it's that the *other peers' `findCluster` result* never carries
  the relay address for a browser cohort member, so the relayed path is never
  even attempted.

Net: every prior fix was on the coordinator/consensus/relay-reservation layer.
The unaddressed fact is **browser tabs are selected as cluster storage members
yet are mutually undialable**.

## Fix direction

### Primary — keep relay-only peers out of storage cohorts (thin-client)

Browsers cannot listen (`optimystic.ts` header; `listenAddrs: ['/p2p-circuit']`
only). They should participate as read/write **clients**, not as storage
replicas. The clean fix is to exclude relay-only / non-listening peers from FRET
cohort assembly so a block's cluster is always composed of dialable service
peers.

There is **no existing peer-role/capability concept** in `db-p2p` (grepped:
no `relayOnly` / `isClient` / `storageCapable` / `peerRole`). So this needs a
small capability signal — e.g. a peer advertising only `/p2p-circuit` listen
addrs (no direct transport address) is treated as relay-only and not admitted to
cohort membership. Candidate seams:

- `assembleCohort` call sites that feed *storage* selection:
  `libp2p-key-network.ts:470` (`findCluster`), `:358` (`getNeighborIdsForKey`
  used by `findCoordinator`), `spread-on-churn.ts:188`, `rebalance-monitor.ts:172`,
  `network-manager-service.ts:312`, `libp2p-node-base.ts:497`.
- Or filter at the point peers are admitted into the FRET keyspace membership so
  relay-only clients never enter a cohort in the first place (preferred — single
  choke point, keeps `assembleCohort` callers unchanged). Investigate where FRET
  membership is populated from libp2p peer connect/identify events.

With browsers excluded, the test mesh's 3 service peers exactly satisfy
`clusterSize = 3`, so clusters become fully dialable.

### Secondary / defense-in-depth — make `findCluster` address-aware

Independently of the role work, `findCluster` should not hand back cohort members
with empty `multiaddrs`. Mirror `findCoordinator`'s connectivity filter: drop (or
fall back to peerStore relay addrs for) any cohort member with no dialable
address. This alone won't fix convergence (dropping below `clusterSize` breaks
supermajority — see "Why the 3 specs flake"), but it converts silent
"no valid addresses" dial churn into a clean, correct cluster set and is a good
guard even after the role fix lands.

### Tertiary (minor) — `e[0].getComponents is not a function`

One dial:fail (`repo/1.0.0`, dialing a browser tab) threw
`e[0].getComponents is not a function` instead of a clean "no addresses" error.
`getComponents()` is a `@multiformats/multiaddr` method, so a non-Multiaddr
(likely a raw string addr) is reaching the circuit-relay transport's dial path.
Almost certainly the same browser-peer-with-bad-address trigger; the primary fix
should remove the trigger. If it persists after the primary fix, spin out a
focused `fix/` ticket with the captured cid (`WclERuSkKP4IrdvAw8sfkg`).

## Harness gap (acceptance #1 — DONE in working tree)

`packages/reference-app-web/e2e/distributed/_helpers.ts` `maybeEnableBrowserDebug`
previously logged `msg.text()`, which returns the raw `debug` format string
(`dial:fail … code=%s msg=%s`) because the browser console interpolates lazily.
**Already fixed**: the console hook now resolves `msg.args()` via
`JSHandle.jsonValue()` and re-applies printf substitution (`formatConsoleArgs`,
handling `%s %d %i %f %j %o %O %c %%`), so the interpolated `code=`/`msg=` fields
land in the test output (this is how the codes above were captured). `tsc
--noEmit` clean. The runner will commit this with the ticket move; preserve it.

## Validation notes

- Full Tier 2 sweep is agent-runnable (prior runs ~2.5m, single worker) but each
  spec spawns the 3-node reference mesh; stream with `tee` and never silently
  redirect (10-min idle-timeout rule). A single failing spec
  (`two-tab-convergence.spec.ts`) reproduces in ~35s and is the fast inner loop.
- `db-p2p` unit suite is the gate for the role/cohort change; add a spec pinning
  that a relay-only / addressless cohort member is excluded from `findCluster`
  output (and from `findCoordinator` candidacy, already filtered).

## TODO

- [ ] Decide the relay-only signal: detect "no direct (non-circuit) listen addr"
      from a peer's advertised/identify addresses; thread a `relayOnly`/`client`
      flag (or equivalent) into FRET membership admission.
- [ ] Exclude relay-only peers from storage cohort assembly. Prefer a single
      choke point at FRET membership admission; otherwise filter at the
      `assembleCohort` storage call sites listed above.
- [ ] Defense-in-depth: in `findCluster` (`libp2p-key-network.ts:466-500`), drop
      cohort members whose resolved `multiaddrs` is empty (or backfill from
      peerStore relay addrs), matching `findCoordinator`'s connected-filter.
- [ ] Add `db-p2p` unit spec(s): relay-only / addressless peer is not returned by
      `findCluster`; a 3-service-peer cohort is returned intact.
- [ ] Re-run `OPTIMYSTIC_E2E_DEBUG=1 yarn workspace @serfab/reference-app-web test:e2e`
      (Tier 2). Target: 16/16, dial:fail < 1%. Use the now-fixed `_helpers.ts`
      capture to confirm zero `no valid addresses` fails against browser peers.
- [ ] Confirm the `getComponents` TypeError no longer appears; if it does, file a
      focused follow-up.
- [ ] If excluding browsers from clusters surfaces a design objection (browsers
      *should* eventually be storage members), capture it and re-scope rather than
      forcing 16/16 — but the thin-client model matches the current
      "browsers can't listen" architecture and the relay ticket's original
      `…-thin-client` framing.
