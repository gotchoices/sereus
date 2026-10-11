description: Let a node bundle up everything its cadre knows about its strands (the strands, their keys, pending joins, open invitations and the addresses of the other members) and let a node of another cadre, run by the same owner, seat that bundle in its own cadre, so an app's strands can follow the app into the user's main cadre.
prereq: app-joins-existing-cadre-by-invitation
architecture: docs/architecture.md#an-app-joins-an-existing-cadre
files: packages/cadre-core/src/strand-move.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, schemas/control.qsql, docs/architecture.md, docs/strands.md
difficulty: hard
----

# Export a cadre's strands as a bundle, and adopt a bundle into another cadre

This is the cadre-core half of moving an app's strands from the one-node cadre the app founded (party B) into the cadre the user lives in (party A). The phone kit's half, which decides when to export and when to adopt, is `move-strand-between-cadres`; the end-to-end proof is `scenario-strand-moves-between-cadres`.

## The shape of the move

A party's participation in a strand is control-database state, not strand-database state, so a strand follows the rows:

- `Strand` (a strand B founded) or `JoinedStrand` (a strand B joined), carrying the strand's shared read secret.
- `StrandPartyKey`, the party's membership identity, whose public half seats the party's `Strand.Member` / `Strand.Manager` rows in the strand database.

Nothing in the strand database names a party. `schemas/strand.qsql` keys `Member`, `Manager` and `MemberPeer` by member key and peer id, and both stay the same across the move: the member key is the moved `StrandPartyKey`, and the peer id is the app's one node, which keeps its identity when it switches party (settled in `app-joins-existing-cadre-by-invitation`). So the strand's other members see the same member on the same peer, and nothing on the strand side changes.

**Two nodes never run at once.** The app runs one node, in one party at a time. So "a node that is an owner in both cadres" means: the same identity key is an owner in both, with only party A's node running. The bundle is therefore exported by B's node while it still runs, carried across the switch as data, and adopted by A's node once its owner key is wired. This ticket builds the two ends; the kit carries the data.

Rejected alternatives, for the record: opening B's control store from A's running node (the control database is built over a libp2p node and the optimystic network plumbing; an offline read-only mode would be a new mode of `ControlDatabase` for one caller) and restarting into B to read it (two more full node starts on a phone, each of which can fail on its own).

## What to build

### The bundle

A new module, `packages/cadre-core/src/strand-move.ts`, so `cadre-node.ts` (9,471 lines today, `wc -l`) does not grow by the whole feature. The module works over `CadreNode`'s public surface plus the three small accessors listed under "CadreNode" below.

```ts
/** Everything one party knows about its strands, as read from a running node of that party. Carries secrets. */
export interface StrandBundle {
  v: 1;
  partyId: string;                     // the exporting party
  exportedAt: number;                  // epoch ms
  strands: StrandBundleEntry[];
  pendingJoins: PendingJoin[];         // every row queryPendingJoins returned, outcome included
  formationInvites: FormationInviteEntry[];
}

export interface StrandBundleEntry {
  kind: 'own' | 'joined';              // Strand row, or JoinedStrand row / local unpublished join
  row: Pick<StrandRow, 'Id' | 'Type' | 'MemberPrivateKey'>;
  partyKey: string | null;             // StrandPartyKey.PrivateKey when the party holds one
  networkState: PersistedNetworkState | undefined;  // the strand's saved routing table, opaque
  carriedAddrs: string[];              // addresses the strand's formation carried (in memory on the exporting node)
}

export interface FormationInviteEntry {
  token: string; sAppId: string; expiresAtMs: number | null;
  usesLeft: number | null;             // TotalUses minus B's FormationUsage count; null = unlimited
  strandId: string | null;             // a bound invitation's host strand
}

export interface StrandMoveReport {
  fromPartyId: string;
  moved: string[];                     // strand ids now seated in this party
  refused: Array<{ strandId: string; reason: string }>;   // permanent: retrying will not help
  failed: Array<{ strandId: string; reason: string }>;    // transient: retry the same bundle
  invitationsMoved: number;
  invitationsDropped: number;
  pendingJoinsMoved: number;
}
```

`exportStrandBundle(node: CadreNode): Promise<StrandBundle>` reads, from the running node: `queryStrands()`, `queryJoinedStrands()`, this machine's unpublished joined-strand records (B is a one-node cadre, so it never holds a control connection and its connected reconcile pass never publishes them: the `JoinedStrand` table of a solo party is usually empty and the joins live in the KeyStore records), `queryStrandPartyKey` per strand, `queryPendingJoins()`, every live `FormationInvite` row, the network state store's entry per strand, and the carried addresses per strand. A strand id that appears in both `Strand` and `JoinedStrand` is exported once, as `own`.

