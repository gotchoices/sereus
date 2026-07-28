----
description: Finishing the "outsiders can't even open the database conversation" hardening needs a small hook in the upstream Optimystic library, which lives outside this repository — until it exists, the database protocols rely on the connection-level gate alone.
files:
  - ../optimystic/packages/db-p2p/src/repo/service.ts (RepoService.handleIncomingStream — no authz seam)
  - ../optimystic/packages/db-p2p/src/cluster/service.ts, sync/service.ts, cluster/block-transfer-service.ts (same shape)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (createLibp2pNode options — where a node-level hook would thread)
  - packages/cadre-core/src/cadre-node.ts (createControlNode — where sereus would inject isAuthorizedMember once the hook exists)
  - packages/cadre-core/src/membership-connection-gater.ts (the connection-level layer that covers the gap meanwhile)
----

# Blocked: per-stream authorization hook for the Optimystic control-DB protocols

**Why blocked:** the change is in the `optimystic` repository (linked workspace,
not part of this monorepo). A human needs to either open the corresponding
ticket/PR there or decide the seam's shape with the optimystic maintainers.

## What is needed upstream

The membership hardening chain (step 6, `membership-connection-gater`) gates the
sereus-owned control protocols per stream (`/sereus/strand-wake/1.0.0` and
`/sereus/strand-addr/1.0.0` check `isAuthorizedMember` on every inbound stream)
and now also denies whole connections from positively-unauthorized peers. But
the protocols that actually carry database writes — the surface an outsider
would use to inject rows that replicate —

- `/optimystic/control-<party>/repo/1.0.0`
- `/optimystic/control-<party>/cluster/1.0.0`
- `/optimystic/control-<party>/sync/…`
- `/optimystic/control-<party>/block-transfer/…`

are registered inside `@optimystic/db-p2p`'s `createLibp2pNode` by services that
expose **no per-stream authorization seam**: `RepoService.handleIncomingStream`
(and its cluster/sync/block-transfer siblings) go straight from "stream opened"
to "decode and execute the operation". Sereus cannot wrap the handlers from
outside without re-implementing the protocol framing (explicitly ruled out).

**Requested seam (either works):**

- an optional per-service init option, e.g.
  `authorizeInboundStream?: (remotePeerId: string, protocol: string) => Promise<boolean> | boolean`,
  consulted at the top of each service's inbound stream handler (reject = abort
  the stream / error response, never execute the operation); or
- one node-level `createLibp2pNode` option threaded to all four services.

Fail-open must NOT be the default once a predicate is supplied: a supplied
predicate that returns false rejects the stream.

## Sereus-side wiring once the seam lands (bring this ticket back through the pipeline)

In `CadreNode.createControlNode`, pass the predicate
`(remotePeerId) => this.isAuthorizedMember(remotePeerId)` — the voucher-anchored
membership check — for the control network node only (strand cohort nodes are
cross-party and must NOT get it). Add an integration test: an unauthorized peer
that somehow holds a connection (e.g. admitted during an enrollment window)
still cannot execute a repo `pend`/`commit` against the control DB.

## Interim coverage (what holds the line today)

- Rows an outsider writes are **disbelieved at read time** (the voucher-anchored
  `isAuthorizedMember` predicate — chain step 4) — this is the primary fix.
- The connection gater denies an unauthorized peer's inbound control connection
  outright in the steady state, so reaching the repo protocol at all requires
  hitting an enrollment window, a formation-open node, or an un-enrolled node.
