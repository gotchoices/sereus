# Strand Management and Negotiation

## History
An initial attempt at a strand negotiation (“strand initialization”) protocol was built as a standalone package; it has since been superseded by the native `cadre-core` formation transport (`strand-formation-protocol.ts`) described above.

## Terminology
- **party**: a person or entity that transacts data with other parties.
- **node**: a device/process that runs libp2p, identified by a **Peer ID**.
- **cadre**: one or more nodes representing a single party within a strand.
- **strand**: a logical network over which participating parties transact data and share a
  database. That database is visible to every member of the strand — see
  [`strand-contracts.md` → Party-Private App State (Interim)](strand-contracts.md#party-private-app-state-interim)
  for where per-user state that should *not* be strand-wide visible belongs today.
- **cohort**: the set of nodes participating in a strand (union of all cadres). Optimystic uses
  the same word for a narrower thing — the nodes a single *block* is replicated to, sized by
  `DEFAULT_STRAND_CLUSTER_SIZE`. Code comments and [`architecture.md` → Replication cluster
  size](architecture.md#replication-cluster-size) mean Optimystic's sense unless they say otherwise.

Networking terms:
- **Peer ID**: a cryptographic identity for a libp2p node, derived from a private key.
- **multiaddr**: a self-describing network address (e.g. `/ip4/…/tcp/…/p2p/<peerId>`).
- **bootstrap node**: a stable libp2p peer you dial first to join a particular overlay (not a “global DHT”).
- **relay**: a Circuit Relay v2 server that can forward connections to NAT’d nodes via `/p2p-circuit`.
- **dnsaddr**: a mechanism to publish multiaddrs via DNS TXT records (so operators can avoid hard-coding IPs/Peer IDs in configs).

Reachability information:
- **addr**: “how to reach this party (or its cadre)”, which can be expressed as either:
  - **explicit multiaddrs** (direct or relay-routed), or
  - **discovery parameters** (e.g. `bootstrap nodes` + a network identifier) that allow resolving a current dial address.

Design note:
- Sereus is intended to be **invitation-only** (out-of-band). There is no assumption of a single, world-wide DHT where “everyone registers”.
- This raises an open question: **which DHT(s)** exist (and when), especially *before* strand initialization.

## Primary Objective
This document seeks to explore how best to manage the nodes in a strand.
From a UX perspective, this involves:
- How does one establish a cadre?
- How does one add/delete/update nodes in it?
- How does one create a strand?
- How does one invite others to the strand?
- How does one manage the strand?
- What is the lifecycle of a strand?

## Cadre Types
A cadre could conceptually take on one of the following shapes (showing only the interesting cases rather than all permutations):
- SN: Single NAT node: phone, laptop behind a firewall
- SP: Single public: cloud or physical server with public IP
- MN: Multiple NAT nodes: a phone and several computers, all behind a firewall
- MM: Multiple mixed nodes: several devices with at least one having a public IP
- LM: Large-scale mixed: More nodes than the DHT replication factor, at least one with a public IP

## Use cases

### SN–SN (both parties are single NAT nodes)
A user with only a phone wants to connect to another such user.

- The parties will need a **relay** somewhere neither can accept inbound connections directly.
- At a minimum, one party must reserve a slot on the relay and disclose a full relay-routed multiaddr.
- The other party can reach the first via the relay if it has that relay-routed multiaddr.
- If the first party intends to roam (connect via more than one relay), it will need a discovery mechanism:
  - join a DHT overlay (via one or more bootstrap peers)
  - publish reachability (Peer ID + dialable addresses, ideally including `/p2p-circuit`)
- This allows the second party to discover a current dial address using only the Peer ID plus bootstrap information.
- If a party loses its phone, it should be able to rejoin the cadre with a new phone only if its identity key material can be recovered/rotated safely.

**The use case itself is proven end to end (one shared relay).** Two DIFFERENT parties,
each a single node that cannot listen (`listenAddrs: []`), form a closed strand and
replicate rows both ways with every byte crossing one dedicated ungated relay:
`packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts`.
The invitation's bootstrap addresses carry the host's `/p2p-circuit` control address (the
only kind of address a relay-only host has), the stranger-open formation protocol runs
over the circuit, the formation result hands the joiner a relay-routed strand address plus
the closed strand's membership secret, and the joiner's strand node — holding its own
reservation on the same relay — reaches the host's strand node from that seed with no
hand-dial. Every A↔B connection classifies `relayed`. Cost, measured there: 4 relay
reservations for the pair sharing one strand (2 control + 2 strand) — one slot per node
per network, so every strand a NAT'd node joins costs one extra relay slot per node. The
same-party sibling
`packages/integration-tests/src/scenarios/strand-circuit-same-party-e2e.integration.ts`
(one party's two machines over the same fixture) additionally pins reservation-loss
recovery on every node (control and strand alike re-reserve after the relay restarts) —
see [architecture.md → Relay Integration](architecture.md#relay-integration).
Still open, and NOT covered by that scenario: TWO relays (the parties reserved on
different relays, so the path between them crosses relay boundaries — the ordinary case
once each phone picks its own relay) is untested
(`backlog/feat-scenario-two-relay-circuit`); discovery and roaming remain unsolved — a
party that moves to a different relay after formation has no way to say so, and no way to
be found; and the last bullet above (rejoining with a new phone after losing the old one)
has no mechanism and no test.

Open question: what is “the DHT” here?
- Is a **cadre** its own DHT overlay?
- Is there a **pre-strand rendezvous DHT** used only for discovery/initial contact?
- Or is peer discovery always explicit (full dial addrs exchanged out-of-band), with no pre-strand DHT at all?

### SN–MM (a single NAT node connects to a multi-node cadre)
A single phone party connects to a more robust party with multiple nodes.
- The SN party is limited to two options:
  - Listening for a connection:
    - requires a relay
    - requires disclosing a relay-routed dial address (or publishing one via a DHT overlay)
  - Initiating a connection:
    - requires the MM party’s reachability info (explicit multiaddrs and/or bootstrap/discovery info)

## Some Questions

**Relay willingness — resolved (implemented).** A **dedicated** relay/bootstrap node (the
`ops/` infrastructure stacks) has no membership gate and relays for anyone. A **party
control node** that also runs the relay server (the default for every storage-profile node)
is party-private infrastructure: it relays for its own party's nodes — including the extra
transport identities its members' strand nodes run as. The mechanism for the latter is a
**member-announced delegate grant**: before a member's control node starts a strand node,
it announces the derived transport peerId that strand node will run as, over the
already-authenticated `/sereus/strand-addr/1.0.0` RPC, and the relay holds a short-lived,
in-memory admission grant for exactly that peerId
(`packages/cadre-core/src/delegate-admission.ts`). The grant admits the *connection* and
the *reservation* only — control-DB streams stay member-gated. The connection gate is no
longer the sole relay admission control: the relay question proper is decided at the
circuit-relay server's reservation hook (`membership-connection-gater.ts` → "The
relay-reservation seam"), where members and delegates are admitted outright and a peer the
relay cannot (yet) place — typically a genuine member whose `CadrePeer` row has not
replicated to the relay — is admitted within a small bounded budget
(`network.unauthorizedRelayReservationCap`, default 8); an admitted-for-relay connection
that never reserves is dropped after a few seconds. So a single-node NAT'd (SN) party
finds a willing relay in its own party's storage nodes, or in the ungated dedicated
relays, and is never locked out of its first address by replication ordering.
  - Grants live only in the relay's memory, so a relay **restart** drops them all and the
    announcing member is not told. A strand node's relay-reservation supervisor therefore
    re-announces FIRST: before every re-drive it runs `CadreNode.announceDelegateToRelay`,
    an unthrottled announce of that strand's delegate peer id to exactly the relay about to
    be re-dialed, so the re-drive meets a fresh grant rather than the connection gate. The
    periodic refresh pass (at most half the grant lifetime, currently 15 min) still runs as
    the backstop for a grant that lapses while the reservation itself survives. If relay
    restarts become routine, the durable attestation below is still the better fix than
    leaning harder on re-announcing.
  - Mostly landed: a **durable** attestation — a replicated, signed `MemberPeer(MemberKey,
    PeerId)` row binding a member to its strand transport peerIds. The attestation is now
    **written automatically**: every machine of a party registers its own `MemberPeer` row
    when it brings the strand up, under the party's own membership identity (the background
    membership reconciler, `packages/cadre-core/src/strand-membership-reconciler.ts`, which
    retries until the strand's rows have replicated to it). The **revocation** half is
    enforced: a row left orphaned by its member's removal is exactly what a strand node
    denies that member's machines by, at the connection, stream, dial and relay-reservation
    hooks (`packages/cadre-core/src/strand-revocation-enforcer.ts`, and [Removing
    Members](#removing-members) for what that guarantees in plain terms). The **admission**
    half — reading the same rows as an allowlist, so a strand admits only machines
    positively bound to a live member — is still deferred
    (`feat-strand-member-allowlist-admission`), so a stale or missing binding denies nobody
    today. The relay's in-memory grant above is unaffected either way — it remains how a
    party's own strand nodes reserve on their own party's relay.

- Before strand initialization, where (if anywhere) do peers publish reachability?
  - If the answer is “a DHT”, which one, and how is it invitation-only?
- After strand initialization, the **strand** likely has its own DHT overlay for Optimystic/Quereus routing; does that DHT also serve as the canonical place to publish addresses for existing strand members?

**Within-party answer (implemented).** For a node's **own co-cadre siblings** there is no DHT lookup at all: the control network already gives every party node a connection to its siblings, but a `CadrePeer` row stores only a sibling's **control**-network address — dialing that reaches the sibling's control instance, not its strand instance (a strand is a separate libp2p node on its own port, with its own transport peerId derived from the cadre identity key — cadre authority stays on the control node, and the distinct peerId is what lets both nodes share one circuit relay). So a strand's bootstrap addresses are resolved **on demand over the control mesh**: a node asks each connected sibling "what are your live strand-`X` multiaddrs?" via the `/sereus/strand-addr/1.0.0` RPC and seeds from the union (see [architecture.md → Strand-Address Resolution](architecture.md#strand-address-resolution)). This is single-party only — it bootstraps this party's own nodes onto a strand. See [architecture.md → Strand Networks](architecture.md#strand-networks) and, for what a strand's replication breadth (`DEFAULT_STRAND_CLUSTER_SIZE`) does and does not buy, [architecture.md → Replication cluster size](architecture.md#replication-cluster-size).

That resolution is not one-shot. The launch/resume seed is also merged straight into the
new strand node's libp2p **address book** (its peerStore), and every running strand
re-resolves its siblings' strand addresses over the control mesh on a ~10-minute cadence,
re-merging each answer under the sibling's *strand* transport peerId
(`CadreNode.refreshStrandPeerAddrs`, riding the control-cohort reconcile pass). Both matter
because everything below cadre-core dials a strand peer by **bare peer id** — Optimystic's
cluster and repo clients, FRET ping/announce — and a bootstrap address list alone does not
put anything in the address book that outlives the initial discovery. Without the refresh, a
sibling that restarts its strand node or rotates its relay reservation stays unreachable
until this node restarts or resumes the strand, and even the original seed addresses expire
out of the peerStore after an hour.

**Cross-party answer (implemented, one-shot).** The RPC above is membership-gated, so it can
never answer for another party's strand nodes. The address instead travels on the **formation
handshake** — the one moment the two parties are authenticated to each other and agreeing on a
strand id. An approving formation result now carries the responder's live strand-network
addresses for the strand it provisioned (`strandAddrs`), disclosed under exactly the same gate
as its party id and cadre addresses, so a rejected redemption discloses nothing. The joiner
keeps them per strand and unions them into that strand's discovery seed — behind any fresher
sibling answer — on launch, on hibernation resume, and on every periodic address refresh.
`integration-tests` scenario `strand-formation-cross-party-seed` proves two different parties
meshing on one strand, and replicating rows across it, with no hand-dial anywhere — over
loopback addresses; `blind-relay-phone-to-phone-e2e` proves the same handshake carrying a
RELAY-ROUTED strand address between two relay-only parties, with the closed strand's
membership secret delivered over the circuit (see the SN–SN use case above).

Two limits are real and are **not** solved by that work:

- **In-memory, so one-shot.** The carried addresses die with the joiner's process. A restarted
  joiner with no sibling of its own running the strand is back to an empty seed, and the
  cross-party mesh does not re-form until it redeems a fresh invitation. Durability —
  persisting the contact, or re-resolving it — is `backlog/feat-cross-party-strand-addr-durability`.
- **Never refreshed.** They are the responder's addresses at the instant of formation. If its
  relay reservation rotates before the joiner dials, the entry is dead and nothing re-resolves
  it; recovery today is a fresh invitation.

So the remaining open question is narrower than it was: not "how does one party find another
party's strand at all", but "how does a party that has already joined **re-find** the other
side after it moves" — still expected to want a strand-overlay DHT and/or the strand's own
`MemberPeer` records rather than the control network.

## Strand Creation

_(TODO: not yet documented here. See the strand-formation and seed-bootstrap coverage in [`docs/architecture.md`](architecture.md) ("Enrollment and Bootstrap") and the [`@serfab/cadre-core` README](../packages/cadre-core/README.md).)_

## Joining: no writes before the first sync

**Invariant: a machine that has never held this strand's `Strand.Header` row, and has not read every `App` table once, must not commit to it.** The founder writes the Header in its bootstrap (`foundStrand`, or `addStrand` with `founder: true` / a row this machine published); every other machine can only receive it from a peer, so "no local Header" means "never synced". The Header alone is not enough: it is one collection, and it reaches a joiner ahead of the founder's app-table collections, so a write to a table whose collection this machine has not fetched yet forks exactly as a lone joiner's does. Reading each app table once, while the founder is reachable, pulls its collection first.

Why: with no strand peer connected, optimystic's cohort for every block is the machine itself. A joiner's first write to a table finds no collection locally, treats that as "does not exist", and creates a new one — exactly what a founder writing alone legitimately does. When the connection comes up, two independently created histories share one collection id; optimystic keeps one and drops the other's commits, or never reconciles them at all. Measured on the reference chat schema (2026-09-16, direct connections): a joiner that wrote its participant and a message immediately after `addStrand` lost the message for good and its participant table stayed forked for the whole 30 s observation window, while the same joiner writing after it had read the host's rows converged on both machines. Both writes reported success. Optimystic cannot tell a founder from a joiner; sereus can, because the launch knows whether it is founding.

What the runtime does (`packages/cadre-core/src/strand-first-sync-gate.ts`, wired in `StrandInstanceManager.buildStrandRuntime`):

- A **non-founder launch** brings its strand libp2p node, membership reconciler, revocation enforcer and peer-join backfill up as before, then probes once: a read of `Strand.Header`, and — only once that row is held — a `select count(1)` of every table the sApp declared in `App`. If the Header is held and every table read settles, the database is published at once — a restart or a hibernation resume over a store that has synced before is never gated, so offline-first writes on such a machine keep working. Otherwise the instance comes up **`'syncing'`** with `StrandInstance.database` unset, and re-probes every `strandFirstSync.pollIntervalMs` (500 ms). Reads never invent a collection (optimystic's `Collection.open` resolves undefined on an authoritatively absent header and throws on an unreachable one), so the probe is safe to repeat; a throwing read is "not yet", and an empty table is a settled read. The background loops read `instance.database` lazily, so they wait with it — the reconciler cannot seat a `Strand.Member` row into a forked table either.
- The moment the probe passes, the database is published, the status flips to **`'active'`**, and `CadreNode` emits **`strand:writable`** — also when the hibernation manager's idle timer had already relabelled the still-gated joiner `'idle'`; the publish counts as activity, so its idle timer re-arms. A founder request against a still-gated instance (`foundStrand` after a joiner-shaped attach) runs the bootstrap through the gate and opens it: writing the Header locally is the one legitimate way to become writable without a peer.
- **The joiner's membership rows land WITH the strand, not a poll interval later.** On a closed strand every machine also has to finish its party's join: seat the party's `Strand.Member` row (redeeming the single-use invitation the formation staged) and write its own machine→party `Strand.MemberPeer` binding, the two rows revocation enforcement and future admission control key on. The loop that does this (`strand-membership-reconciler.ts`) is armed at bring-up, so on a gated launch its first pass runs while the database is still withheld, finds none, and does nothing. `StrandInstanceManager.publishDatabase` therefore kicks it as it hands the database over: both rows are written about a second after the strand goes `'active'`. A pass that leaves the join unfinished — the host's `Strand.Invite` row has not replicated to this machine yet, or the cohort is briefly unwritable — retries on a short doubling ladder (1 s, 2 s, 4 s, … capped at the reconciler's poll interval); the flat 30 s poll interval is reserved for the different state of a machine nobody has admitted at all, where there is nothing this machine can do faster. Measured before the kick existed: the two writes sat idle for 29 s after `addStrand` resolved, then ran as one 45-stream burst (2026-09-17, two parties over direct loopback connections). `blind-relay-phone-to-phone-e2e.integration.ts` gates the timing end to end at the production cadence. The app receives the same `Database` in the same tick, so its first writes run alongside the loop's. Every membership writer (`strand-membership-writer.ts`) therefore issues its whole transaction as one atomic `exec` batch, which Quereus begins, runs and commits — or rolls back — without ever letting another caller's statement in, so an app write made meanwhile is not swept into a membership transaction and lost when that transaction fails. That holds for every failure shape, a membership statement that fails before `commit` (a primary-key collision, say) as much as the usual join failures that fail at `commit` (the `Invite` not replicated yet, expired, cancelled, sealed, a refused optimystic commit). The loop also never joins a transaction the app has open: its writes refuse with `StrandTransactionBusyError`, having written nothing, and the pass retries on the ladder. On a networked strand the redemption's two tables commit separately, and optimystic can report that only one was saved; the reconciler recognises that error by type, prints one `console.warn` naming the saved and unsaved halves, and drops the invitation — when `ConsumedInvite` was saved and `Member` was not, the invitation is spent and the party stays outside the strand until a manager admits it directly (`addMemberByManager`), after which the loop's next pass writes the binding (automatic repair is an open decision, `blocked/strand-half-committed-join-recovery`).
- **`CadreNode.addStrand` resolves only once the strand is writable**, bounded by `strandFirstSync.timeoutMs` (30 s). On timeout it rejects with `StrandAwaitingFirstSyncError` ("no member of this strand has been reachable since this machine joined") and leaves the launch up, still probing; the same call made again later completes the attach, as does awaiting `CadreNode.whenStrandWritable(strandId)` or the event. `addStrand({ awaitFirstSync: false })` returns the `'syncing'` instance immediately for a caller that wires its own peers first (the integration harness). There is deliberately no way to disable the gate.
- A strand the watcher auto-launches (a self-configured strand after a restart) is reported by `strand:started` in whatever state it came up; an app that hangs a "waiting for the other member" screen on `'syncing'` takes it down on `strand:writable`. The hibernation manager treats a `'syncing'` strand like any other: no activity lands on it, so it idles and hibernates on the usual timers, and every check-in resume re-probes.
- The reference apps rely on this: the RN and NativeScript chat screens register the local participant only once `strand.database` is set, and the closed-strand join helpers write the member role after `addStrand`, which is now safe.

What it does not cover — the residual is real and documented rather than solved here:

- **A settled read proves the collection was fetched or is absent everywhere, not that it will exist.** A table nobody has written yet reads as absent on every machine; the first write to it, on whichever machine, creates its collection, and a second machine writing to the same never-written table before it has read the first machine's rows still invents a divergent copy, with the same "two histories, committed rows silently lost" behaviour. That behaviour is upstream (the strand instance of the control-database case in `tickets/blocked/forked-control-collection-sync-livelocks.md`); optimystic has recorded it as an arm of its partition-healing design, where a CRDT sync layer is the intended fix, rather than as a point fix. Whether the founder should create every app table's collection eagerly at founding, so peer-join backfill ships them all and no joiner can ever invent one, is an open design question that needs the founding cost measured first.
- **Gating is per machine, on evidence it holds.** A machine that shares nothing with the strand yet cannot be told apart from one whose only peer is slow; the gate waits for both, and the timeout is what makes the difference visible to the app.

## Same-Named Tables in `Strand` and `App`

Every strand database holds two engine schemas: `Strand`, the built-in membership tables ([`schemas/strand.qsql`](../schemas/strand.qsql), embedded at runtime as `STRAND_SCHEMA`), and `App`, the sApp's own tables. An sApp may name a table like a `Strand` table (`Member`, `Header`, `Invite`, …): the two are stored separately. Optimystic stores a table declared without an explicit `using optimystic('<uri>')` at `tree://default/<schema>/<Table>` and files its catalog record under its schema and name together, so `Strand.Member` lives at `tree://default/strand/Member` and `App.Member` at `tree://default/app/Member`. Each keeps its own rows and columns, including across a warm restart (pinned by "an sApp table named like a strand table" in `packages/quereus-plugin-sereus/test/plugin.spec.ts`).

Apps address their own tables as `App.<Table>`. Quereus's `schema_path` defaults to `main`, so neither schema's tables resolve unqualified.

- NOTE: an explicit location still shares storage. An app table declared `table Member using optimystic('tree://default/strand/Member') (…)`, or two app tables given the same explicit URI, open one collection and decode each other's rows. Optimystic refuses such a pairing only once the collection already holds rows, not at strand bring-up when both tables are empty. If sApps start declaring explicit locations, sereus would need to check resolved URIs. (In a declared table the `using` clause goes before the column list; after it, Quereus skips the clause as an unrecognized item.)

## Inviting Parties

_(TODO: not yet documented here. See the invitation/enrollment flow in [`docs/architecture.md`](architecture.md) ("Enrollment and Bootstrap") and the [`@serfab/cadre-core` README](../packages/cadre-core/README.md).)_

Attaching a human-readable legal agreement to a strand — reviewed before joining, executed
as a separate in-strand signing act — is a design-stage plan: see
[`strand-contracts.md`](strand-contracts.md).

## Closed-Strand Member Key Handling

A closed strand involves **two different party-held Ed25519 keys**, both minted by
`generateStrandMemberKey` and both held **unencrypted** in the party's control
database, which Optimystic replicates to **every node the party owns**:

- **The strand-wide read secret** — the control-layer `Strand.MemberPrivateKey`.
  Formation delivers it to *every* joining party
  (`FormationProvisionResult.memberPrivateKey`, disclosed only after token +
  disclosure validation), and the initiator records it into its own control DB. It
  gates reads; it deliberately derives **nobody's identity**.
- **The party's own membership identity** — the control-layer
  `StrandPartyKey.PrivateKey`, one row per (party, strand). The founding
  `Member.Key`/`Manager.MemberKey` are its public key. The **founder** mints it at
  `publishStrand` for a closed strand (or at the next founder launch, when a publish
  was interrupted before its mint); a **joiner** mints (or, on a re-formation, reuses) its own at
  `formStrand`, when the approving closed-strand formation result carries a
  single-use strand membership invitation
  (`FormationProvisionResult.membershipInvite` — a `Strand.Invite` keypair the
  responder's live strand runtime issues under its party identity, disclosed on the
  same terms as the read secret; issuance failing rejects the redemption retryably
  *before* the formation token is spent, so a joiner is never admitted as an
  unmemberable half-member). The joiner's node stages the invitation in memory
  (`getPendingMembershipInvite`), and strand bring-up redeems it automatically: a
  background membership reconciler on every machine of the party (launch and
  hibernation wake alike) consumes the invitation — seating the `Strand.Member`
  row under the joiner's own public key — then registers the machine's own device
  record (`Strand.MemberPeer`), retrying on a short doubling ladder (1 s, capped
  at the reconciler's poll interval) until the strand's rows have replicated to
  it and never blocking bring-up — see [Joining: no writes before the first
  sync](#joining-no-writes-before-the-first-sync) for why a joiner's first pass
  finds nothing and what re-kicks it. A machine that
  finds the member row already seated (a sibling redeemed first, or a manager
  admitted the party directly) instead *burns* its unspent invitation — files the
  consumption record against the existing member — so the bearer credential can
  never be spent by anyone else. Either party's
  key is **never** put on the formation wire, and the row is deleted — with its
  `Revocation` tombstone — in the same transaction that removes the `Strand` row
  (`unpublishStrand`).

The two used to be one key: the founding identity derived from the shared read
secret, so any joiner could compute the founder's member *and manager* private key
and sign as the founding manager (gotchoices/sereus#4). Identity and the shared
secret are now separate things.

**Strands founded before the split must be recreated.** A closed strand founded on
`@serfab/*` 0.13.0 or earlier still has the shared-derived key as its founding
member and manager, so every member can still act as its founder. It cannot be
repaired in place: any joiner may already have admitted or revoked anyone, or could
race a rewrite of the membership. The founder launch detects it — a `Strand.Member` or
`Strand.Manager` row equal to the key derived from the shared `MemberPrivateKey` — and
refuses it with `PreSplitStrandIdentityError`; membership-invite issuance runs the same
check on the live rows, and a join attempt against it is rejected with
`'Host strand must be recreated'` rather than told to retry. Unpublish it and found a
new strand. Details: [`docs/architecture.md` → Strand Membership Bootstrap](architecture.md#strand-membership-bootstrap).

**The replication is the point.** It is what makes a party's cadre nodes
*fungible* for closed strands: any node has both keys, so any node can serve
or participate in the strand — and sign the party's membership writes — including
a node added to the cadre long after the strand was formed, and a node that comes
up headless (push-woken, background runner) with no user present to unlock
anything.

**Accepted residual risk (decided 2026-07).** A compromised device — stolen phone,
rooted OS, app-storage extraction — leaks both keys of every closed strand that
party belongs to, giving the attacker that party's read access and its membership
identity. The team explicitly accepts this for now rather than hardening, because:

- the key sits behind the same app-storage boundary (mobile LevelDB) as the rest of
  the control DB's strand data, so encrypting only this column is partial hardening;
- the keys that are hard to rotate and single-point-of-compromise — the node's
  libp2p peer identity and the owner key derived from it — are **already** in the
  platform enclave via the `KeyStore` seam;
- member keys are per-strand, intentionally replicated, and rotatable by re-forming
  the strand;
- every fungibility-preserving fix (envelope-encrypting the column under a
  per-cadre key in each node's enclave) requires **cadre-wide secret distribution**
  — one shared key provisioned into every node's enclave, late joiners included —
  which does not exist and currently has no second consumer to justify building it.

Options that bind a strand's key to a single device's enclave (or to a chosen
quorum of nodes) were considered and rejected: they trade away node fungibility and
re-open the "how does a late-joining node serve this strand" question that
plaintext replication answers for free.

**Revisit when** a second consumer for cadre-wide secrets appears (making the
distribution build worth its cost), or the deployment threat model changes such
that app-storage compromise must be survived. At that point the open questions are:
late-joiner provisioning, envelope-key rotation across the replicated DB,
fail-closed behavior when a node's enclave slot is wiped (biometric invalidation /
Android reinstall), mixed-platform cadres (Node `FileKeyStore` + RN secure store),
and migrating existing plaintext rows.

Cross-reference: [`docs/architecture.md` → Node Key Material & the KeyStore Seam](architecture.md#node-key-material--the-keystore-seam).

## Who May Administer a Closed Strand

A closed strand's administrators are its **managers** — the rows of the `Strand.Manager`
table (see [`schemas/strand.qsql`](../schemas/strand.qsql)). Managers are the only parties
that can admit anyone: issuing an invitation, adding a member directly, and promoting
another manager all require the writer to prove it already holds a manager row. So the
contents of that table are the strand's entire access-control story, and the schema
enforces these invariants:

- **Every appointment comes from someone strictly closer to the founder.** Each manager
  row records a *generation* — how many appointment steps separate it from the founder,
  who sits at generation 0 — and every manager is seated strictly further from the founder
  than the manager who appointed it. A promotion is only valid when signed by an existing
  manager whose generation is strictly smaller than the new manager's. So two strangers
  cannot appoint each other, in one transaction or otherwise: among any batch of
  appointments, the one closest to the founder still needs a sponsor closer than itself,
  and that can only be someone who was already a manager before the batch. A key cannot
  promote itself for the same reason. Generation is a lineage marker, **not** a privilege
  level — a generation-5 manager has exactly the same powers as a generation-1 manager,
  including removing it.
- **A manager can be removed by another manager, or resign itself.** Either way the
  removal carries a signature from the party authorizing it; an unrelated key cannot
  remove anyone. The two cases sign *different* approvals, so a resignation someone
  collected cannot be turned into a removal, or the reverse.
- **Every approval is good for one action, on one row, once.** Each membership row —
  member, manager, or device record — carries a one-off random marker minted when the row
  is created, and every signed approval covers that marker along with the table name, the
  action, and the row's key. Deleting a row retires its marker permanently: the deletion
  has to file a tombstone in the same step, and no row may ever be created carrying a
  retired marker again. A captured approval therefore names a row incarnation that no
  longer exists and can never exist again, so it cannot be replayed to re-remove,
  re-admit, or re-appoint anyone. Re-adding the same key mints a fresh marker, which the
  old approval does not cover.
- **The last manager can only step down by *sealing* the strand.** An ordinary
  resignation is rejected when it would leave no manager behind; emptying the table is a
  separate, deliberate act carrying its own distinct signature, so it can never happen by
  accident and a resignation someone collected can never be turned into one. Sealing
  permanently freezes who belongs to the strand: with no managers, nobody can be invited,
  admitted, or promoted ever again — and that is the point of it. A strand that can never
  grow is a privacy guarantee to everyone already in it, because no key is left holding
  the power to let in a party who would then be able to read everything the strand has
  ever held. It is irreversible: a lone remaining member cannot re-found the strand later
  and start admitting again. What remains possible is everything that does not grow the
  membership — members can still leave, and can still register or clear their own device
  records. One piece of housekeeping does go away with the managers: a device record left
  behind by a member who was already removed can only be cleared by a manager, so after
  the seal it stays forever. Any invitation still outstanding when the strand is sealed
  dies with it: it can never be redeemed, which matters because after the seal there is
  nobody left who could even cancel it. Like the rules above, that refusal is decided from
  what one node can see (see known gaps below).
- **The founding manager is the only unsigned seat**, and only in the founding state: at
  most one member exists, the founder's member row is already present, and no manager
  exists yet. Every later manager needs a signature. (This is why a strand is bootstrapped
  in `Header` → `Member` → `Manager` order — seating the manager first is rejected.)
- **A manager row can be added or deleted, never edited.** Editing would let a
  resignation — which only proves the *outgoing* key consented — be reused to point the
  row at a key of the attacker's choosing.
- **Handing off sole control is add-then-resign, in that order.** A single transaction
  that removes the only manager and inserts a replacement is rejected; the successor must
  be appointed while the outgoing manager still holds authority.

A manager must also be a member: promoting a key that holds no `Member` row is rejected
outright, so every manager can do everything a manager needs to — admit members, issue
invitations, promote other managers, revoke a member, clear a device record, and resign its
own seat. Admitting a brand-new key as a member and promoting it to manager in the same
step is supported, so a key can go straight from stranger to manager without ever passing
through a member-but-not-yet-manager gap. Like the sealing rule above, this one is
checked against what one node can see (see known gaps below).

### Removing Members

Membership removal is governed by the same signed-approval discipline as admission
(the `Strand.Member` table's constraints in [`schemas/strand.qsql`](../schemas/strand.qsql)):

- **Any manager can remove any member.** The removal carries an existing manager's
  signature over the *removal of that specific key*. Every membership approval is tagged
  with its action, so a captured admission approval cannot be replayed as an eviction,
  nor an eviction as an admission.
- **A member can leave on its own.** A removal self-signed by the departing key deletes
  that member's own row — no manager involved. Because the signature is checked against
  the key being removed, one member's signature can never remove a *different* member.
- **A removed member cannot walk back in on the invitation it already used.** That
  invitation was spent at join time; the leftover record of its consumption does not
  re-admit anyone on its own. Re-admission takes a fresh manager action — a direct
  manager admission or a newly issued invitation.
- **An unspent invitation is cancelled explicitly, and cancellation is permanent.** A
  manager can list the strand's still-redeemable invitations and cancel any of them; a
  cancelled invitation can never be redeemed again, and there is no un-cancelling — letting
  a party back in means issuing a fresh invitation. Cancelling is what makes removal a
  re-entry gate, but it is a *separate step*: removal does **not** cancel anything
  automatically, because an invitation names no invitee, so the strand cannot tell which
  invitations were meant for the departing member — or whether it holds any (see known gaps
  below).
- **A manager must resign before losing membership.** Deleting the member row of a key
  that still holds a `Manager` row is rejected, so a removal can never leave an orphaned
  manager seat. This is the removal-side half of the manager-is-also-a-member rule stated
  above; the other half refuses to promote a key that is not a member in the first place.
- **Clearing the removed member's device records is a separate step, not a cascade — and
  it is no longer free housekeeping.** Removing a member leaves behind the records binding
  its devices to the strand; a manager lists the departed member's devices and clears each
  one with its own signed removal. Those leftover records are now *load-bearing*: they are
  the only durable, replicated record of which machines belonged to the removed member, and
  they are exactly what the remaining machines recognise its machines by (see [What removal
  does to the network](#what-removal-does-to-the-network) below). Clearing one therefore
  also forgets the network denial of that machine. So clear a leftover record only for a
  machine that is genuinely gone for good, or for a binding that should never have existed
  in the first place — tidying them up as routine housekeeping quietly re-opens the door.
  Anything reading those device records must still check membership separately rather than
  treating a device record as proof of it. Device records are written automatically —
  every machine registers its own at strand bring-up — and one case cleans up after
  itself: the machine that issues a party-wide `unpublishStrand` clears its own record on
  the way out (best-effort, while it can still sign). Its party's *other* machines
  cannot — the same act destroys the identity key they would sign with — so their records
  remain for a remaining member's manager to weigh by exactly the rule above.
- **A device record can only be added or deleted, never edited.** Every field of the record
  is part of its identity, so re-binding is a delete plus a fresh add. Allowing an edit
  would let any member re-point someone else's device record at its own key — clearing a
  record it has no authority to delete — since an edit is only ever checked against the
  values being written, not the ones being replaced.
- **The last member can never be removed.** A strand always keeps at least one member
  holding its data, so any removal — or self-departure — that would empty the membership
  is rejected. This holds on a sealed strand too: the last member cannot leave even
  though no manager remains to stop them. Like the rules above, the count is taken from
  what one node can see (see known gaps below).
- **Revocation is forward-looking only.** A revoked member keeps whatever strand data its
  nodes already replicated, and it still holds the strand's member private key. Cutting
  off its *future* reads means rotating the read gate, which currently means re-forming
  the strand — see [Closed-Strand Member Key Handling](#closed-strand-member-key-handling).

#### What removal does to the network

Removal used to be a database fact only: the row went away, and the removed party's
machines carried on holding the connections they already had to everyone else's. That is
no longer the case.

- **Remaining machines refuse the removed party's machines outright.** Once the removal has
  replicated to a remaining member's machine, that machine stops talking to every machine
  the removed member had registered: it refuses new connections from them, refuses to open
  new request streams for them, refuses to relay for them, and will not dial them itself.
  It also closes the sessions it already had open, so a long-lived connection that would
  otherwise never re-dial does not outlive the removal. A removed party running several
  machines loses all of them in the same step. This is proved on a real four-machine strand
  by `packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts`,
  which asserts that the connections existed *before* the removal and are gone after it,
  and that the removed party can then neither read what the remaining members write nor
  push anything back to them.
- **The leftover device records are what makes this possible.** A machine is recognised as
  belonging to the removed member by the device record binding it, which is why those
  records are kept rather than deleted along with the member — see the housekeeping bullet
  above.
- **Enforcement is per-machine and eventually consistent.** Each machine acts on the
  removal once it has actually replicated *there*; a machine that has not seen it yet keeps
  serving the removed party until it does. That direction is deliberate. The opposite error
  — refusing someone on a view you have not caught up on — would cut off a legitimate
  member for a reason they can neither see nor fix, so the rule is that a machine denies
  only on evidence it holds, never on evidence it is missing. The test above asserts this
  window on purpose rather than tolerating it: one remaining machine cuts while the other,
  which has not yet processed the removal, is still serving the removed party.
- **The remaining members keep working, but the first write after a cut may need a
  retry.** Nothing has to be done to eject the removed party from the group that holds the
  strand's data — cutting the connections is enough, and the remaining machines carry on
  committing among themselves. They do have to notice that the removed machines are gone
  first: measured on that four-machine test over four runs, the first write after a removal
  failed three or four times over three to four seconds ("block unavailable — peers
  unreachable") before committing. It recovers on its own, so an app that writes immediately after removing
  someone should expect a brief wobble rather than a failure.
- **The removed party's own machines also stop talking to each other.** A machine is
  recognised as removed by its leftover device record having no member behind it, and that
  is just as true of the removed party's *own* machines as of anyone else's. A machine never
  refuses itself, but it does refuse its siblings, so within one poll interval a removed
  party with several machines finds them refusing one another about that strand — its local
  copies stop converging even among themselves. Asserted at the end of the first test in
  `packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts`.
  An app that keeps a removed strand around as a read-only archive should expect each
  machine's archive to be whatever that machine had at the moment of removal, not a shared
  one.
- **A delegate grant is not a way around any of this.** A party's own relay can hold a
  short-lived admission grant for a machine of its own party (see [Relay
  willingness](#some-questions)), but such grants are only ever announced over a channel
  that is itself gated on membership of the announcing party, so *another* party's machines
  never hold one. And a grant admits only a connection and a relay slot on the granting
  party's own control machine; a removed machine that somehow rides a relay still meets the
  strand's own per-request refusal at the far end.

#### What the app has to call, and what the removed party is told

- **The cut happens on a timer unless the app asks for it now.** Each machine re-reads the
  membership on a poll — 30 seconds by default — so a removal with nothing else done takes
  up to that long to bite on any given machine. An app that removes a member (or leaves a
  strand) should follow the write with `CadreNode.refreshRevocationEnforcement(strandId)`
  on its own node: that re-reads the membership and closes the sessions before it returns.
  It is the difference between a "remove member" button that can honestly say the person is
  gone now and one that can only say they will be within the minute.
- **A removed node is told, best-effort.** A node that finds its own machine in the denied
  set raises a `strand:revoked` event naming the strand — the thing an app hangs a "you
  were removed" screen on. It is best-effort by nature: the node only learns if the removal
  reached it before the other side stopped talking to it, which is likely if it was online
  at the time and impossible if it was not. Nothing is stopped on the removed node's
  behalf; it keeps its strand running, its replicated data and its member key, and is
  simply no longer talked to. What to do about that — leave the strand, warn the person,
  keep the local copy as a read-only archive — is the app's decision, not the runtime's.

#### What removal still does not do

- **Let a removed party bring itself back.** Removal is reachable from an app today, end
  to end: a second party joins through the ordinary formation handshake, the runtime seats
  its membership and registers each of its machines by itself, and removing it cuts every
  one of those machines off the network — proved on a real four-machine, two-party strand
  by `packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts`.
  What removal does *not* leave is a way for the removed party to get back in on its own. A
  fresh invitation still reaches a removed party — invitations travel on the control
  network, which strand removal does not touch — and the removed party's node accepts it,
  files it, and *tries* to redeem it: staging a fresh invitation restarts the background
  membership loop that finished during the original join. The attempt then fails, because
  redeeming means writing a membership row into the strand, and the machines that would
  carry that write are exactly the ones the remaining members are refusing. The loop keeps
  retrying quietly and reports the dead end to the app — one console warning plus a
  `strand:rejoin-blocked` event — either as soon as the node knows it was removed and is
  holding a credential it cannot spend, or after about ten refused attempts, in which case
  the report is a suspicion (the invitation may merely not have replicated to that machine
  yet) and says so. Re-admission therefore has to be authored by a remaining manager, by
  admitting the party's key directly: that lifts the refusal, replication resumes, and the
  removed party's still-running loop sees its restored membership, spends the leftover
  invitation so nobody else can, and finishes by itself. Handing the removed party an
  invitation and waiting achieves nothing on its own, and neither does clearing its
  leftover device records. The same scenario file proves the attempt, the report and the
  manager-authored heal.
- **It does not cut off past reads, and it does not rotate the member key** — the
  forward-looking bullet above.
- **It does not cancel an unspent invitation.** Nothing in the membership rules stops a
  removed party from redeeming one it still holds — cancelling is a separate manual step,
  and binding an invitation to its invitee is tracked as `feat-strand-invitee-bound-invites`
  (see the invitation bullet above and the known gaps below). In practice a removed party
  does not get back in today, but only because the remaining members refuse its machines'
  strand writes — a side effect of how removal is implemented, not a guarantee the rules
  make. Its node now genuinely attempts the redemption (the re-admission bullet above), so
  that network refusal is the *only* barrier left: an invitation the removed party holds
  will be spent the moment anything lets one of its writes through — a lapse in the
  refusal, or a manager who admits it for one reason without meaning to honour the
  invitation. Cancel the invitation at removal time rather than rely on the refusal.

Known gaps remain, all out of scope of the rules above:

- **Membership rules are checked against the rows one node can see.** The last-member
  floor counts locally, so two nodes each removing a different member can both believe a
  survivor remains. The manager-must-also-be-a-member rule has the same shape: one node
  promoting a key while another node removes that key's membership can each pass locally
  and merge into a manager seat with no membership behind it. A cross-node guard is not
  attempted; tracked in the schema's own notes next to the checks.
- **A seal only binds a node once it gets there.** Sealing is a deletion like any other,
  and it has to reach a node before that node stops recognising the manager. Until it
  does, that node still behaves as though the strand were open for admission — and it is
  not only the ex-manager's own key that gains. Every check that asks "does this strand
  still have a manager?" is answered from the rows *that one node* can see, and the check
  that refuses to redeem an invitation on a sealed strand is one of them. So a stranger
  holding an invitation issued *before* the seal — someone who was never a manager
  anywhere — can still redeem it and join at a node that has not heard about the seal
  yet. Nothing un-joins them once the seal arrives; the strand the members thought they
  had frozen has one more party in it than they agreed to. Once a node *has* the seal it
  refuses all of this, and the seal travels fast: on a two-node strand it showed up
  whole — no half-arrived state — within tens of milliseconds of being made. The window
  is short, but its length on a strand larger than that has not been measured, and no
  cross-node guard is attempted here.
- **An invitation names no invitee, so cancelling one is a manual operator step.** An
  invitation is a bearer credential: whoever holds it can redeem it once, and the strand
  keeps no record of who it was meant for. Managers can now cancel invitations, but nothing
  can cancel them *on a member's behalf* at removal time — a manager has to review the
  outstanding invitations and decide. So nothing in the rules stops a removed party holding
  an unspent, unexpired, uncancelled invitation from re-admitting itself — only the
  remaining members' refusal of its machines does, and its node does try (see "What
  removal still does not do"). Binding an invitation to a specific invitee is tracked as
  `feat-strand-invitee-bound-invites`.
