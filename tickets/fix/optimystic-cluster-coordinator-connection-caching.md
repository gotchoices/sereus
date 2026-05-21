---
description: The in-line broadcast retry added in `web-e2e-tier2-consensus-broadcast-race` opens a fresh `ClusterClient` via `createClusterClient(peerId)` on every attempt. If the underlying libp2p connection is what broke (e.g. relay reservation expired between commit-phase and broadcast-phase), opening a *new* stream on the *same broken connection* will keep failing. The commit phase against that same peer just succeeded a few ms earlier, so a prior-phase-validated connection is known to work; reusing it (or at least preferring it over a cold dial) might recover where the current code can't.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/cluster-client.ts
---

## Problem

`broadcastMergedRecord` in `cluster-coordinator.ts:562` calls `this.createClusterClient(peerIdFromString(peerIdStr)).update(record)` on every attempt. Each call constructs a fresh client and is free to open a fresh stream over a fresh dial. There is no signal carrying which connection succeeded for the commit phase a few ms earlier, even though that connection is by far the most likely to still work.

The browser trace from the Tier 2 e2e shows `cluster-tx:commit-majority-reached` followed within ~5 ms by `cluster-tx:consensus-broadcast-error` against peers that just sent successful commit responses. The commit-phase success → broadcast-phase failure gap is short enough that the connection itself is the likely failure unit, not the dial-up of an unrelated peer.

## What to research

- Whether `createClusterClient` already caches the libp2p connection layer (it probably does at the libp2p level — connections are reused across streams by default) or whether each call does a fresh dial.
- If connections are reused, is the failure mode actually a stream-open failure on a still-open connection? If so, what's the connection-layer signal that the connection is dead, and how fast does libp2p surface it.
- Whether a "warm connection from the most recent successful commit-phase RPC" is already in the connection manager and the dialer is correctly preferring it.
- Whether forcing the broadcast to reuse a connection that was used for a successful commit-phase RPC (by stashing the connection in `ClusterTransactionState` between phases) is feasible without leaking libp2p internals into the coordinator.

## Expected behavior

A `cluster-tx:consensus-broadcast` attempt against a peer that successfully responded to `cluster-tx:commit` in the same transaction window should reuse the same libp2p connection. Only fall back to a fresh dial if the connection is observably closed.

## Acceptance

- A targeted unit/integration test that confirms broadcast reuses the commit-phase connection (or, if libp2p already does this transparently, document why this ticket is a no-op and close it).
- Trace from a Tier 2 e2e run shows the per-peer commit → broadcast latency dropping (no fresh dial overhead on the broadcast).

## Context

Spawned during review of `web-e2e-tier2-consensus-broadcast-race`. Lower priority than the read-repair and relay-reservation follow-ups — those address the underlying network issue, this one is a coordinator-layer optimization that only helps if libp2p doesn't already do this for us.
