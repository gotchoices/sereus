description: The safety check that stops one machine's word from being trusted about a piece of shared data is pinned at the two-machine setting for every group, however many machines the user has enrolled; derive it from the group's own membership records instead, and apply it whenever a node is built or rebuilt — which already happens on every wake from hibernation.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, packages/cadre-core/src/strand-instance-manager.ts (StartStrandConfig, ResumeStrandOverrides, buildStrandRuntime), packages/cadre-core/src/cadre-node.ts (createControlNode, refreshMembershipGate, resolveCohortSeed, handleStrandWake), packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/types.ts (CadreNodeConfig), docs/architecture.md (Replication cluster size), ../optimystic/packages/db-p2p/src/cluster/cluster-policy.ts
difficulty: medium
tradeoffs: A maintainer might judge the exposure theoretical for a personal cadre (the attacker needs routing influence over the user's own machines), note that everything committed under current Optimystic carries a proof and repairs regardless of this number, and prefer to keep both policies as frozen constants until a field report shows a stale copy being accepted off a single peer.
----

# Track enrolled machines in the repair yardstick, applied at every node (re)build

**Upstream dependency, stated up front.** This ticket needs one addition in Optimystic that does
not exist yet: a way to declare the block-repair yardstick *separately* from the write-admission
yardstick (`../optimystic/tickets/backlog/feat-declare-repair-yardstick-alone-apply-by-rebuild`,
Arm 1). Until that ships, the only field available sets both, and raising it here would raise the
write floor for the whole party. If this ticket is promoted before that lands, it belongs in
`blocked/` under "dependency outside this repo", not in `plan/`.

## What is pinned today, and why

Optimystic's block repair asks the block's cohort for the newest revision and only trusts an answer
that enough independent peers agree on. "Enough" is measured against a declared group size, not the
peers currently visible — deliberately, because the visible set comes from unauthenticated routing
and a partition (or an attacker with routing influence) can shrink it. The declaration is
`clusterPolicy.assumedClusterSize`, and both of Cadre's policies pin it at **2**
(`CONTROL_CLUSTER_POLICY` and `STRAND_CLUSTER_POLICY` in `packages/quereus-plugin-sereus/src/cluster-size.ts`).
The comment there gives two reasons: Optimystic freezes the value when the libp2p node is built,
before the `ControlDatabase` holding the `CadrePeer` rows exists; and a per-node derivation lets two
members disagree, which the admission gate's confident path punishes.

Both reasons are real, but they are reasons about the *admission* yardstick and about *breadth*.
For the *repair* yardstick they do not hold:

- Repair is per-node. Each machine's yardstick protects only that machine's own reads; two members
  holding different values never refuse each other anything.
- Being wrong low costs safety (a single peer's stale or fabricated answer accepted as truth); being
  wrong high costs only repair of **proof-less** data, and every commit under current Optimystic
  carries a proof (a lone machine self-signs one), so proof-less data is legacy or a lost proof store.

The cost of the pin, concretely: a party of five machines runs every node with
`repairCorroborationClusterSize = 2`, so Optimystic's `corroboratorCapacity` is `max(visiblePeers, 1)`.
When routing shows a member exactly one peer, the corroboration floor relaxes to a single voter — the
exposure `debt-read-repair-single-voter-corroboration` describes for a genuinely two-machine strand,
extended to every party size whenever the view shrinks. `docs/architecture.md` → *Replication cluster
size* currently says whole-party breadth "strengthens the read repair that remains" by raising
`cohortPeerCount`; that is true only while the cohort view is intact, which is precisely the
condition the declared yardstick exists not to rely on.

## What this ticket does

Once Optimystic accepts the repair yardstick on its own, each node declares it as **the number of
machines enrolled in this party**, from the party's own authenticated membership records, and
re-declares it every time a node is built or rebuilt. Nothing about `assumedClusterSize` (admission)
or either breadth constant changes — see *What stays as it is* below.

### The source of truth, and why it is authentic

The count is the set of `CadrePeer` rows that are authorized and not removed — the same
owner-voucher-verified rows `CadreNode.isAuthorizedMember` and the materialized snapshot behind
`authorizeInboundControlStream` already judge against, and the same rows `resolveCohortSeed` reads
to seed a strand's cohort. A machine enters that set by a signed enrollment and leaves it by a signed
removal, so the number is a declaration from authenticated application state, never a network
observation and never something an end user sees. That keeps the property Optimystic's declared
yardstick exists for.

A local attacker who can rewrite those records — or the durable slot below — can already rewrite
the node's config and identity; nothing new is trusted.

### Where the value enters, and when it changes

**Rebuild, not mutate.** Optimystic captures the number as read-only at construction and this
ticket does not ask it to change that (its ticket above records the decision and the reasons). The
new value takes effect when a node is next built, and both of Cadre's node kinds already rebuild:

- **Strand nodes** are torn down and rebuilt on every wake from hibernation
  (`StrandInstanceManager.resumeStrand` → `buildStrandRuntime`), and `ResumeStrandOverrides` already
  exists to re-resolve a *volatile* input at resume — today the discovery seed, which
  `CadreNode.handleStrandWake` refreshes before every resume. The enrolled-machine count is the second
  volatile input: read it beside the seed in `resolveCohortSeed`'s caller, pass it through the
  overrides, and `buildStrandRuntime` hands it to `createLibp2pNode` next to `STRAND_CLUSTER_POLICY`.
  The retained launch config keeps the latest value so a later resume without overrides is not stale.
- **The control node** is built once per `CadreNode.start()`. It needs the count *before* the
  control database exists — the chicken-and-egg the `cluster-size.ts` comment names. The pattern for
  "a small authenticated fact that must outlive the process and be readable before the node is up"
  already exists: the node-local durable records over `node-local-snapshot.ts` (`trusted-owner-store`,
  `bootstrap-peer-store`, each behind a `DurableSlot` the embedding app supplies). Add a third,
  `'drop-entry'`-shaped record — or a single integer slot — written from `refreshMembershipGate`,
  which the control database already calls after every committed `CadrePeer` write, and read in
  `createControlNode`. A missing or unreadable slot means "cold start": declare 2, exactly today's
  behaviour.

**Do not force a restart on "add a backup".** Raising is the safe direction and a node still holding
the old value is running at today's value, so waiting for the next natural rebuild costs nothing new.
The control node picks the count up on the next app launch; each strand on its next wake. If a
product ever wants it sooner, the mechanism is a quiesce → resume of idle strands
(`quiesceStrand` / `resumeStrand`), which is one call and already idempotent — but that is an
optimization to measure, not a requirement.

### Raise and lower

Both directions apply, because both come from signed membership changes. A removed-but-not-yet-reaped
row over-declares by one until `peer-reap` runs; that only costs repair of proof-less data on that
node and clears itself. The declared value is floored at `MIN_CLUSTER_SIZE` (2) and, on Optimystic's
side, still takes the max with the peers actually visible — so a node whose local records are stale
*low* (it bootstrapped into a partition and has not replicated every row) is never worse than today.

### Which machines count for a strand

On the cadre-driven path a strand's cohort is seeded from this party's own `CadrePeer` rows
(`resolveCohortSeed`), so "machines enrolled in this party" is the right count there too, capped by
nothing (a value above `strandClusterSize` is harmless; Optimystic caps the floor at two corroborators).
Two refinements the plan stage must weigh and may decline:

- A cadre machine whose `strandFilter` excludes this strand is not a holder. Counting it over-declares
  by one — cheap, and simpler than teaching the control node which strands each sibling serves.
- Cross-party strands (`feat-strand-party-identity`, hand-supplied bootstrap addresses) bring machines
  this party's records do not list. Under-declaring them is today's behaviour and, because Optimystic
  takes the max with the visible cohort, never unsafe relative to today. Leave it.

## What stays as it is

- **`assumedClusterSize` stays at 2 for both networks.** It also drives the write-admission floor on
  the low-confidence path (`max(2, ceil(0.75 × assumed))` declared peers), and a party of phones
  cannot promise `ceil(0.75 × N)` awake machines. Raising it is a separate availability-versus-
  self-shrink-defence decision; record in `cluster-size.ts` that it is now deliberately the *admission*
  yardstick only, with that tradeoff named, so the next reader does not "fix" it to match.
- **`CONTROL_REPLICATION_BREADTH` and `DEFAULT_STRAND_CLUSTER_SIZE` stay constants.** Breadth must
  agree across every node on a network (the confident-path admission gate rejects a narrower declared
  set against a wider derived view), so it cannot be per-node derived; the reasons in
  `docs/architecture.md` stand. Scaling 1 → n up to the breadth needs no breadth change; above it,
  partial replication is by design (`debt-replication-proof-above-cohort-size`).
- **No runtime mutation of a live node.** Rejected alternative, with reasons, in the Optimystic ticket.

## Human action, not code

`gotchoices/sereus#2` is stale: it says `CadreNode` hardcodes `clusterSize: 3` and declares no
`assumedClusterSize`. Neither is true (fixed control breadth 16, configurable strand breadth,
`assumedClusterSize: 2` in both policies). What it still gets right — no consumer-injected
`clusterPolicy`, `allowUnvalidatedSmallCluster` unreachable — stopped mattering when Optimystic#10
(the genesis admission exemption) closed. Optimystic's `packages/db-p2p/docs/cluster.md` repeats the
stale claim and its ticket corrects it. Someone should update or close #2 with the current state and
point it at this ticket.

## Edge cases and interactions

- **Cold start of a brand-new node**: no slot, no rows → declares 2 → identical to today. Pinned.
- **Slot present but unreadable** (`DurableSlot.load` throws): declare 2 and log; never treat as
  "zero machines". Mirrors the `bootstrap-peer-store` loader's fail-safe-not-silent policy.
- **Membership change during a strand's `starting` window**: the retained launch config is updated
  on the next `handleStrandWake`, not mid-build; the value a build started with is the one it runs on.
- **Two members with different counts** (eventual consistency): harmless for repair by construction;
  worth one integration assertion that a 3-node party where one member declares 2 and two declare 3
  still commits and still repairs.
- **Reap after removal**: the count drops by one only when the row is reaped, not when it is marked
  removed; state which event the slot writer keys on, and prefer the earlier (removal) so the
  over-declare window is the reap delay, not longer.
- **Hibernation check-in cycles** rebuild a strand many times a day; the count read must be a cheap
  local query, not a network round-trip, or check-in latency regresses (`timing('[resumeStrand:%s]')`
  already measures it).
