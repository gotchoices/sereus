description: A machine that is connected to a cadre member but is not itself a member could be picked to hold that member's control-database writes. Control nodes now tell Optimystic exactly which peers are members, so outsiders are never chosen; a device redeeming an invitation is counted in only while the rows that admit it are written.
architecture: docs/architecture.md#per-stream-protocol-guard
files: packages/cadre-core/src/cadre-node.ts (isControlNetworkMember, authorizeInboundControlStream, buildControlNodeOptions isNetworkMember, admitRedeemingDevice / countAdmittingDevice, admittingDevices), packages/cadre-core/src/cadre-invite-protocol.ts (CadreInviteHandlerOptions.admitDevice, seatAndRedeem / admitDeviceIfLive), packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/test/cadre-invite-protocol.spec.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts, packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, packages/integration-tests/src/scenarios/cadre-invite-row-unreplicated.integration.ts, docs/architecture.md, .release-notes.pending.md
----
# Control nodes pass the membership predicate

## What landed

Optimystic chooses the peers that hold and coordinate a control block (its cohort) from the peers libp2p's peer store says serve the network, and any connected peer can fill that record by opening or advertising the party's protocols. Optimystic 1.13.0 added `NodeOptions.isNetworkMember(peerId) => boolean` (synchronous, fail-closed, read on every lookup). The control node now passes it:

- `CadreNode.isControlNetworkMember(peerId)` is the stream gate's rule without logging (refuse all while awaiting a claim; admit when not running / no DB, empty anchor, configured bootstrap infra, empty snapshot; otherwise only peers in the `authorizedControlPeers` snapshot). `authorizeInboundControlStream` calls it and logs the denial reason.
- `buildControlNodeOptions` passes `isNetworkMember: (peerId) => this.isControlNetworkMember(peerId) || this.admittingDevices.has(peerId)`. Strand nodes pass nothing.
- The invitation handler hook `catchUpDevice` became `admitDevice(peerId): Promise<() => void>`: `CadreNode.admitRedeemingDevice` counts the device in `admittingDevices`, pushes the control store, and returns a release that `CadreInviteHandler.seatAndRedeem` calls once the seat and the admission have settled. Without this, the redemption's writes committed on the member alone (the device must hold the rows that admit it), which broke `app-joins-cadre-by-invitation` and `cadre-invite-row-unreplicated` in the implement pass.
- Docs (`docs/architecture.md` → Per-stream protocol guard "Cohort choice", "Why the same rule, not a stricter one", "What it does not cover", "The snapshot"; connection gate "What provisional admission costs"; invitation enrollment step 9), the gater header, and a release note were updated. `blocked/stranger-joins-the-control-cohort-by-advertising-protocols` moved to `complete/` with a resolution note; FRET's ring is still upstream (Optimystic backlog `feat-fret-honours-the-network-membership-predicate`).

The code changes were committed under `tess: agent error on control-nodes-pass-the-membership-predicate — added resume note` (the interrupted first implement run); `ticket(implement): control-nodes-pass-the-membership-predicate` carried the ticket and release note. The `cadre-invite-row-unreplicated` flake that implement reported as pre-existing was resolved in place by the triage commit (a stale read in the test; recorded as one-off in `tickets/.pre-existing-known.md`).

## Review findings

**Checked.**
- Read the full code, test and doc diff before the handoff. Rule extraction: `isControlNetworkMember` returns exactly what the old `authorizeInboundControlStream` returned, branch for branch; both refusal log lines are kept. One rule serves both consumers; the admission table lives on one doc comment.
- Release lifecycle: `countAdmittingDevice` is idempotent per release and reference-counted for overlapping redemptions of one device; `admitRedeemingDevice` releases on a failed push and rethrows; `admitDeviceIfLive` turns any failure (liveness check or push) into a no-op release and logs it; `seatAndRedeem` releases in `finally`, so every path out of the writes (refusal, throw) ends the admission. No leak path found.
- Upstream semantics (read-only, `../optimystic/packages/db-p2p`): the predicate also gates coordinator choice and background pushes (spread-on-churn, restoration, ring-shift, under-replication drain), and a refused peer reads `foreign`. Redirect targets are followed without the predicate, which upstream records in its own `NOTE:`; harmless here because every Sereus control node applies the same predicate.
- Configured bootstrap infra is admitted by the predicate as by the stream gate. A bootstrap relay may already open repo and sync streams under the stream gate, so cohort inclusion exposes nothing new; not filed.
- Docs: every file the change touches, plus the `docs/architecture.md` sections named above and the gater header, describe the new behaviour. No stale reference to `catchUpDevice` / `catchUpRedeemingDevice` / `catchUpDeviceIfLive` remains outside archived tickets. `tickets/.garden-report.md` still lists the stranger ticket as blocked; that file is regenerated by gardening, so it was left alone.
- Tests: `control-stream-authz` step 5 is the reproduction and pays for itself. Re-verified this pass: with the `isNetworkMember` line removed and cadre-core rebuilt, the test fails at `expect(cohort).not.toContain(oPeerId)` (O in A's 3-peer cohort); restored, it passes. The `cadre-invite-protocol.spec.ts` change pins that the release comes after the device's rows are written, a real ordering contract of the new hook; kept. No test restates the implementation or verifies a mock; none cut. No unit test for the predicate wiring itself, correctly.

**Found and fixed inline (minor).**
- The window in which a redeeming device is in the cohort choice before it holds the store (the implementer's first reviewer note) was recorded only in the handoff. It is conditional and narrower than before this change (the device used to be in the cohort from connection onward), so it is now a `NOTE:` tripwire at `CadreNode.admitRedeemingDevice` naming the signal to revisit (retried control writes during redemptions) and the fix (a second set, counted only after the push resolves).

**Major / filed.** None; no finding met the filing bar.

**Tripwires.** The push-window note above (`cadre-node.ts`, `admitRedeemingDevice`). The FRET-ring gap already has a `NOTE:` at the end of `control-stream-authz` step 5 and a doc paragraph; nothing added.

**Considered, no action.**
- No control backfill on the member (`controlBackfill.enabled === false`): the device is never counted in, and the writes commit on the member alone and reach the device by ordinary replication. Strictly better than before (the device used to be in the cohort without the store, which tore the write). Untested; a test would exercise a configuration no shipped host uses.
- Snapshot staleness now also governs cohort choice: a member whose row arrives by replication is left out of this node's cohorts for up to one ~15 s reconcile pass. Documented in "The snapshot" and on `authorizedControlPeers`; the same bound the stream gate already had.

## Validation (review pass)

- `yarn workspace @serfab/cadre-core build`, cadre-core and integration-tests `typecheck`, `yarn lint`: clean, including after the comment edit.
- `yarn workspace @serfab/cadre-core test`: 170 files, 2471 passed, 1 skipped.
- Integration: `control-stream-authz`, `cadre-invite-row-unreplicated`, `cadre-invite-any-member`, `app-joins-cadre-by-invitation`: 5 of 5 tests passed.
- Negative check: `control-stream-authz` with the predicate removed fails as described above.
