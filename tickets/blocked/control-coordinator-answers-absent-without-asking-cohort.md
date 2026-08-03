----
description: When a second machine joins a cadre, reads of a shared-settings table can be answered "nothing was ever saved here" by whichever machine the lookup lands on — even when another machine in the group holds the data. That machine never asks its peers before answering. The fault is one line in the shared database library kept in the sibling `optimystic` checkout, so it cannot be fixed in this repository.
prereq:
files: ../optimystic/packages/db-p2p/src/repo/service.ts (line 264 — THE site), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (get, lines 299-388), ../optimystic/packages/db-core/src/transactor/network-transactor.ts (get, lines 134-168), ../optimystic/packages/db-core/src/collection/collection.ts (updateInternal, throw at line 236), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/harness/block-store-probe.ts
difficulty: hard
repro: verified
----

# Blocked (b): a remote block read never consults the cohort, so a coordinator that holds nothing reports an authoritative absence

**This ticket replaces `fix/0-bug-control-collection-header-absent-at-committed-revision`.**
That ticket asked one question — "a collection reports committed revision N while its header
block reports absent; which one is lying, and where?" — and it has been answered by measurement.
Neither is lying. The revision is real, the header block is really there, and the *read* is
being answered by a machine that does not have it and never asked anyone who does.

## Category and unblock condition

**Category (b) — dependency outside this repo.** The one code site that must change is

```
../optimystic/packages/db-p2p/src/repo/service.ts:264
```

```ts
} else if ('get' in operation) {
    response = await this.repo.get(operation.get, { expiration: message.expiration, skipClusterFetch: true } as any)
```

`RepoService.handleIncomingStream` sets `skipClusterFetch: true` on **every** block read that
arrives over the repo protocol — that is, on every read a *remote* peer makes, which is the
normal case in any party with more than one machine. `CoordinatorRepo.get`
(`../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:337`) reads that flag and skips the
cohort consult entirely, so a coordinator with no local copy answers `{ state: {} }` — an
*authoritative* absence, with no `unavailable` flag. `NetworkTransactor.get`
(`../optimystic/packages/db-core/src/transactor/network-transactor.ts:134-168`) treats an
unflagged absence as final and does not retry it against another peer, by design and with a
comment saying so.

That comment is the clearest statement of the contradiction — it is at
`network-transactor.ts:141-145` and it says:

> Cross-member reconciliation for a missing block has already happened one layer down:
> `CoordinatorRepo.get` detects `isMissing` and consults cluster peers before it responds.

For a remote read that is false, and `service.ts:264` is why.

**Unblock condition:** an optimystic change that stops a remote read from being answered as an
authoritative absence by a coordinator that never consulted its cohort. Two obvious shapes, both
upstream's call:

- drop `skipClusterFetch: true` at `service.ts:264` (the consult reaches peers over the *sync*
  and *block-transfer* protocols, not the repo protocol, so the recursion this flag was
  introduced to prevent does not arise on this path); or
- keep the skip but make the skipped-consult absence report `unavailable` instead of a bare
  `{ state: {} }`, so `NetworkTransactor.get` retries it against another peer.

The first shape is the one measured green below.

Then rebuild (`cd ../optimystic && yarn build`), re-run the scenarios in "Blast radius", and
delete this ticket's entries from `tickets/.pre-existing-known.md`.

## The trace

Measured 2026-08-03, sereus at `2a66324`, `../optimystic` clean at `092f33f`, `../quereus`
rebuilt. Two in-process nodes, both `profile: 'storage'`, on one party:

1. A is genesis owner and writes `CadrePeer` rows while alone. Its raw block store holds
   `default/CadrePeer` and `default/CadrePeer/index/_uniq_5`. (Both sit at block revision 1
   throughout, and that is correct — the header block is rewritten only when the BTree root node
   id changes, so its own revision legitimately lags the collection revision. The original
   ticket's first hypothesis — "a revision advanced without a corresponding header rewrite" — is
   therefore true but harmless, and is **not** the defect.)
2. B joins and connects. The distributed-hash-table ring changes, and A's own lookups for
   `default/CadrePeer` now route to **B**.
3. B has never held that block. Because the read arrived over the repo protocol, B skips the
   cohort consult, does not ask A, and answers absent-and-authoritative.
4. A's `Collection.updateInternal` sees "I hold committed revision 3, the header reads absent",
   which is exactly the contradiction it is written to refuse, and throws
   `CollectionHeaderVanishedError` (`../optimystic/packages/db-core/src/collection/collection.ts:236`).
   Every subsequent write on A fails the same way — the state is permanent, not transient,
   because the routing does not change back.

The per-node evidence, from an instrumented run (`answerer` is the node whose
`CoordinatorRepo.get` produced the entry):

