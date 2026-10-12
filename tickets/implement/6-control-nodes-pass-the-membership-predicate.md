description: A machine that is not a cadre member but is connected to one can currently be picked to hold that member's control-database writes. Control nodes will now tell Optimystic exactly which peers are members, so outsiders are never chosen.
architecture: docs/architecture.md#per-stream-protocol-guard
files: packages/cadre-core/src/cadre-node.ts (authorizeInboundControlStream ~2552, buildControlNodeOptions ~2140, authorizedControlPeers ~605, refreshMembershipGate ~8361), packages/integration-tests/src/scenarios/control-stream-authz.integration.ts (step 5 and its NOTE ~288, file header), packages/integration-tests/src/harness/control-cohort.ts (readCohort), docs/architecture.md (Per-stream protocol guard → "What it does not cover", "Proof"; the connection-gate "What provisional admission costs" paragraph ~901), tickets/blocked/stranger-joins-the-control-cohort-by-advertising-protocols.md, ../optimystic/packages/db-p2p/src/network-membership-gate.ts (read-only), ../optimystic/docs/internals.md § Network Membership Predicate (read-only)
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-10-12T08:35:31.906Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\6-control-nodes-pass-the-membership-predicate.implement.2026-10-12T08-35-31-905Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
# Control nodes pass the membership predicate

## Background

