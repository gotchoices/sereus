description: Decide whether a party's always-on machines that hold no owner key (donated or hosted nodes) may finish a join on the party's behalf while its phone is offline, which needs them to write two kinds of record that today only an owner may sign.
prereq: pending-join-retry-loop
files: schemas/control.qsql (JoinedStrand.AuthorizedInsert ~395-402, StrandPartyKey.AuthorizedInsert ~330-336), packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/pending-join-runner.ts (from pending-join-retry-loop), packages/cadre-core/src/cadre-node.ts (ensureStrandPartyKey ~5558, enrolledOwnerSigningKey ~2441), docs/architecture.md (JoinedStrand row ~40; cadre-host "holds no owner keys" ~1094, ~2112), docs/cadre-host.md
----
# May a machine that is not an owner finish a pending join?

**Blocked category:** the architecture contradicts a maintainer request. **Unblocks with:** a human choosing A, B or C below (A is recommended), after which this becomes a `plan/` ticket, or is closed for C.

## The conflict

The maintainer, on gotchoices/sereus#25: "In an ideal world, your entire cadre would enter a 'trying...' mode, so even if you exit the app on the phone, your other nodes can try on your behalf."

The architecture says the machines most likely to be "your other nodes" cannot do this:

- A party's always-on machine is usually **donated**: a cadre-host grant, or a cadre-provider container. Both are documented as holding **no owner key** ("the recipient's device is the authority and the host never holds owner keys", `docs/architecture.md` → Provider Integration and cadre-host).
- Finishing a join writes owner-signed control rows:
  - `JoinedStrand`. Its schema comment says it is "deliberately NOT self-signable by an enrolled CadrePeer: every always-on machine of the party downloads the strands this table names, so a non-owner machine could otherwise make them all host an arbitrary strand."
  - For a closed strand, `StrandPartyKey`, the party's membership identity, which `formStrand` seats via `ensureStrandPartyKey` and which throws without an owner key.
  - The outcome on the `PendingJoin` row itself (`pending-join-control-table`).

`pending-join-retry-loop` therefore runs the retries on **owner** machines only: the phone while its node runs, and an always-on machine only when it is an owner (a founding cadre-cli node, a cadre-host running its own cadre). For the common phone-plus-donated-node party, the phone still has to be running for the join to finish.

That gap is smaller than it sounds, because of the inviter-side tickets (`formation-responder-installed-at-start`, `invitation-names-every-party-machine`): when the **inviter** has an always-on machine, the joiner's phone finishes the join as soon as it is itself online. What remains is the case where **both** parties' only always-on machines are missing on the inviter's side and the invitee's phone is closed.

## Options

**A. The owner approves in advance; any enrolled machine may finish (recommended).**

When the phone writes the pending row (owner-signed), it also mints the party key the join will use, `PartyPrivateKey`, and that key is covered by the same signature. Three new insert branches, each requiring the signer to be an enrolled, owner-vouched `CadrePeer` (its machine key, as the `CadrePeer` self-publish already verifies):

- `PendingJoin`: a machine may replace a live **pending** row with an outcome row that copies every owner-signed column unchanged.
- `StrandPartyKey`: a row is allowed when `new.PrivateKey` equals the `PartyPrivateKey` of a `PendingJoin` row that the same transaction turns to `joined` with `StrandId = new.Id`.
- `JoinedStrand`: a row is allowed when the same transaction turns a pending row to `joined` with `StrandId = new.Id`.

What an enrolled machine gains: **once per owner-approved pending join**, it chooses which strand id that join lands on. The honest path gives the same choice to the **inviter**, a stranger, since the strand id comes from the formation result, which the owner cannot check either. A compromised enrolled machine could make the party host one strand of its choosing per pending row. It cannot mint pending rows, and it cannot choose the party key. Cost: three new schema branches in security-sensitive tables, and a `PartyPrivateKey` column, the party's strand identity secret, written before the strand is known. That column is replicated like `StrandPartyKey` already is.

**B. The machine finishes locally and an owner publishes it later.**

The machine runs the formation, keeps the join machine-local (as `formStrand` on a non-owner machine already does), and writes a machine-signed "join result" row. The next owner machine to connect promotes it into `JoinedStrand` and `StrandPartyKey`. The party key is minted by the finishing machine and carried in the result row. Cost: a new machine-writable table, plus promotion logic. Until an owner connects, the join exists only on the finishing machine, and other always-on machines do not host it. The schema does not close the risk A accepts, it only defers it: the owner promotes automatically, because it cannot judge the strand id either.

**C. Owner machines only (what `pending-join-retry-loop` ships).**

No schema change. Donated machines never help. The maintainer's "entire cadre trying" holds only for parties with an owner always-on machine.

## If nothing is decided

C stays in place. Joins still finish whenever the invitee's phone is running and any machine of the inviter's party is reachable. Nothing gets worse.

## Reversibility

- A and B add schema branches and columns. Removing them later needs every party's control database to drop rows that only the removed branch could have seated. That is possible (no backwards compatibility yet), but it should be decided before apps have users.
- C is fully reversible.