```
before connect:  COORD answerer=A get(default/CadrePeer) ctx=null -> block=yes rev=1
CASE3 connected
after connect:   COORD answerer=B get(default/CadrePeer) ctx=null -> block=no  rev=-  unavail=-
                 CASE3 write 0 FAILED: collection default/CadrePeer holds committed revision 3,
                 but its header block read as absent
A raw store:     default/CadrePeer@1  default/CadrePeer/index/_uniq_5@1   (the block IS here)
B raw store:     optimystic/schema@1                                      (B holds nothing)
```

No `findCluster` call is logged on B between the read and its answer — the consult did not run,
which is the flag doing exactly what it says.

## The proof

Neutralizing that one flag at runtime — from sereus, without editing the sibling — turns the
failure off and makes replication actually happen. Two throwaway files reproduce it; both were
deleted after measuring, and are reproduced here verbatim so the experiment can be re-run in
about two minutes.

`packages/integration-tests/zz-diag-vitest.config.ts`:

```ts
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

export default mergeConfig(base, defineConfig({
	test: { setupFiles: ['./src/scenarios/zz-diag-noskip-setup.ts'] }
}))
```

`packages/integration-tests/src/scenarios/zz-diag-noskip-setup.ts` (note: **not** named
`*.integration.ts`, so the default config never picks it up as a test):

```ts
import { CoordinatorRepo } from '@optimystic/db-p2p';

const cr = CoordinatorRepo.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const origGet = cr.get;
cr.get = function (this: unknown, blockGets: unknown, ...rest: unknown[]) {
	if (rest[0] && typeof rest[0] === 'object') {
		rest[0] = { ...(rest[0] as object), skipClusterFetch: false };
	} else {
		rest[0] = { skipClusterFetch: false };
	}
	return origGet.call(this, blockGets, ...rest);
} as never;
```

Run from `packages/integration-tests`:

```
npx vitest run --config ./zz-diag-vitest.config.ts --reporter=dot \
  control-db-two-node-convergence strand-addr-seed-convergence strand-unpublish-sibling-convergence
```

With the flag neutralized, B consults A, acquires the block, and answers `block=yes rev=1`; the
block also lands physically in B's raw store (`default/CadrePeer@1`,
`default/CadrePeer/index/_uniq_5@1`, `default/OwnerKey@1` appear where before there was only
`optimystic/schema@1`), i.e. replication works.

## Blast radius (measured, same session)

| scenario set | at HEAD | with `service.ts:264` neutralized |
| --- | --- | --- |
| `control-db-two-node-convergence`, `strand-addr-seed-convergence`, `strand-unpublish-sibling-convergence` | 2 of 3 files red | **3 of 3 green** |
| the 5-file deterministic set from the old ticket, plus `push-wake-e2e` | 4 files red | 1 file red (`push-wake-e2e` only) |
| `convergence-stress` disconnect/reconnect | red | green in the patched run — but see below, it is tracked elsewhere and is timing-dependent |

`push-wake-e2e` fails 3 of 4 tests either way. What changes is the fingerprint: at HEAD it is the
header-absent one; with the flag neutralized it becomes `Block default/CadrePeer is unavailable
(peers-unreachable): the repo could not determine whether it exists`, plus a control-schema
`createTable` failure on the other two tests. That is the honest answer replacing the wrong one —
progress, but `push-wake-e2e` clearly has a second cause and should not be assumed fixed by the
unblock.

## What is deliberately NOT in this ticket

- `convergence-stress` disconnect/reconnect and node-B cold-start DDL, both failing with
  `Self-coordination blocked: grace-period-not-elapsed` — already
  `fix/1-bug-rejoining-node-cannot-self-coordinate-after-reconnect`.
- `control-cohort-edge-carries-data` carry step — already
  `fix/control-read-over-fresh-edge-stream-resets`.
- The parent class ticket `blocked/control-db-cross-node-convergence-halted.md` is the older,
  broader record of this whole failure class (retry storms, quorum floors, retracted
  hypotheses). It is worth reading for history but its unblock condition is a different
  upstream change; do not merge the two.

## Reproducing at HEAD without the patch

Cheapest deterministic form, from `packages/integration-tests` (roughly 1 in 1 to 3 in 4 runs
red — it is a routing race, so run it three times before calling it green):

```
npx vitest run --reporter=verbose control-db-two-node-convergence strand-addr-seed-convergence
```

Two measurement hazards worth knowing before re-running:

- **Adding logging can hide it.** `DEBUG=optimystic:*` slowed the run enough that the routing
  race stopped landing and the scenario went green. Attribute a green run carefully.
- **The stale-build guard will likely stop you first.** `../quereus` is under concurrent
  automation; its `src` gets touched while `tsc --incremental` emits nothing (content
  unchanged), so `dist/src/index.js` keeps an older mtime and the guard trips forever. After
  confirming `yarn build` is a no-op in `../quereus/packages/quereus`, `touch dist/src/index.js`
  clears it.
