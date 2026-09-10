----
description: Give each shared-workspace network node a gate that refuses machines belonging to a removed party, so removal starts meaning "we stop talking to you" instead of only deleting a record.
files: packages/cadre-core/src/strand-revocation-enforcer.ts (new), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/membership-connection-gater.ts (model only), packages/cadre-core/src/strand-membership-writer.ts, schemas/strand.qsql (read only), packages/cadre-core/test/
difficulty: hard
----

# Strand revoked-peer gate

First of three tickets implementing `plan/4-removal-must-cut-the-network-not-just-the-row`
(answering gotchoices/sereus#4; owner ruling 2026-09-09: enforcement is at the connection
and stream layer — remaining members stop answering and stop dialing a removed party's
nodes). This ticket builds the gate; `strand-revocation-teardown` adds active teardown of
already-open connections; `strand-removal-e2e-and-docs` proves it end to end and updates
the docs.

## Settled design (do not re-open; the plan pass resolved these)

**The deny set is revocation-keyed, never membership-keyed.** A strand node maintains a
materialized in-memory set of **revoked peer ids**: every `Strand.MemberPeer.PeerId` whose
`MemberKey` has **no live `Strand.Member` row**. `MemberPeer.MemberExists` runs on insert,
so an orphaned binding can only mean "this member existed and was removed" — it is exactly
the durable, replicated record of a removed party's machines. Everything not in the set is
admitted. Consequences, each deliberate:

- **Open strands (`Type='o'`) are untouched.** `Member`/`MemberPeer` carry `OnlyClosed`
  checks, so an open strand has no rows and the set is empty. Additionally, skip arming the
  enforcer entirely when `strandRow.Type !== 'c'` — no pointless polling.
- **A joining party mid-admission is admitted.** It has no orphaned binding. An allowlist
  ("only peers bound to live members") was considered and rejected: a joiner's first
  membership writes must travel through the very cohort an allowlist would close to it —
  the same mutual-denial trap the control network's gater doc describes, with no enrollment
  window to carve out. Deny-list on positive evidence has no such trap.
- **Stale-view failure direction (plan TODO 3): fail-open.** A remaining member that has
  not yet replicated the revocation keeps serving the removed party until the tombstoned
  state arrives — bounded by replication, consistent with "revocation is forward-looking".
  The opposite error (denying a legitimate member) is only reachable for a
  revoked-then-re-admitted party at a node that saw the revoke but not the re-add; the
  re-add gives the member key a live `Member` row again, which removes its peers from the
  deny set as the row replicates — and the re-adding manager's own node updates first, so
  the heal path never depends on talking to the peer being wrongly denied. Self-healing;
  no partition risk for members who were never revoked.
