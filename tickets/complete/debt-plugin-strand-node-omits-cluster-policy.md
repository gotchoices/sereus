----
description: The SQL package can create a workspace's networking node by itself, and when it does it forgets to pass one of the replication settings the same package defines for exactly that purpose — so the automatic repair of damaged data uses the wrong threshold for small groups.
prereq:
files: packages/quereus-plugin-sereus/src/connect.ts, packages/quereus-plugin-sereus/src/connect-browser.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/quereus-plugin-sereus/src/compose-strand.ts
tradeoffs: The one field that actually differs only moves the read-repair corroboration floor, and no shipped configuration reaches this code path — every Sereus app injects a node built by cadre-core with the correct policy — so this is a latent inconsistency in a dormant path rather than a live defect.
----

> **DONE 2026-08-25 — resolved in `composeStrand`, which is the option this ticket preferred.**
>
> `CreateNodeContext` gained a required `clusterPolicy` field, `composeStrand` fills it with
> `STRAND_CLUSTER_POLICY` next to the existing `resolveStrandClusterSize` call, and both platforms
> (`connect.ts`, `connect-browser.ts`) forward it to `createLibp2pNode`. Because the field is
> required rather than optional, a third platform cannot forget it — it will not compile.
>
> Pinned by a test rather than left to the `satisfies`: `plugin.spec.ts` →
> *"should create the node with the strand cluster policy"* asserts `createLibp2pNode` is called
> with the policy object, which covers the whole seam (composeStrand → platform → node) rather than
> just the context. The existing mock of `createLibp2pNode` in that file made this cheap, as the
> ticket predicted.
>
> Verified: `yarn lint` and the package `typecheck` exit 0; `@serfab/quereus-plugin-sereus` suite
> 9 files / 90 passed + 1 todo.
>
> One correction to the framing above. The ticket calls this "a latent inconsistency in a dormant
> path rather than a live defect", which was true of shipped apps and is worth keeping in view — but
> the path stopped being dormant when `retire-strand-mode-in-cadre-core` moved this package's own
> e2e specs onto the factory, which is how it was found. So the specs that exercise it were already
> running against the wrong corroboration floor.

# `connectToStrand` creates strand nodes without `STRAND_CLUSTER_POLICY`

## The two node factories disagree

A strand's libp2p node gets created in one of two places:

- **`cadre-core`** (`packages/cadre-core/src/strand-instance-manager.ts:307-336`) passes
  `clusterPolicy: STRAND_CLUSTER_POLICY` explicitly, with a comment saying why it is deliberately not
  the control network's policy.
- **the SQL package itself**, when `connectToStrand` / `connectToStrandBrowser` is called with no
  injected node (`packages/quereus-plugin-sereus/src/connect.ts:28-35`,
  `connect-browser.ts:45-55`). These pass `clusterSize` but **no `clusterPolicy`**, so Optimystic's
  defaults apply.

`STRAND_CLUSTER_POLICY` is defined in that same package
(`packages/quereus-plugin-sereus/src/cluster-size.ts:216-219`) and documented as the strand policy.
Its own factory not using it is the inconsistency.

## What actually differs

Read against `@optimystic/db-p2p`'s defaults (`packages/db-p2p/src/libp2p-node-base.ts:630`):

| field | `STRAND_CLUSTER_POLICY` | Optimystic default | differs? |
|---|---|---|---|
| `allowDownsize` | `true` | `true` | no |
| `sizeTolerance` | `0.5` | `0.5` | no |
| `assumedClusterSize` | `MIN_CLUSTER_SIZE` (2) | not set → falls back to `clusterSize` | **yes** |

So a solo or small-cohort commit behaves the same either way — the downsize fields match. The
difference is `assumedClusterSize`, which feeds Optimystic's read-repair / reconcile corroboration
floor. Absent it the floor is computed against `clusterSize` (4 by default for a strand), which is a
stricter requirement than the two-machine floor the field is there to declare. The reasoning for
declaring it is written out at `cluster-size.ts:80-95` for the control network's equivalent.

Effect, stated as the read rather than as a measurement: on a small strand created through the SQL
package's own factory, automatic repair of a damaged block may be unable to gather enough
corroborators and give up where it would otherwise succeed. Not verified by running anything.

## Why it is dormant

Every Sereus application reaches a strand through `cadre-core`, which **injects** a node it built
itself — so `compose-strand.ts`'s `platform.createNode` seam is never taken on that path
(`compose-strand.ts:211-232`). The factory is reached only by a direct
`connectToStrand`/`connectToStrandBrowser` caller with no node: this package's own e2e specs, and any
outside consumer using the SQL package standalone.

Found while planning the strand-mode retirement (`tickets/complete/` →
`retire-strand-mode-in-cadre-core` and its siblings), which moved those e2e specs onto the network
transactor and therefore onto this factory for the first time.

## Shape of the fix

Pass `clusterPolicy: STRAND_CLUSTER_POLICY` from both `createNode` implementations, or — better, since
the seam is shared — resolve it once in `composeStrand` alongside `resolveStrandClusterSize`
(`compose-strand.ts:151`) and hand it to the platform in `CreateNodeContext`, so a third platform
cannot forget. Whichever way, the `satisfies` on the policy constant is what keeps a mistyped field
from compiling.

Worth a test only if the resolution moves into `composeStrand`: then one assertion that the context
handed to a fake `createNode` carries the policy is cheap and prevents the regression.