`adoptStrandBundle(node: CadreNode, bundle: StrandBundle): Promise<StrandMoveReport>` writes into the running node's party, signed by its own owner key (`getIdentityOwnerKey`). It refuses up front, with a typed error, when `node.getControlDatabase()` does not list that key as an owner (`wireOwnKeyIfOwner` false) or when `bundle.partyId` is the running party.

### Why the write order matters

A's strand watcher polls the `Strand` and `JoinedStrand` tables every five seconds and launches, or offers, a new row at once. For a closed strand whose row names this machine as founder, the launch resolves the party key from `StrandPartyKey` and, finding none, **mints a fresh one** (`resolveStrandPartyKey` → `ensureStrandPartyKey`). That key would not be the one that seats the party's `Member` row, and the strand would be founded a second time under a stranger's identity. So, per strand:

1. Save the strand's network state into this node's store (`getStrandNetworkStateStore().save`) and record its carried addresses, so the launch's cohort seed has somewhere to dial.
2. Seat the party key: `ensureStrandPartyKey(id, partyKey)`. Its "a different key is already stored" throw is the refusal for a strand this party already participates in under its own identity.
3. Then the strand row: `publishStrand(id, type, memberPrivateKey)` for `own`; `getControlDatabase().insertJoinedStrand(row, ownerKey, sign)` for `joined` (skip when `queryJoinedStrand` already returns an identical row; refuse on a different one).

After every strand: formation invitations (`publishFormationInvite(token, sAppId, { expiresAtMs, totalUses: usesLeft, strandId })`, skipping tokens whose row A already holds), then pending joins (`insertJoinRequest` then `recordJoinOutcome` when the join had an outcome; the `pendingJoinId` conflict means the row is already there, which the resume path treats as done).

Every step is idempotent: a row already present with the same content is skipped, so the same bundle can be adopted again after a crash or a transient write failure and finishes what is left. The ticket that planned this asked for one transaction in A; per-row idempotent writes through the existing `ControlDatabase` writers were chosen instead, because the existing writers already carry the stamp, signature and retry policy, and the resumable bundle covers a crash between rows.

### What the founder rule does to a moved strand

`Strand.AuthorizedInsert`'s owner branch pins `FounderOwnerKey` to the signing owner. The signer in A is the app's identity key, which is the key that founded B's strands, so `isSelfFoundedRow` stays true in A and the founder bootstrap runs at the first launch there. It is insert-if-absent over `Strand.Header`, `Member` and `Manager` (`bootstrapFounderMembership`), and derives the founding member from the party key seated in step 2, so it writes nothing on a strand that was founded under that key in B.