Optimystic picks the peers that hold and coordinate a block (the block's *cohort*) from the peers it believes serve the network, and it decides that from the protocol list libp2p's peer store records for each peer. Any connected peer can fill that list: opening a stream on a protocol records it before the handler lookup (so even a stream the Sereus protocol guard resets has already written it), and a peer can also advertise the protocols through identify. The blocked ticket `stranger-joins-the-control-cohort-by-advertising-protocols` measured the result: after an outsider probed every members-only protocol, the owner's `findCluster` for a control block returned `[outsider, member, owner]`.

Optimystic main (`1b352916`, linked here through root `resolutions`; the linked `dist` already exports it) added the fix as `NodeOptions.isNetworkMember?: (peerId: string) => boolean` (`packages/db-p2p/src/network-membership-gate.ts`). Its contract, from the source and `docs/internals.md` § Network Membership Predicate:

- Synchronous, in-memory. A promise is a refusal.
- Fail closed: only a literal `true` admits; `false`, a throw or anything else refuses (a throw or non-boolean is logged under the `network-membership` namespace).
- Self is always a member; the predicate may list remote members only.
- **Read live on every lookup — no verdict is cached, so there is no "reclassify this peer" hook to call.** `refreshMembershipGate` therefore needs no change: replacing `authorizedControlPeers` is the re-evaluation. A newly admitted member counts on the next cohort lookup; a removed one drops out of it.
- It gates every cohort and coordinator choice (`membershipOf`, `isSelectable`, the coordinator cache re-check) and the four background senders that take peers from FRET (spread-on-churn, ring-shift confirm, restoration, under-replication drain).
- It does **not** gate FRET's own ring membership (Optimystic backlog `feat-fret-honours-the-network-membership-predicate`), dispute arbitrators (off by default; Sereus does not enable disputes), or redirect targets.

The `@optimystic/db-p2p` floor (`^1.12.1`, the linked tree's version too) is not bumped here; the bump comes with the Optimystic release.

## Design

One decision function, two consumers. Extract the body of `authorizeInboundControlStream` into a synchronous, non-logging `isControlNetworkMember(remotePeerId: string): boolean`:

```ts
// The membership rule the control node applies to a peer, without logging: the per-stream
// guard (authorizeInboundControlStream) and Optimystic's cohort choice (isNetworkMember).
private isControlNetworkMember(remotePeerId: string): boolean {
  if (this.isAwaitingClaim()) return false;
  if (this.admitControlPeerUnconditionally(remotePeerId)) return true;
  return this.authorizedControlPeers.size === 0 || this.authorizedControlPeers.has(remotePeerId);
}
```

- `authorizeInboundControlStream(remotePeerId, protocol)` calls it and, on `false`, logs the existing two denial lines (pick the awaiting-claim line when `isAwaitingClaim()`, else the "not in the materialized authorized set" line). Its doc comment keeps the admission table; move the table to whichever function owns the rule and point the other at it — one copy, not two.
- `buildControlNodeOptions` adds `isNetworkMember: (peerId) => this.isControlNetworkMember(peerId)` next to `authorizeInboundStream`, with a short comment: who this node *sends to* (cohort choice), where `authorizeInboundStream` is who may send to it. No logging inside the predicate — Optimystic calls it several times per peer per cohort assembly, and refused peers already show as `refused=` on Optimystic's `cohort:membership` debug line.
- Strand nodes (`strand-instance-manager.ts`) pass nothing: their peers are legitimately cross-party. No change there.
- No change to `refreshMembershipGate` / `refreshAuthorizedControlPeers` (see "Read live" above). Update the `authorizedControlPeers` doc comment to say it now also backs Optimystic's `isNetworkMember`.

Why the same rule rather than a stricter one: the stream gate's unconditional admissions are what let a joining node replicate before it can judge anyone. A predicate that refused peers while the anchor or the snapshot is empty would give a joiner a self-only cohort; Sereus builds the control node with `bootstrapNodes: []`, so Optimystic's "refused bootstrap peer is not yet heard from" guard does not apply, and a joiner that opened a collection then would rule it absent and found a second copy (a fork). Mirroring the stream gate keeps the outbound choice exactly as permissive as the inbound acceptance, which the system already depends on.

## Edge cases & interactions

- **Joining node, empty anchor or empty snapshot (replication cold start).** Predicate admits everyone, as today, so the joiner's cohort includes its inviter. Verified by inspection (same function as the stream gate) and by every existing join scenario staying green.
- **Snapshot non-empty but missing a genuine member whose row arrived by replication.** That member is left out of this node's cohorts until the next refresh (≤ one reconcile pass, ~15 s); the stream gate already refuses its inbound streams for the same window. Accepted bounded staleness, same as the stream gate's. Verified by inspection; state it in the architecture doc's snapshot paragraph.
- **Locally admitted member** (`authorizePeer`, invitation redemption, formation). The row write notifies `refreshMembershipGate`, so the next cohort lookup includes it. Verified by the existing `control-stream-authz` step 1 (M's pend succeeds) and the cadre join scenarios.
- **Removed member.** Drops out of the snapshot at the next refresh, so it stops receiving this node's control writes — a side benefit. No new test.
- **Node awaiting a claim.** Predicate refuses everyone → self-only cohort. It already refuses everyone's control streams and builds its control database with zero connections, so nothing it does depends on a peer cohort; after the claim anchors an owner key the predicate admits (empty snapshot) on the next lookup. Verified by the existing `node-claim-by-phone` scenario staying green.
- **Configured bootstrap/relay infrastructure.** Admitted unconditionally, as on the stream gate. Harmless: a relay does not serve the party's `cluster`/`repo` protocols, so Optimystic still classifies it `foreign`.
- **Before `start()` completes / after teardown** (`!_running || !controlDatabase`). Admits, as today. Optimystic may classify peers during bring-up; there are no control connections then.
- **Delegates** (a member's strand node holding a connection/relay grant) and **a redeeming device** before its row exists: refused, correctly — neither is a control-database member. The redeeming device's catch-up push goes through `PeerJoinBackfill`, which dials via `IPeerNetwork.connect` and is not gated by `isNetworkMember`, so redemption is unaffected.
- **FRET ring still counts the outsider `member`** (the FRET half is upstream backlog). It may take one of Optimystic's over-fetch slots a cohort is cut from; with `CONTROL_REPLICATION_BREADTH` 16 and parties far smaller, no member is crowded out. Record this in the doc's "What it does not cover"; when `feat-fret-honours-the-network-membership-predicate` ships, re-check that FRET no longer marks the outsider `member`.
- **Phone kit (`cadre-rn`) and reference apps** build their control node through `CadreNode`, so they get the predicate with no change.

## Test (the reproduction)

Extend `control-stream-authz.integration.ts`, first case, step 5. After the probes and the delegate assertion, replace the NOTE with:

- **Cohort excludes the outsider.** `readCohort(A.getControlNode()!, 'owner')` (harness `control-cohort.ts`) does not contain `oPeerId`, and does contain `mPeerId` (positive control: the cohort is populated). If the cohort read is racy against FRET, wait for M with `waitForCohortOn(A.getControlNode()!, 2, …)` first, then assert O's absence.
- **No cluster request reaches the outsider.** Before step 5's probes, register on O's control node a handler for A's cluster protocol (`${protocolPrefix}/cluster/1.0.0`) that counts inbound streams and aborts them. Registering it also makes O *advertise* the protocol through identify, so the scenario covers both ways in. After the probes, have A make a control write (e.g. `A.authorizePeer(<fresh peer id>)`), await it, and assert the count is 0. O's own protocol guard treats that protocol as unclassified (one `console.warn`) and admits A, since O has no trusted-owner anchor — so the handler does run when A dials.
- **Confirm it is a reproduction.** Run the scenario once with the `isNetworkMember` line removed: the cohort assertion must fail (O present), and the cluster-request count should be > 0. If the count stays 0 without the predicate, the counter is not observing what it claims — investigate (A's write may stall or fail when its cohort includes O; bound the wait, don't depend on the write succeeding in that run) before relying on it. Restore the line. Record the observed pre-fix result in the review handoff.
- Update the file header's step 5 description and the "Party membership also keeps it out of the owner's cluster cohort" paragraph, which now holds because of the predicate, not protocol scoping alone.

No new unit test: the predicate is the stream gate's rule through one function, and the option wiring is glue.

Run: `yarn workspace @serfab/integration-tests test src/scenarios/control-stream-authz.integration.ts` in the foreground (no redirection), then the cadre-core unit suite, `yarn lint` and the typecheck. Check `docs/testing.md` for the stale-build guard; if it reports a sibling's `dist` stale, stop and record it — never build the sibling.

## TODO

- Extract `isControlNetworkMember` from `authorizeInboundControlStream`; keep the denial logging in the stream gate; move the admission table to one doc comment.
- Pass `isNetworkMember` in `buildControlNodeOptions`; update the `authorizedControlPeers` doc comment.
- Extend `control-stream-authz` step 5 (cohort exclusion + zero cluster requests), replace its NOTE, update the file header; verify both assertions fail without the predicate, then restore.
- Update `docs/architecture.md`: "What it does not cover" (cohort now excluded via `isNetworkMember`; FRET ring still counts the stranger, upstream backlog), "The snapshot" (it also backs `isNetworkMember`; the bounded-staleness consequence now covers cohort choice), "Proof", and the connection-gate "What provisional admission costs" sentence (~line 901) that says the stranger is counted into the cohort.
- Move `tickets/blocked/stranger-joins-the-control-cohort-by-advertising-protocols.md` to `tickets/complete/` with a short note pointing at this ticket (`control-nodes-pass-the-membership-predicate`), stating the FRET-ring half remains upstream.
- Run the scenario, cadre-core tests, lint and typecheck.