- **Orphaned `MemberPeer` rows are load-bearing (plan TODO 6): do NOT tombstone them at
  revocation, do NOT auto-clean them.** They ARE the deny record. The manager-cleanup path
  (`removeMemberPeer`'s manager branch) stays — it is the only way to clear a
  wrongly-registered binding — but clearing an orphan now also forgets the denial (the
  `Revocation` tombstone keeps only the stamp, not the peer id). Add a `NOTE:` at the
  manager-remove branch in `strand-membership-writer.ts` saying exactly that, and the docs
  ticket says it in `docs/strands.md`.

**What transfers from `membership-connection-gater.ts` and what does not (plan TODO 1):**

- Transfers: the two-layer shape (fail-closed per-stream gate as PRIMARY, opportunistic
  connection-level deny on top), the synchronous in-memory snapshot judged by the stream
  gate (a live DB read inside a gate deadlocks — same argument as the control node's),
  the fail-open-on-error/timeout posture for the connection hooks
  (`decideWithinDeadline` is reusable as-is), and the "compose over the caller's gater,
  every base hook preserved" mechanics including the spread-vs-class-instance caveat.
- Does NOT transfer — the relay-reservation seam (`'admit-for-relay'` + the unauthorized
  budget). That machinery exists because the control gate denies on ABSENCE of placement,
  where a member whose row is in flight is indistinguishable from an outsider and a wrong
  reservation deny is unrecoverable. This gate denies on POSITIVE revocation evidence, so
  a reservation deny is never that kind of wrong answer; the one stale-wrong case
  (missed re-add) heals via replication as above. So `denyInboundRelayReservation` here is
  a plain "deny iff revoked" — no budget, no admit-for-relay verdict, no reserve deadline.
- Does NOT transfer — the bring-up quiet period. A strand node's DB bring-up NEEDS its
  cross-party cohort connections; the enforcer simply starts with an empty snapshot
  (admit everything) until its first successful read. Fail-open during bring-up is the
  same posture as everywhere else here.
- Does NOT transfer — every stranger carve-out (enrollment window, formation window,
  delegate grants). None of those protocols exist on a strand node.

**Unlike the control stream gate, no empty-snapshot carve-out is needed**: an empty deny
set means "nothing revoked", which correctly admits everyone — the deny-list shape makes
the cold-start case and the steady case the same code path.

## What to build

A new per-strand component, `StrandRevocationEnforcer` (new file
`strand-revocation-enforcer.ts`), owned by `StrandInstanceManager` with the same lifecycle
pattern as `PeerJoinBackfill` (private map keyed by strand id; created in
`buildStrandRuntime`, stopped and dropped in `releaseRuntime`, so quiesce → resume rebuilds
it with a fresh snapshot):

1. **Snapshot.** `revokedPeerIds: Set<string>`, refreshed by reading the strand DB:
   full-scan `select MemberKey, PeerId from Strand.MemberPeer` and
   `select Key from Strand.Member`, join in JavaScript (the composite-PK point-lookup
   unreliability documented at `scanMemberPeers` in `strand-membership-writer.ts` applies —
   scan and filter in JS, never seek). Refresh on an interval (new constant, default 30 s;
   configurable via a `revocationEnforcement?: { pollIntervalMs?: number; enabled?: boolean }`
   knob on `StartStrandConfig`, threaded from `CadreNodeConfig` the way `backfill` is) plus
   a public `refresh(): Promise<void>` for on-demand use. A failed or slow read KEEPS the
   previous snapshot, never clears it (control model, `refreshAuthorizedControlPeers`).
   Serialize refreshes (no two in flight).
2. **Per-stream gate.** A synchronous predicate `authorizeStream(remotePeerId, protocol)`
   returning `false` iff the peer is in the snapshot, wired as
   `createLibp2pNode({ authorizeInboundStream })` in
   `strand-instance-manager.ts`'s `buildStrandRuntime` — the option exists upstream
   (`db-p2p`'s `libp2p-node-base.ts`) and gates all four
   `/optimystic/strand-<id>/{repo,cluster,sync,block-transfer}` protocols. This is the
   fail-closed primary layer: it also catches a revoked peer that arrives over a RELAYED
   connection or over a connection admitted before the revocation replicated.
3. **Connection gater composition.** A `createRevocationConnectionGater(enforcer, base?)`
   composing onto the caller-supplied `config.network?.connectionGater` (which
   `buildStrandRuntime` currently threads through raw — this replaces that thread for
   closed strands only):
   - `denyInboundEncryptedConnection`: deny iff revoked (bounded by
     `decideWithinDeadline`-style timeout, fail-open — snapshot reads are sync so this is
     belt-and-braces).
   - `denyDialPeer`: deny iff revoked — the owner ruling covers "communicated with", not
     just "answered to", and refusing the dial locally is instant, which is what keeps
     Optimystic from wasting a dial timeout on a peer we will not talk to.
   - `denyInboundRelayReservation`: deny iff revoked (matters when the strand node runs
     the relay server — the storage-profile default).
   Every base hook preserved; deny from either denies.
4. **Update `types.ts`** `NetworkConfig.connectionGater` doc ("strand cohort nodes receive
   this gater as-is" is no longer true for closed strands) and the module doc note at the
   bottom of `membership-connection-gater.ts` ("Control node only") to point here.

Keep the enforcer pure/injectable enough to unit-test without a libp2p node: inject the
row-reading function and the clock, mirror the testing seams of
`UnauthorizedReservationBudget` / `DelegateAdmissionStore`.

## Production reality this ticket does not change

In production, formation hands every party the same `MemberPrivateKey`, so a real closed
strand today holds ONE founding `Member` row and nothing registers `MemberPeer` rows at
all (`backlog/feat-strand-party-identity`, steps 1–2, owns fixing both). Until that lands,
this gate is exercised by tests (which mint distinct member keys and call
`registerMemberPeer`, as the membership e2e already does) and is inert on production
strands — an empty deny set admits everyone, which is exactly today's behavior. Do NOT
absorb the identity work here; the machinery is independent of it and testable without it.

## Edge cases & interactions

- **Multi-machine removed party**: every orphaned binding under the removed key lands in
  the set — the set is derived per-binding, not per-member; test with two peer ids under
  one revoked key.
- **Removal racing a join**: a party revoked while a machine is mid-admission never gets
  its `MemberPeer` insert committed (`MemberExists` fails), so that machine is unknown, not
  revoked — it is admitted at the gate but can write nothing that RBAC gates. Same standing
  as any stranger who finds a closed strand today; network-level stranger gating is out of
  scope (noted in `feat-strand-party-identity`).
- **Self-departure (`leaveStrand`)**: produces the same orphaned bindings, so the same
  enforcement applies — deliberately identical to manager revocation; remaining members'
  behavior must not differ by exit path. Assert in a unit test.
- **Revoked-then-re-admitted**: re-admission mints a fresh `Member` row for the same key →
  the key has a live row again → its old bindings stop being orphans → peers leave the set
  on the next refresh. Test this transition (deny, then re-admit, then admit).
- **A peer id bound to TWO member keys** (composite PK allows it): revoked under one key,
  live under another → the live binding wins (a machine serving a live member must not be
  cut). Set membership = "has at least one orphaned binding AND no live-membered binding".
  Test it.
- **Refresh failure / unreadable DB**: previous snapshot retained; never fail closed on an
  error; log.
- **Quiesce → resume**: enforcer rebuilt, snapshot starts empty, first refresh repopulates
  — a revoked peer gets a short admit window per resume at the connection level, but the
  per-stream gate refreshes before any stream does damage only after that same first read;
  accept and document (fail-open posture), don't block resume on a refresh.
- **Both parties revoke each other from divergent views**: each side's set gains the
  other's peers; on a two-party strand this is a permanent mutual cut — converged enough,
  both wanted out. No special handling; name it in a test comment if convenient.
- **Embedder-supplied gater**: its verdicts still honored on every hook (compose, don't
  replace); RN/web permissive gaters (`denyDialMultiaddr: () => false`) must keep working.

## Tests this must produce (unit; the real-network proof is the e2e ticket)

- Snapshot derivation: orphan → denied; live member's peer → admitted; open strand /
  empty tables → empty set; two-key peer → admitted; re-admission clears.
- Gater composition: base-gater deny honored; enforcer deny honored; error in either →
  fail-open; base hooks preserved.
- Stream predicate: sync, denies exactly the snapshot, admits when snapshot empty.
- Wiring: `buildStrandRuntime` passes `authorizeInboundStream` + composed gater for
  `Type='c'` and does NOT arm either for `Type='o'` (follow the pattern of
  `cadre-node-control-node-options.spec.ts` for options-level assertions).
- Refresh: serialized; failure keeps previous snapshot; interval honored (injected clock).

## TODO

- [ ] `strand-revocation-enforcer.ts`: snapshot + refresh loop + sync predicate + gater
      composition, with a module doc recording the settled design above (deny-list
      rationale, fail direction, what did not transfer from the control gater and why).
- [ ] Wire into `buildStrandRuntime` (closed strands only) with `PeerJoinBackfill`-style
      lifecycle; thread the config knob.
- [ ] `NOTE:` at `removeMemberPeer`'s manager branch: clearing an orphaned binding forgets
      the network denial of that peer id; only do it for a binding that should never have
      existed or a peer that is truly gone.
- [ ] Doc-comment updates in `types.ts` and `membership-connection-gater.ts`.
- [ ] Unit tests per the list above.
- [ ] `yarn lint` + affected package tests green.
