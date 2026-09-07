----
description: When a shared workspace's data needs repair, a machine should only trust an answer confirmed by enough of the machines that actually host that workspace. We currently have no trustworthy count of those machines, so workspaces fall back to a weaker check; build that count and use it.
prereq: bug-strand-yardstick-counts-party-machines
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/strand-member-registry.ts, schemas/strand.qsql, schemas/control.qsql, docs/architecture.md
difficulty: hard
tradeoffs: The exposure this closes (a lagging machine trusting a single possibly-stale peer) is already tracked for an upstream Optimystic fix (debt-read-repair-single-voter-corroboration) that would make this derivation mostly redundant, and it only benefits workspaces served by three or more machines — a maintainer may reasonably wait for the upstream fix instead.
----

# Derive the strand repair yardstick from machines that serve the strand

## Background

Optimystic trusts a block-repair answer only when enough independent holders corroborate it,
measured against a **declared** count (`clusterPolicy.repairCorroborationClusterSize`) rather
than the currently-visible peers, because the visible set comes from unauthenticated routing.
The control network derives its declaration from the party's enrolled machines (every enrolled
machine runs the control node, so the party count is the serving count — see
`controlClusterPolicy` and `enrolled-machine-store.ts`). Strand nodes declare **nothing**:
`bug-strand-yardstick-counts-party-machines` established that the party count over-declares a
strand served by a subset of the party — which makes repair *impossible* (`cluster-fetch:no-quorum`)
instead of merely weak — and removed the derivation. Declaring nothing leaves strands with the
known single-voter exposure (`backlog/debt-read-repair-single-voter-corroboration`): a node
that can see only one peer accepts that peer's possibly-stale answer as truth.

The plumbing is ready and waiting: `StartStrandConfig.servingMachines` /
`ResumeStrandOverrides.servingMachines` thread a count into `strandClusterPolicy`, which clamps
it correctly (`resolveRepairYardstick`). What is missing is a trustworthy **source** for
"machines serving THIS strand".

## What the fix-stage research established

- **The right record already exists in the schema but is never written.** The strand
  database's `MemberPeer` table (`schemas/strand.qsql`) is machine-level (MemberKey, PeerId),
  member-signed, and removable — exactly the authenticated serving roster needed. But the
  `registerMemberPeer` writer (`strand-member-registry.ts`) has no production caller: neither
  `CadreNode` nor any reference app registers a peer binding when a machine joins a strand.
  Making `MemberPeer` authoritative means wiring registration into the join/launch lifecycle
  first — and deciding which peer id it records (the strand transport peerId is derived
  per-strand from the cadre identity key; see `strand-transport-key.ts`).
- **Open strands (`Type = 'o'`) can never use it**: `Member`/`MemberPeer`/`Manager` all carry
  `OnlyClosed` constraints. Open strands would keep declaring nothing (or need
  `backlog/feat-open-strand-witness-policy`, which owns the open-strand trust question).
- **The count is needed before it can be read.** The declaration is frozen when the strand's
  libp2p node is built, and the `MemberPeer` rows live inside the database that node serves.
  The established break for this chicken-and-egg is the remembered-count pattern
  (`enrolled-machine-store.ts` for the control network): record the count from the strand's
  own rows while it runs, read it back at the next launch/resume. A strand rebuilds many
  times a day (hibernation wake), so a one-rebuild-stale count converges quickly, and a count
  read from signed rows can go DOWN when a machine leaves — unlike a high-water mark of
  observed connections, which was considered and rejected (over-declaring is the unsafe
  direction; a monotone count recreates the original bug after a machine leaves the strand).
- **The alternative source** is a per-strand participation record on the **control** database
  (written when a machine joins a strand, readable by every party machine before the strand
  node exists). Strictly more capable — covers the "first launch after restart" window the
  remembered count misses — but requires a new signed, authorization-gated table in
  `schemas/control.qsql`, whose every table carries stamp-retirement and owner-signature
  machinery; substantially more design surface. Weigh at plan stage; the remembered
  `MemberPeer` count is the smaller path.

## Requirements for whatever shape lands

- The declared value must never exceed the machines that can serve the strand — the safety
  property named in the original bug. A property-style test should pin it at the seam where
  the count is produced.
- The count must be able to decrease after a machine genuinely leaves the strand.
- A node that does not know declares nothing (today's behavior), never a guess.
- Cross-platform: any persistence must ride the existing app-supplied `DurableSlot` idiom
  (browser, RN, Node all inject their own backends today).
