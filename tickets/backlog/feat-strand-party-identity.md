----
description: A shared workspace cannot tell which of its machines belong to which person. Until it can, it cannot spread copies across different people, cannot require two different people to witness a change, and cannot turn a stranger's machine away.
files: schemas/strand.qsql, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, docs/strands.md
difficulty: hard
----

# A strand has no idea which machines belong to which party

## The gap

A strand is a workspace shared between parties, and every party runs several machines — a phone,
a laptop, a home server. Inside the strand there is nothing that says "this machine is Alice's".
Machines are just peer ids.

The schema for it exists and is unused. `Strand.MemberPeer(MemberKey, PeerId)` in
`schemas/strand.qsql` is exactly this binding — a member (a party) claiming a machine, with the
member's own signature on it, replicated to every machine on the strand, and refused unless a
live `Strand.Member` row backs it. Writers exist and are exported
(`registerMemberPeer` / `listMemberPeers` / `removeMemberPeer` in
`packages/cadre-core/src/strand-membership-writer.ts`). **No production code calls any of
them** — the only callers are tests. `packages/cadre-core/src/strand-transport-key.ts` says so
outright: "production code simply never writes one."

The layer above it is equally empty. In production a closed strand ends up with exactly one
`Strand.Member` row: the founding one, derived from the control-layer `Strand.MemberPrivateKey`
— which strand formation hands to *every* party that joins (`docs/strands.md` → "Closed-Strand
Member Key Handling"). So every party on a production closed strand currently presents the same
member identity. Per-party member keys are minted only in tests, through `consumeInvite` /
`addMemberByManager`.

## What it costs

Three separate capabilities are stuck behind this one missing fact.

- **Copies cannot be spread across parties.** Asking for four copies gets four machines chosen
  by hash proximity, with no notion of owner. See
  `implement/34-debt-strand-breadth-counts-machines` for what the numbers actually mean today.
- **A change cannot require two different parties to witness it.** Any rule of the form "a write
  must be attested by two distinct parties" is unenforceable while the layer choosing attestors
  cannot tell parties apart. `backlog/feat-open-strand-witness-policy` runs into this directly.
- **The strand mesh cannot turn a stranger away.** Strand-mesh admission control needs the same
  durable binding; today the only gate on a strand transport peer id is a 30-minute in-memory
  relay grant (`delegate-admission.ts`), which admits a connection and attests nothing.

## What this would involve

Not one change. Roughly, in dependency order:

1. **Per-party strand membership written in production.** A joining party mints its own member
   keypair and gets a real `Strand.Member` row (invite redemption or manager admission), instead
   of every party sharing the founding key. The writers already exist; nothing calls them.
2. **Each party binds its own machines.** At strand bring-up a node registers a
   `MemberPeer(MemberKey, PeerId)` row for the strand transport peer id it runs as
   (`strandTransportKey`), and clears it on removal.
3. **Cross-party strand discovery.** Until a strand mesh can contain more than one party, none of
   the above has anything to choose between. Still an open design question in
   `docs/strands.md` → "Some Questions"; expected to want a strand-overlay DHT and/or the
   `MemberPeer` rows themselves.
4. **Upstream acceptance of the label.** Optimystic's cohort selection takes no grouping label
   today. Asked for in `optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`;
   both selection sites need it (`findCluster` and `spread-on-churn.ts`), or the property leaks
   back out as peers churn.

Steps 1 and 2 are worth doing on their own merits — they are what strand-mesh admission control
needs regardless of placement — so this does not have to wait on step 4.

## What earlier research already settled

Recorded so the next pass does not re-derive it. From the plan pass on
`debt-cohort-selection-party-blind` (2026-08-03):

- **The label is `Strand.MemberPeer.MemberKey`, joined to a live `Strand.Member` row.** No new
  schema and no new wire field. The join is mandatory, not tidiness: the schema's own note says a
  `MemberPeer` row can outlive the `Member` it names, so a revoked party's stale binding must not
  earn diversity credit.
- **A peer bound to two different member keys counts as neither.** The primary key is
  `(MemberKey, PeerId)`, so nothing stops two members claiming one machine; a machine that could
  be counted as either party could be used to fake diversity. Treat it as unlabelled and log it.
- **A resolver must never touch the database on the selection path.** Cohort selection runs
  during reads and writes of the very database the `MemberPeer` rows live in, so a resolver that
  queries it re-enters the transactor. The workable shape is an in-memory snapshot refreshed
  out-of-band and read synchronously with no I/O; an unknown peer resolves to "no label".
- **The control network is out of scope, permanently.** A cadre is one party by construction, so
  every control peer carries the same label and party-diverse placement there is meaningless.
- **Open strands have no label source and must degrade, not fail.** `Strand.Member` and
  `MemberPeer` both carry `OnlyClosed` checks, so an open strand has no member rows at all by
  schema. Whether an open strand should get a different rule is
  `feat-open-strand-witness-policy`'s decision, not this one's.
- **Too few distinct parties must fall back to today's placement.** A one-party workspace is the
  common case and must keep working unchanged.
- **Machine uptime stays a separate concern.** "Prefer the always-on machine" is a plausible
  second input, but a node's storage-versus-edge profile is local configuration with no
  replicated, signed representation anywhere on a strand — folding an unverifiable self-asserted
  claim into a rule whose whole value rests on a signed label would weaken it. If placement ever
  takes two inputs, uptime needs its own attested source first.
- **How far self-asserted labels can be trusted.** On a closed strand a party cannot mint labels
  freely: a `MemberPeer` row needs a live `Member` row, which needs manager admission or invite
  redemption. Binding many machines to one member key only reduces that party's own diversity
  credit, so it is harmless. The residual risk — one party getting itself admitted as several
  members — belongs to the invitation system, not to the placement layer.

## What happens if we do nothing

Everything keeps working and nothing warns. A workspace shared between three people keeps every
copy of its data on whichever person's machines wrote it, and the numbers in the configuration
keep looking like they say otherwise. `implement/34-debt-strand-breadth-counts-machines` makes
that visible in writing; it does not change it.