A strand B **consent-seated** (open, keyless, `FounderOwnerKey` null: a stranger redeemed one of B's unbound invitations and B provisioned the strand) can only be re-seated in A through the owner branch, so in A its row names the app's key as founder. The first launch in A then runs the founder bootstrap over an open strand whose `Header` already exists, which writes nothing. Provenance changes; content does not. Say so in the docs.

### Formation invitations the app handed out

An `OpenInvitation` envelope carries the token, the sApp id, the expiry and the inviting machines' addresses, and no party id. The responder checks the token against the running party's `FormationInvite` table. B's one machine is the app's node, whose peer id and relay address do not change, so an envelope already handed out keeps dialing the right machine; copying its row into A is what keeps it redeemable. Rules:

- Copy a row that is unexpired and has uses left. `usesLeft` is `TotalUses` minus `countFormationUsage(token)` in B; `FormationUsage` rows are append-only history and stay in B, so the count restarts in A at zero against the reduced cap.
- Drop a row with a `ValidationUrl`: its sign-offs verify against a `ValidationKey` row, and which keys may validate for A is A's owners' decision. Count it in `invitationsDropped`.
- Drop a bound invitation whose host strand was refused.
- A spent or expired row is dropped silently, not counted: there was nothing to keep.

### Pending joins

Every row `queryPendingJoins()` returns moves, with its outcome, under a fresh request stamp. A `joined` outcome's `MembershipInvite` matters: for a closed strand it is the seat the party's membership reconciler has not yet redeemed, and `stageMembershipInvitesFromPendingJoins` on A's node re-stages it from the moved row. A `failed` outcome is kept as history for the user to dismiss; the seven-day removal cleans it up. The retry loop on A's owner machines picks the pending rows up at its next read.

### What stays in B

Nothing is deleted in B. `Strand` and `StrandPartyKey` have no reap branch, each delete needs a B-owner signature and tombstone, and B's node is not running when the adoption happens. B's storage as a whole is dropped by `dissolve-empty-cadre`. The kit records completion by deleting its move record (see `move-strand-between-cadres`), which is what dissolve should read as "moved".

### ControlDatabase

- `queryFormationInvites(): Promise<FormationInviteRow[]>`, every row, the shape `queryFormationInvite` returns. `countFormationUsage` exists.
- Nothing else new: `insertStrand`, `insertStrandPartyKey`, `insertJoinedStrand`, `insertJoinRequest`, `recordJoinOutcome`, `insertFormationInvite`, `queryStrandPartyKey`, `queryJoinedStrand`, `queryPendingJoins` exist. The schema does not change.

### CadreNode

Three small public accessors, each one line over existing state:

- `listUnpublishedJoinedStrands(): Promise<JoinedStrandRecord[]>`, the KeyStore records (`JoinedStrandSession` gets an `unpublishedRecords()` that reads `store.list()`).
- `getCarriedStrandAddrs(strandId): string[]` over `formationStrandAddrs`.
- `recordCarriedStrandAddrs(strandId, addrs): Promise<void>` over `recordFormationStrandAddrs`.

Export `exportStrandBundle`, `adoptStrandBundle`, the types and the typed errors from `index.ts`.

### Docs

- `docs/architecture.md` → under "An app joins an existing cadre", a subsection "Moving the app's strands": the bundle, the write order and why, the founder rule, invitations and pending joins, what stays in B. In the control-table list, one sentence each on `Strand`, `StrandPartyKey`, `JoinedStrand`, `JoinRequest` and `FormationInvite` saying the row is re-seated in a party the app moves to (fresh stamp, re-signed).
- `docs/strands.md` → "What a joiner's node remembers": a party that never held a control connection keeps its joins in the machine-local records, and a move exports those too.
- A `NOTE:` at `adoptStrandBundle`'s pending-join step pointing at `tickets/blocked/decide-party-private-labels-and-app-state.md`: if party-private app tables land in the control database, they must move with the strands, and this is the site.

## Tests

- **Adopt is idempotent and ordered** (`packages/cadre-core/test/strand-move.spec.ts`, in-process nodes as `cadre-node-control-replication.spec.ts` builds them): a bundle with one closed own strand and one joined strand; adopt it, then adopt it again. Expected: after the second adoption the party holds exactly one `Strand` row, one `JoinedStrand` row and one `StrandPartyKey` row per strand, the party keys equal the bundle's, and the report lists both ids under `moved` with nothing refused. This is the contract a crash between rows depends on.
- **A strand this party already participates in under its own identity is refused, and the others still move**: seed `StrandPartyKey` for the own strand with a different key before adopting. Expected: that id under `refused` with the reason, the joined strand under `moved`, the pre-existing key untouched.
- Export's reading of the three sources and the invitation arithmetic are checked by inspection and by the integration scenario; no unit test.

## Edge cases & interactions

- **The watcher launches between steps.** Covered by the write order (party key before row) and by inspection of `resolveStrandPartyKey`: with the key seated, the founder launch adopts it and mints nothing.
- **A already holds the strand as a `JoinedStrand` with its own party key** (the user's main cadre had joined the app's strand from B through formation). The party-key mismatch refuses it; the report says A keeps its existing membership. By the second test.
- **A already holds an identical row** (a retry after a crash): skipped, counted as moved. By the first test.
- **The bundle names a strand twice** (`Strand` and `JoinedStrand` in B): exported once, as `own`. By inspection.
- **Owner key not wired on the adopting node**: typed refusal before any write; the caller keeps the bundle. By inspection.
- **A transient write failure mid-bundle** (a control write that lost its quorum): that strand goes to `failed`, the rest continue, and the caller adopts the same bundle again later. By inspection; the first test is the resume contract.
- **A pending join whose request id A already holds** (the user asked for the same invitation from A): the conflict is read as done, the outcome is not overwritten. By inspection of `recordJoinRequest`'s conflict path, which the adopt step mirrors.
- **Bound invitation whose host strand was refused**: dropped, so a redeemer never consents into a strand A does not host. By inspection.
- **Invitation expired or spent at export time**: dropped silently. By inspection.
- **Network state saved under A for a strand A never launched** (adoption, then the app never claims the strand): a harmless orphan entry, forgotten by `forgetStrandPeers` when the strand is ever unpublished or left. By inspection.
- **Party-private app state**: the `NOTE:` above; nothing to do until the blocked decision lands.

## TODO

- Add `queryFormationInvites` to `ControlDatabase`.
- Add `unpublishedRecords()` to `JoinedStrandSession` and the three `CadreNode` accessors.
- Write `strand-move.ts`: the types, `exportStrandBundle`, `adoptStrandBundle` with the per-strand order above, the typed errors (`StrandMoveNotOwnerError`, `StrandMoveSamePartyError`), and the report.
- Export from `index.ts`.
- Write the two specs named under Tests.
- Update `docs/architecture.md` and `docs/strands.md` as listed; place the `NOTE:`.
- Run `yarn lint`, the cadre-core typecheck and test suite.
