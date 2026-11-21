# Who a node trusts and admits

A node on a party's control network makes five separate decisions about the outside world: which owner keys it believes, whether it accepts a seed, how long it keeps an inbound connection, whether it grants a relay reservation, and which protocols a peer may open streams on. This document describes each mechanism, the attack or failure it prevents, and what it leaves open. It is for maintainers of cadre-core and for operators who need to know what a stranger can reach.

See also: [Owner keys](owner-keys.md), [Adding and removing machines](membership.md) for the seed, claim and invitation flows these mechanisms protect, [How a party's machines converge](control-convergence.md), and [Relays](../network/relay.md).

## The layers

| Layer | Decides | When it cannot tell | Source |
| --- | --- | --- | --- |
| Trusted-owner anchor | Which owner keys this machine believes | Trusts no key it cannot verify | `trusted-owner-store.ts`, `owner-anchor-sync.ts` |
| Seed trust policy | Whether a seed's signer may seed this node | Refuses the seed | `seed-trust-policy.ts`, `claim-proof.ts` |
| Connection gate | How long an inbound connection lasts | Admits the connection | `membership-connection-gater.ts` |
| Relay reservation policy | Whether a peer gets a relay slot | Admits within a small cap | `membership-connection-gater.ts` |
| Protocol guard | Which protocols a peer may open | Refuses the stream | `control-protocol-guard.ts` |

The files are in `packages/cadre-core/src`. The connection gate and the reservation policy admit when in doubt, because a database error must not partition a legitimate cadre. That is safe only because the protocol guard and the anchor refuse when in doubt: a stranger whose connection is admitted can open no members-only stream, and a row a stranger manages to write is disbelieved when it is read.

A **sibling** is another member machine of the same party. An **authorized member** is a peer whose `CadrePeer` row carries a stored proof that verifies against this machine's anchor: an owner's signature over the row, or the chain from a redeemed cadre invitation back to the owner that issued it ([How a row proves it belongs](control-schema.md#how-a-row-proves-it-belongs)). `CadreNode.isAuthorizedMember` is that test.

## The trusted-owner anchor

Each node keeps a non-replicated, per-party record of the owner keys it trusts, each with its provenance (`TrustedOwnerStore`). Every trust decision on the node reads this record, and none reads the replicated `OwnerKey` table directly.

### Why the replicated table cannot anchor trust

A node whose local copy of the control database is still empty satisfies the `OwnerKey` table's founding rule, which tests the owner count before the transaction, so it can seat its own key. That row then replicates into every other machine's table. The table's other rules ([Owner signature](control-schema.md#owner-signature)) stop escalation only against a populated copy. A stranger can therefore make "is this key in `OwnerKey`?" true, and the anchor exists so that no decision depends on that question.

The replicated table keeps two jobs. It carries owner keys to the party's machines, and it is what the control schema checks owner signatures against when a row is written.

### Where anchored keys come from

| Source | How the key enters |
| --- | --- |
| `genesis` | The node wires an owner signer (`useOwnerSigner`), declaring that key an authority of its own party. |
| `invite` | The node redeems a cadre invitation, or an owner grant as a non-member, and pins the bundle's `ownerKeys` before it dials. |
| `operator` | An operator pins the key: `trustedOwners.pinnedKeys` in the node config, which cadre-cli fills from `--pin-owner-key` and `CADRE_OWNER_KEYS`. |
| `claim` | A node waiting to be claimed accepts a seed whose sender proved knowledge of the claim secret, and anchors that seed's signer. |
| `chain` | The node derives the key from the replicated `OwnerKey` table through a proof that verifies against a key already anchored. |

Entries from `genesis`, `invite`, `operator` and `claim` are established out of band and form the **base**. Only `chain` entries come from replicated state, and only along verifiable proofs. Neither cadre-host nor cadre-provider supplies a pin: a hosted node's or a rented container's owner key reaches its anchor through the claim or an invitation bundle, each checked by cadre-core on the node itself.

### How the anchor follows the owner table

Owners are added and removed over a party's life, so every node recomputes its anchor from the replicated `OwnerKey` table as the first step of every membership refresh (`CadreNode.syncOwnerAnchor`). The membership snapshot built in the same refresh then judges rows against the updated anchor. The rule is the pure function `deriveOwnerAnchor` in [`owner-anchor-sync.ts`](../../packages/cadre-core/src/owner-anchor-sync.ts), whose module comment defines each term. In outline:

1. **Start set.** The base, plus every `chain` entry whose `OwnerKey` row is still live: its stamp is not retired by a tombstone ([Stamps and tombstones](control-schema.md#stamps-and-tombstones)). A derived entry is kept state, not re-derived from the base on each pass.
2. **Derive.** Repeatedly add every key whose live row's stored proof verifies against the set so far: a signature by an owner in the set, or a redeemed owner grant whose issuer is in the set and whose three signatures (issuer, grant possession, seated key's consent) all check. The founding row is never derivable, so a founder enters an anchor only out of band.
3. **Remove.** Drop a key when an `OwnerKey` tombstone names it, the tombstone's signer is in the set and is not the key itself, the signature verifies, and the key has no live derivable row.
4. **Apply.** The anchor becomes the derived set minus the removed keys. A pass that would empty the anchor applies no removal and logs the refusal.

The rule has this shape for four reasons:

- **Order independence.** The result is a set fixpoint, and every tombstone is judged against the same start-of-pass set. Two partitions that each added an owner agree after they merge, and a mutual removal of the last two owners is refused instead of being decided by read order.
- **A re-add beats an older tombstone.** A removed owner added again under a fresh stamp has a live derivable row, so the old stamp's tombstone no longer removes it.
- **Rotation works.** When owner A adds A′ and A′ then removes A, A′ keeps its place because a derived entry is kept while its own row is live. Otherwise nothing could re-derive A′ once A's row is retired, and a sole owner could not rotate at all.
- **Base keys can be removed.** A verifiable tombstone removes a pinned or genesis key too. An operator pin of a removed key is anchored again at each start and removed again by the first refresh.

With an empty anchor the sync does nothing. This keeps a node that is waiting to be claimed empty until its claim: the replicated table must never seat the first key.

On the machine that writes an owner change, the refresh runs before the write returns. On every other machine it runs when the row or tombstone arrives by replication ([Table change subscriptions](control-convergence.md#table-change-subscriptions)).

### What the derivation cannot settle

The order of owner removals is not recoverable from replicated state. A removed owner can still file tombstones from a copy that has not yet received its own removal, and those tombstones replicate. A node that applies such a tombstone in a pass before it holds the owner's own removal accepts it. A node that holds both, or receives them in the other order, does not, and further replication does not make the two agree. The remaining owner repairs the difference by adding the wrongly removed owner again under a fresh stamp, which every node then derives.

The window in which a removed owner's writes are accepted is short: every owner lookup in the control schema disqualifies a row whose tombstone the node holds, whether or not the row's delete has arrived.

### What rests on the anchor

- **The membership test.** The connection gate, the protocol guard and the node's choice of who to replicate to all judge a `CadrePeer` row by whether its proof verifies against an anchored key.
- **Seed trust.** The keys a seed trust policy compares a signer against are the anchor's contents.
- **What invitations and grants hand out.** A cadre invitation and an owner grant carry the issuer's anchored keys as `ownerKeys`, and only those. The receiving device anchors whatever arrives, so a key the issuer has not verified must not travel in a bundle. An issuer with an empty anchor refuses to mint.

### Entry checks and persistence

Every key is shape-checked before it enters the anchor (base64url, 32 bytes), and a batch lands all or nothing. One malformed key in a config pin list or in a bundle's `ownerKeys` rejects the whole call, so a typo fails at its entry point instead of sitting in the anchor matching no signer.

The anchor persists through the same `DurableSlot` mechanism as the node's other local records ([Node-local state](node.md#node-local-state)): a file in the node's state directory on Node hosts, a slot the app supplies elsewhere, and memory when nothing is configured. One policy differs. An anchor record that cannot be read in full is discarded entirely, because trusting a subset of the keys a record claims would be a silent downgrade.

## Seed trust policies

A seed carries a signature over its body and the key that made it ([Seed delivery protocol](membership.md#seed-delivery-protocol)). Verifying that signature proves only that the seed is internally consistent. The sender supplies the signer key, and nothing else in a seed claims anyone is an owner, so a forged, self-signed seed passes a signature check. The receiver therefore evaluates a `SeedTrustPolicy` whose input is its own anchor, never the seed body and never the replicated `OwnerKey` table.

A node uses one policy for seeds that arrive over the wire: the claim policy when it was started with `claim`, otherwise `CadreNodeConfig.seedTrustPolicy`, otherwise the anchored default. A local `applySeed(seed, { trustPolicy })` call may override it for that one seed.

| Policy | Trusts the signer when | Then |
| --- | --- | --- |
| `anchoredTrustPolicy` (default) | Its key is in the anchor | Nothing to record |
| `pinnedKeyTrustPolicy(keys)` | Its key is anchored, or is in the given set | A key accepted from the set is anchored, so later seeds need no pin |
| `claimSecretTrustPolicy` | Its key is anchored, or the node is unclaimed and the seed carries a valid claim proof | The policy anchors the signer itself as `claim` |
| `tofuTrustPolicy(confirm)` | Its key is anchored, or the embedder's callback confirms it | A confirmed key is anchored as `operator`, so the prompt is not repeated |

Under the default, a node with an empty anchor and no pin rejects every seed, including one signed by a key that sits in its replicated `OwnerKey` table. Trust on first use is a library option for interactive hosts; cadre-cli does not enable it. A device that joins by cadre invitation needs no seed at all, because redeeming the invitation pins the bundle's owner keys.

### The claim secret

A node that belongs to nobody yet, such as a cadre-host child before its owner scans the QR code, has an empty anchor and would refuse every seed. The **claim secret** resolves this out of band: 32 random bytes minted with the node and shown beside its addresses. `claimSecretTrustPolicy` decides by whether the node's anchor is empty:

- **Unclaimed (empty anchor).** The node accepts the first seed that carries a valid claim proof, which is a keyed hash binding the secret to this node, to the seed's signer and to the seed. The policy anchors that signer under `claim`, and that anchor entry is the durable mark that the node is claimed.
- **Claimed.** The node ignores the secret. It accepts a seed whose signer is anchored and refuses any other signer with `already-claimed`. A claimed node restarted with the secret still configured behaves the same way, so the operator need not remove it.

[Claiming a node](membership.md#claiming-a-node) owns the rest of the flow: the proof construction, the two durable writes that commit a claim, the limit on failed proofs, and the owner's side. The refusal codes are listed under [Seed delivery protocol](membership.md#seed-delivery-protocol).

A node started with `CadreNodeConfig.claim` has the claim as its only cold-start trust source. `start()` refuses `claim` beside pinned owner keys or a `seedTrustPolicy`, before the anchor is written, so a refused start leaves no pin behind that would later read as "claimed".

## The connection gate

The control node composes a membership gate onto any configured `network.connectionGater`, at the point where an inbound connection is encrypted and the remote peer id is authenticated but no protocol has been negotiated. It is not a boundary against strangers. Outside [the bring-up quiet period](#the-bring-up-quiet-period) it admits every inbound connection, and the [per-stream protocol guard](#per-stream-protocol-guard) is the layer that refuses a non-member.

The gate cannot refuse strangers because it sees only a peer id. A device carrying an invitation this node has not received yet, and a sibling machine whose membership row is still replicating, look exactly like an outsider. Refusing would fail both at the connection. So the gate decides something narrower: which admitted peers get a deadline.

Outbound dials are never gated on membership. Strand nodes do not get this gate, because a strand's peers legitimately belong to other parties.

### What it admits outright

A peer the gate can place gets no deadline:

- **Authorized members.**
- **Configured infrastructure**: the node's bootstrap and relay peers.
- **Announced delegates.** A member's strand node runs under a separate libp2p identity that no sibling can recompute, so the member announces that peer id over the members-only strand-addr protocol and the receiver holds a short-lived grant for it ([Delegate grants](../network/strand-addressing.md#delegate-grants)). The grant admits the connection and a relay reservation, and nothing else.
- **Every peer, on a node that cannot judge yet**: one with an empty anchor or no authorized members. A brand-new node must accept its seed, and the rows that authorize its siblings arrive by replication over these same connections.
- **Every peer, while the node expects a stranger**: an unexpired, not fully used formation invitation is outstanding ([Formation invitations](../strands/formation.md#formation-invitations)), or the node holds a live cadre invitation (not withdrawn, unexpired, uses left, issuer still an owner).
- **A device whose redemption this node has verified and is writing**, for a cadre invitation or an owner grant. Its connection carries the exchange.

The "expects a stranger" conditions test expectation, not capability. Every node registers the formation responder at start, and that does not open the window; only an outstanding invitation does. After a restart, only invitations persisted as `FormationInvite` rows count.

### Provisional admission

Every other peer is admitted provisionally: its connection carries a deadline, at which the gate asks the same question again.

- If the peer has become admissible (its membership row arrived, a delegate grant arrived, or the node now holds a live invitation because a redeeming device's row was seated from its bundle), the connection stays.
- If not, the gate closes the connection.
- If the question fails or times out, the connection stays.

The deadline is the relayed-request budget of this node's own declared link, 28.5 seconds at the default ([Dial budgets are counted in round trips, not milliseconds](../network/deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds)). The longest exchange a stranger legitimately starts on a fresh connection is a cadre invitation redemption, and the redeeming device abandons each address after that same budget, so a member never cuts an exchange the device is still waiting on.

A sibling whose row has not arrived by the deadline is closed too. The close starts a reconcile pass on both sides (the pass in which a node redials its party's machines, [Cohort auto-connect](control-convergence.md#cohort-auto-connect)), which forms the link again.

### Why an owner grant does not open the gate

A live cadre invitation admits every stranger outright, and a live owner grant does not. A backup grant has no expiry, so counting it as "expecting a stranger" would keep every member admitting every stranger outright for the party's life. A grant holder is therefore admitted provisionally like any unknown peer. Once the member has verified the holder's redemption and begun writing it, the holder is in the "verified and writing" case, so the exchange is never cut at the provisional deadline.

### A node waiting to be claimed

A node started with a claim secret and an empty anchor (`CadreNode.isAwaitingClaim()`) does not get the full "cannot judge yet" treatment. Its connections are admitted, because the claim seed has to arrive on one. Its control-database streams and relay reservations are refused ahead of every other admission: the only legitimate stranger interaction is the claim seed, the node has no siblings to replicate from, and a node on a public address must not relay for anyone while it waits. Once the claim anchors the owner, the ordinary rules apply.

### The bring-up quiet period

While the node's own control database is being built during `start()`, the gate denies both inbound connections and outbound dials. This is the only state in which it denies, and it is not a judgement of any peer.

The control database must initialize while the node holds no control connections. Initialization reads many blocks, and each read consults the block's cluster, which includes any connected sibling. A sibling that has not yet replicated the booting node's `CadrePeer` row correctly refuses those reads at its own protocol guard, so one connection in this window makes `start()` reject. Retrying cannot converge: the refusal clears only when the booting node's row reaches the sibling, and writing that row needs the database the retry is building.

Start-up ordering already avoids connections here: the node dials relay reservations and the configured `controlNetwork.bootstrapNodes` after bring-up. The quiet period makes that a guarantee. In practice it stops inbound dials and libp2p's automatic dials of peers remembered from a previous run. A denied peer retries. The quiet period also ends when bring-up fails, so teardown is never gated.

The gate also refuses a connection whose transport closed while the decision was being made, whatever the verdict; the reason is in the comment on `createMembershipConnectionGater`.

## Relay reservations from non-members

On a node that runs the circuit-relay server (`network.enableRelay`, on by default for the storage profile), a reservation request is decided separately from the connection it arrives on, at libp2p's `denyInboundRelayReservation` hook.

A reservation is decided separately because closing a reserving peer's connection cannot be repaired from the relay's side. The reserving peer dials the relay, so closing that connection ends the reservation. A later outbound dial from the relay restores a data link but cannot give the remote peer a reservation, and for a peer that is reachable only through the relay the reservation is its address. Every genuine member passes through this state, because a node reserves at the end of its own `start()`, before its `CadrePeer` row has been written, let alone replicated.

The policy (`CadreNode.admitControlRelayReservation`) decides as follows:

- **Refused**: every request while the node is waiting to be claimed.
- **Admitted and not counted**: authorized members, announced delegates, configured infrastructure, and every peer on a node that cannot judge yet. Such an admission also gives back any counted slot the peer took earlier, so a member that reserved before its row arrived leaves nothing spent.
- **Admitted within a cap**: any other peer, up to `network.unauthorizedRelayReservationCap` concurrent peers (default 8). Setting it to 0 refuses every such reservation.

An admitted reservation cancels the peer's provisional connection deadlines, so the connection carrying the reservation outlives the deadline while the peer is still unplaced. A refused reservation cancels nothing.

The conditions that admit a stranger's connection outright (an outstanding formation invitation, a live cadre invitation) do not extend to reservations, because a formation or redemption stream needs a connection, not relay capacity. An invitee that needs a relay slot takes one from the cap, so a live invitation never becomes an unbounded grant of the node's forwarding capacity.

The cap is small because it serves the few genuine members whose rows are still replicating. It is not public relay capacity. The relay server's own limits are described in [Relays](../network/relay.md).

## Per-stream protocol guard

The control node refuses a peer that is not an authorized member on every protocol not declared open to strangers. One table declares the class of every protocol the control node serves (`controlProtocolClasses`), and one function enforces it for every handler, whoever registered it: Sereus, Optimystic, FRET or libp2p (`installControlProtocolGuard`, both in [`control-protocol-guard.ts`](../../packages/cadre-core/src/control-protocol-guard.ts)). No handler checks membership itself, so a handler added later cannot omit the check.

`CadreNode.start()` installs the guard immediately after the libp2p node is built, inside the bring-up quiet period, so before any connection exists. The guard wraps each handler where libp2p looks it up for an inbound stream, so a handler registered at any time is guarded. A control node on which the guard cannot be installed fails `start()`.

### The classes

| Class | Protocols | Who may open a stream |
| --- | --- | --- |
| `stranger-open` | `/sereus/seed/1.0.0`, `/sereus/formation/1.0.0`, `/sereus/cadre-invite/1.0.0`, `/sereus/owner-grant/1.0.0` | Any peer. Each handler makes its own trust decision inside the protocol: the seed trust policy, the formation token, the invitation's or the grant's proof of possession. |
| `transport` | identify and identify-push, ping, DCUtR, AutoNAT, the circuit-relay `stop` and `hop` protocols, WebRTC signaling when an embedder adds WebRTC | Any peer. |
| `members` | `/sereus/strand-wake/1.0.0`, `/sereus/strand-addr/1.0.0` | Authorized members, by a live read of the control database (`isAuthorizedMember`). |
| `members-snapshot` | Optimystic's five control-database protocols (`repo`, `cluster`, `db-p2p/sync`, `db-p2p/block-transfer`, `db-p2p/blob`) and FRET's five | Authorized members, by an in-memory snapshot. |

A protocol missing from the table is guarded as `members-snapshot`, with one `console.warn` per protocol: it works for members and refuses strangers until someone assigns it a class. A unit test starts a node with every conditional protocol enabled and fails when a served protocol is unclassified, so a new handler or a dependency upgrade that adds one fails CI.

### Why two member classes

FRET and the database protocols serve the reads that a live membership check would itself make. A live read from inside their guard would deadlock two machines into refusing each other, so that class uses a snapshot that reads nothing.

Wake and strand-addr have no such dependency and use the stricter live read. This matters most for strand-addr, whose delegate grant hands out connection and relay admission. The live read also has no period during `start()` in which it admits everyone, which the snapshot does. It runs under the asker's own attempt deadline and fails closed: a false answer, an error and a timeout all refuse.

### The membership snapshot

The snapshot is the set of authorized members, held in memory. The rule that reads it (`CadreNode.isControlNetworkMember`) admits a peer in the snapshot, every peer while the node cannot judge yet (not fully started, an empty anchor, or an empty snapshot), and configured bootstrap peers. It has none of the connection gate's stranger conditions: a live invitation admits a stranger's connection so the stranger can redeem, and that stranger's database and FRET streams are still refused. A node waiting to be claimed refuses every peer ahead of all of these.

The snapshot is refreshed in three ways:

- **By local writes.** Every committed write to a membership row triggers the refresh from inside the write, so the writer's own `await` observes the result. This holds for a row written directly through the seed-bootstrap service or the control database too.
- **By replication.** A watch on the membership tables refreshes the snapshot shortly after a replicated change reaches this node's storage ([Table change subscriptions](control-convergence.md#table-change-subscriptions)).
- **At the head of each reconcile pass**, as a backstop.

`refreshMembershipGate()` is public for the one change that writes no row: a newly anchored owner key, which turns rows already present from unauthorized to authorized. A failed refresh keeps the previous snapshot.

The result is bounded staleness by design. A member whose row arrived by replication is admitted when the row reaches the node's storage, and a member added while a node was down is admitted when that node next reads the table.

### Cohort choice

The guard decides who may send to this node. It cannot decide who this node sends to. Optimystic picks the cluster and coordinator for a control block from the peers whose libp2p peer-store record lists the party's `cluster` or `repo` protocol, and any connected peer can get those entries recorded, by opening a stream (libp2p records the protocol before the guard sees it) or by advertising the protocols through identify.

The node therefore passes the same snapshot rule to Optimystic as its network-membership predicate. A peer the rule refuses is never a cluster member, a coordinator, or a target of background block pushes, whatever its record lists. The predicate adds one peer the stream rule does not: a device whose redemption this member has verified and is writing, because that device must hold the rows that admit it.

The outbound rule is as permissive as the inbound one on purpose. A joining node's clusters must include the member that its empty anchor or empty snapshot allows to replicate to it. A joiner whose clusters held only itself would conclude that an existing collection is absent and found a second copy.

### What a stranger can reach

Every connection runs the transport protocols, a redeeming device's included, and refusing identify would make that device treat the member as off the network. A stranger therefore learns the node's listen and observed addresses, its public key, and its protocol list, whose prefix names the party id (which an invitation bundle already carries). AutoNAT dials back only public addresses on the requester's own observed host and refuses a request made on another peer's behalf, so it cannot be aimed at a third machine.

On the `stranger-open` protocols, each handler caps concurrent requests, frame size and read time before its trust check runs (`seed-bootstrap.ts`, `member-redemption.ts`).

### Refusal

A refused stream is reset before its handler runs. Nothing is decoded and nothing is sent, because a reply saying "you are not a member" would confirm membership state to a stranger. The refusing node logs the refusal with a `ControlStreamRefusedError`. On the asking side, a refused strand-addr request records that sibling as unreachable, and a refused `pushWake` rejects.

## Limits and accepted tradeoffs

- **Any stranger can hold a connection for the provisional deadline.** It can open only `stranger-open` and `transport` streams, and libp2p's connection-manager limits bound how many it holds. Accepted in exchange for letting a device redeem an invitation at a member that has not received the invitation row yet. Revisit if stranger connections show up as load on a member.
- **An unclaimed node holds stranger connections with no deadline.** It takes the empty-anchor admission, so a stranger can keep an idle connection to it for as long as it waits on a public address. Revisit by giving those connections the provisional deadline if this becomes a resource problem.
- **A peer whose reservation was admitted keeps its connection.** The provisional deadline is cancelled when the reservation is admitted, not when it succeeds, and is not armed again if the reservation later lapses. Such a peer can open no members-only stream, and the reservation cap bounds how many there are.
- **A reservation slot has no data or duration cap.** A party-run relay forwards without libp2p's per-connection limit, so an unplaced peer is bounded by the count of slots alone ([Relays](../network/relay.md)).
- **FRET's ring still counts a stranger.** FRET classifies peers by their peer-store record and does not consult the membership predicate, so a stranger whose record lists the party's FRET protocols can occupy a ring slot. The control replication breadth (16) exceeds the size of a party, so no member is crowded out, and the stranger is never chosen for a cluster.
- **A configured bootstrap peer is admitted without being a member.** A peer listed in `controlNetwork.bootstrapNodes` passes the connection gate and the per-stream guard before it holds a `CadrePeer` row, so it can open control-database streams and read the control database. The setting exists to name the party's own machines; list only peers the party trusts with that.
- **Membership is judged by peer id.** A node with no persistent identity key never gets a `CadrePeer` row, so its siblings refuse its control-database streams once their snapshots are non-empty, even when it holds an owner key. Supported deployments persist their identity.
- **An owner added by a since-removed owner cannot be derived by a machine that never held it.** That machine's chain from its base runs through the removed owner's retired row. The key stays trusted wherever it was already derived, and reaches the other machine when a remaining owner adds it again or an invitation pins it. Kept this way because an owner rotation has exactly the same shape.
- **An unverified tombstone can prune a derived entry.** The derivation treats a stamp as retired by any tombstone that names it, as the table reads do. A forged tombstone can therefore drop a `chain` entry from an anchor, but can never add or keep one.
- **The guard depends on libp2p's dispatch path.** A libp2p release that stopped looking handlers up the way the guard intercepts would leave it installed and inert, with the unit test still passing. The `control-stream-authz` integration scenario observes dispatch and must be run on every libp2p upgrade.
