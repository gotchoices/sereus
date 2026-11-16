# Several apps in one cadre

A person often runs several Sereus apps, on one phone or across devices. Each app embeds its own node, with its own identity key and storage, and an app started for the first time founds a one-node cadre of its own. This document describes how such an app joins the cadre the person already has: how an invitation gets from one app to another, how the joining app's node changes party, and what happens to the strands it already had. It is for developers building an app on `@serfab/cadre-core` or `@serfab/cadre-rn`.

Related: [the cadre-invitation protocol](membership.md#cadre-invitations) · [owner grants](owner-keys.md#owner-grants) · [the edge node](node.md#the-edge-node) · [`@serfab/cadre-rn` README](../../packages/cadre-rn/README.md) for the calls a React Native app makes · [the reference apps' screens](../platforms/reference-apps.md#joining-an-existing-cadre)

Throughout, **B** is the app that joins, and the one-node party it founded. **A** is the owner app, the app that already holds the person's cadre, and that cadre's party.

## Which credential the app joins with

`EdgeNode.joinCadre` takes one of two credentials (`JoinCredential`), and the choice depends on what B holds.

- A **cadre invitation** admits B's node as a machine of A and grants nothing else. It is enough for an app that has no strands yet. The flows under [Handing an invitation from app to app](#handing-an-invitation-from-app-to-app) produce one.
- An **owner grant** admits the node and seats B's owner key as an owner of A in one step ([Owner grants](owner-keys.md#owner-grants)). B needs it when the party it founded holds strands, pending joins or invitations, because moving them writes owner-signed rows in A ([Moving the app's strands](#moving-the-apps-strands)).

## Handing an invitation from app to app

One app gives another a cadre invitation in one of two flows. Both are built from cadre-core calls, so a phone app, a browser app and the CLI share them. In both, the joining app pins the owner keys the invitation carries, as every redemption does ([Cadre invitations](membership.md#cadre-invitations)).

- **Targeted (request and response)** is the default, because the invitation is useless to anyone else. B produces a join request that names its peer id. The person carries the request to A by paste, QR code or link and approves it there. A mints an invitation for that peer id with `createCadreInvitation({ peerId: request.peerId })` and hands it back, and B redeems it at whichever member it can reach.
- **Open (one paste)** skips the request. A mints an untargeted invitation, single-use and valid for 24 hours by default, and whoever redeems it first is admitted.

### The join request

A join request is the text `sereus-join-request:1.` followed by base64url canonical JSON, encoded and decoded by [`cadre-join-request.ts`](../../packages/cadre-core/src/cadre-join-request.ts). It carries the requesting node's peer id, the name the app calls itself for A's approval prompt, and, only on a request opened as a link, a `reply` that says where A sends its answer ([Between apps on one phone](#between-apps-on-one-phone)).

Nothing in a request is secret or signed, and the name is unverified. The safety is in the answer: only the key behind the peer id can redeem the invitation minted from it.

### Whether another machine could redeem it

`createCadreInvitation` returns `reach` (`CadreInvitationReach`), which says where B could redeem the invitation if the minting machine were unavailable, judged on the addresses of the other machines. In the app flows the minting app is closed or in the background when B redeems, and two apps on one phone cannot connect to each other: a phone accepts no inbound connections, and iOS does not run two apps at once.

| `reach` | Means | What an app does |
| --- | --- | --- |
| `anywhere` | Another machine has a relayed (`/p2p-circuit`), public-name or public-IP WebSocket address. | Hands the invitation over. |
| `local-network` | Other machines are named only at private or loopback addresses. | Says the invitation works on this network only. |
| `issuer-only` | No other machine is named at an address a phone can dial. | Warns that the new app can join only while this one is reachable. |

An always-on minting machine, such as a cadre-cli or cadre-host node, can therefore report `issuer-only` although B can reach it.

### Waiting for a member

B often redeems while no always-on member of A is running. `redeemCadreInvitation(invitation, { waitForMember: true, signal, onProgress })` keeps making passes over the invitation's addresses for as long as every answer is retryable, pausing 5 seconds after the first pass and doubling to a ceiling of 60 seconds. One pass is the default, and `EdgeNode.joinCadre` always waits. `RedeemCadreInvitationOptions` in `types.ts` documents the options.

Every pass sends the same signed request, so a pass repeated after a lost reply spends no second use ([What the device does](membership.md#what-the-device-does)). Once the invitation has expired by B's own clock, B throws `CadreInviteRejectedError` with code `invite-spent`, the code a member's refusal of an expired invitation carries, so a caller handles both alike.

## Between apps on one phone

Two Sereus apps on one phone hand the request and the response to each other by opening each other with a link, so the person confirms once in A and copies nothing. The functions are in the `@serfab/cadre-rn/app-link` subpath, and the native registration is the config plugin's `appLinks` option.

1. B opens a request with `LinkRequestStore.begin`, which saves the request's nonce in B's node-local database, and encodes a join request whose `reply` is that nonce and B's own URL scheme.
2. B opens A with the request link.
3. A decodes the request and asks the person to confirm it, as for a pasted one, unless A holds a pre-approval for the reply scheme ([Recommending another app](#recommending-another-app)).
4. A mints the targeted invitation, or settles on a refusal, and opens the response link, which it builds from `reply.scheme`.
5. B recognises the response link with `parseCadreLink`, takes it with `LinkRequestStore.take`, and joins with the invitation.

| Link | Android | iOS |
| --- | --- | --- |
| Request | The request text itself, `sereus-join-request:1.…` | `<A's scheme>://cadre-join-request/<request text>` |
| Response | `<reply.scheme>://cadre-join-response/<response text>` | The same |

The response text is `sereus-join-response:1.` followed by base64url canonical JSON. It carries the request's nonce, the name A calls itself (unverified), and exactly one of an encoded invitation and a refusal: `denied`, `no-cadre`, `not-owner` or `already-member` ([`join-response.ts`](../../packages/cadre-rn/src/app-link/join-response.ts)).

### Why the answer is a link, not an Android activity result

Android lets an activity return a result to the one that started it (`setResult`). The kit does not use it: receiving a result needs a native module the kit does not ship, and the result is lost when Android kills B while A is in front. A response link reaches a cold-started B like any other link, which is why B saves its open request before it opens A. The cost is that A cannot learn B's package name, which A's confirmation does not depend on.

### How B finds an owner app

**Android uses the system app chooser.** Every Sereus app that opts in registers the `sereus-join-request` scheme, so opening the request text lists every installed owner app.

- **B is listed too** when it also answers requests. If picked, it receives its own request, which it must recognise by its own peer id and not answer.
- **"Always" removes the chooser.** Once the person picks Always for one app, Android opens that app directly until the default is cleared in Android's app settings.
- **The system camera opens the chooser too** when it reads a request QR code. That request carries no `reply`, so A shows the invitation for copying.

**iOS uses the known apps' schemes.** iOS has no chooser, and which app opens a scheme that two apps register is undefined, so B opens one owner app at that app's own scheme. `installedSereusApps` returns the apps in `KNOWN_SEREUS_APPS`, plus the extras the app passes, that `canOpenURL` reports installed. Each queried scheme must be listed in `LSApplicationQueriesSchemes`, which the config plugin writes.

Universal links were rejected for iOS: each app would need a web domain serving an `apple-app-site-association` file, B would still need a list of the domains, and no Sereus app has a domain.

### The reply is a custom scheme, never a web URL

A builds the response link itself from `reply.scheme` and never opens a URL that a request supplied. `requireCadreJoinReply` runs in the request codec in both directions and again in `joinResponseLink`. It refuses anything that is not a lowercase custom URL scheme, including every web or system scheme (`https`, `file`, `intent`, `mailto` and the others listed in `cadre-join-request.ts`). A request therefore cannot direct an invitation, which names the cadre's machine addresses, to a web server.

When the response link would exceed `CADRE_LINK_MAX_LENGTH`, A shows the invitation for copying instead.

### Security

- **A link is a request, never a grant.** What authorizes the join is the confirmation in A, or the pre-approval the person gave in A when recommending the app. A opens a reply link only for a request that arrived as a link, never for a pasted one.
- **An invitation that reaches the wrong app is useless.** It is targeted at B's peer id. An app that takes over B's reply scheme learns the cadre's machine addresses, as anyone shown an invitation does, and gains no access.
- **B takes only the answer to its open request, once.** `LinkRequestStore.take` accepts a response only when its nonce is the open request's and the request is at most 30 minutes old (`LINK_REQUEST_TTL_MS`), and closes the request as it does. Any other answer is refused with `UnsolicitedJoinResponseError`, so a link nobody asked for cannot inject an invitation.

An app that poses as an owner app remains a risk ([Limits and accepted tradeoffs](#limits-and-accepted-tradeoffs)).

## Recommending another app

An owner app can recommend a Sereus app the person does not have yet, or has but has not joined to this cadre, so that the recommended app, B, joins on its first launch with nothing to copy. The kit side is in `@serfab/cadre-rn/app-link`.

1. In A, the person picks B from A's known-apps list and allows it to join as a machine. A records a **pre-approval** with `AppRecommendationStore.approve`: B's scheme and name from A's list, and the party A runs.
2. A opens B's store page (`storePageLink`) when `canOpenURL` reports B not installed, and B itself (`recommendedByLink`) when it is installed.
3. B learns A's scheme from one of the hints in the table (`recommendedBySchemeFromReferrer`, `parseCadreLink`), asks the person whether to join the app that recommended it, and opens A with an ordinary join request as a link, at A's own scheme on both platforms.
4. A takes the pre-approval whose scheme equals the request's `reply.scheme` (`AppRecommendationStore.take`), skips its confirmation prompt, mints the targeted machine invitation and answers by link as for any request.

| Hint | When B gets it | What it carries |
| --- | --- | --- |
| Play install referrer, the store link's `referrer` parameter | Android, at B's first launch after an install from A's link | `sereus-recommended-by:1.<A's scheme>` |
| `<B's scheme>://cadre-recommended-by/<A's scheme>` | Both platforms, when B was already installed | A's scheme |

The iOS store link names nothing about A, because iOS has no install referrer. B then asks to join by choosing the owner app, as any app does, and A still finds the pre-approval when the request arrives.

### A mints nothing until B asks

Every way B can reach A on one phone ends with B opening A with a join request that carries B's peer id and a reply scheme. A mints at that point, targeted at that peer id, and until then stores only the person's consent. The cost is that A's node must be connected when B asks, and one round trip to A. Two alternatives were rejected:

- **An open invitation in the referrer** would be a bearer credential in a parameter of the store URL, which Google's servers receive and store. One waiting in A's storage would be a bearer credential there for its lifetime.
- **A handoff id in the referrer** would be exchanged with A in the same round trip a plain request makes, and it adds a second secret to track.

### B trusts a hint only when its own list names the app

Anyone can build a Play link with any referrer, and any app can open B with any link. B looks the hinted scheme up in its own known-apps list (the kit's `KNOWN_SEREUS_APPS` plus its extras) by exact equality, drops a scheme that is not there, and names the app from its list, never from the hint. A hint can therefore only make B offer to open an app it already knows.

### The pre-approval is single-use, party-bound and lasts an hour

A keeps the pre-approvals in its node-local database (`EdgeNode.recommendationSlot()`), at most one per scheme.

- **Single use.** `take` removes the entry as it returns it, so a second delivery of the request, or a second request racing the first, gets A's usual prompt. If A then cannot mint, the entry is not restored and the person recommends again.
- **One hour** (`RECOMMENDATION_TTL_MS`), long enough to install B from the store and open it.
- **Party-bound.** `take` returns an entry only for the party A was in when the person allowed it, so an A that joined another cadre in between does not admit B there.

## An app joins an existing cadre

`EdgeNode.joinCadre(credential, options)` in `@serfab/cadre-core/edge-node` moves B's one node from party B to party A. Every platform's app runs the same edge node ([The edge node](node.md#the-edge-node)).

### One node per app, keeping its identity

The node is switched to the other party, not doubled.

- **A node serves one party.** Every node-local store is party-scoped and refuses another party's records, and `redeemCadreInvitation` refuses an invitation for another party.
- **A second node with the same identity would collide with the first.** Both would claim one peer id, compete for relay reservations, and open the same strand databases, whose storage scopes are strand ids and are not party-scoped.
- **A second node with a new identity would change who founded the strands.** `publishStrand` records the publishing node's peer id in `Strand.FounderPeerId`, so strands moved into A would name a machine other than the one that founded them in B.
- **The identity is per app, not per party.** The key store holds one identity key, so the peer id in a join request is the peer id that redeems. `EdgeNode.identityPeerId()` reads it before any party is started, so a fresh install can show a join request without founding a cadre first.

### The app's owner key

The app has one owner key, in a key-store slot separate from the identity key ([What an owner key is](owner-keys.md#what-an-owner-key-is)). A machine invitation does not make it an owner of A. It becomes one when a join with an owner grant seats it, when an owner of A adds it, or when the person imports one of A's owner keys into the slot.

A join with an owner grant seats the key already in the slot, and creates one only when the slot is empty. The key may already own party B, which a rollback must be able to start again, so one key can own several cadres.

### A joined party never runs owner genesis

**Owner genesis** is the step of a start that inserts the app's key as the founding `OwnerKey` row of a party that has none. Run on a party whose control database has not arrived yet, it would seat the app as a second founder: the stranger's key that the [trusted-owner anchor](control-security.md#the-trusted-owner-anchor) exists to contain. The **saved start**, the node-local record of the options the node last started with, therefore records in `origin` how the app came to its party.

- **`'founded'`**, or absent, runs genesis on every start. On a party that already has owners, the start wires the slot's key for signing only if it is a live owner and creates no key, so a phone whose owner slot was lost is a member until it imports a backup.
- **`'joined'`** never inserts an `OwnerKey` row. The start wires the slot's key if the party lists it and runs as a member otherwise, so a key that becomes an owner later is wired on the next start.

A start that names no `origin` takes the saved start's when it is for the same party, so a joined party started again from a typed party id does not run genesis. The saved start also carries `formerPartyId`, the party the app founded and left, which the strand move and the dissolve act on.

### The switch and its rollback

`joinCadre` runs in turn with start, stop and restart, so none of them interleaves with it.

1. If the node is already running in A, the edge node redeems on it and wires the owner key. An owner grant redeemed this way also finishes a strand move that an earlier join as a member deferred.
2. Otherwise, when leaving a party the app founded, the edge node exports that party's strands and stores the bundle in the key store. It refuses the join with `StrandsNeedOwnerJoinError`, leaving B untouched, when there is something to move and the credential is a machine invitation.
3. It stops B's node, starts one for A with `origin: 'joined'`, reports status `joining`, and redeems the credential, waiting for a member.
4. Once a member admits it, the edge node wires the owner key, saves the start with `autoStart: true`, adopts the bundle if the key is wired, and reports `running`.
5. If the join is refused, expires, is cancelled, or the start fails, the edge node deletes the bundle, stops A's node, starts again whatever was running before, and rethrows the join's error.

The edge node saves the start only once a member has admitted the app. An app killed while waiting therefore relaunches into B, and a push wake into the killed process starts B too. The next attempt reuses A's partial storage, and an invitation a member already honoured is answered as "already a member" when redeemed again. Calling `stop` during a join cancels it.

After an owner grant, the key's `OwnerKey` row may not have reached the phone when the member admits it. The edge node waits up to 60 seconds for it by default; after that the join completes without the key wired, the strand move is deferred, and a later start wires the key and adopts the bundle.

B's data stays on disk under its own names until the app dissolves B ([Dissolving the party it left](#dissolving-the-party-it-left)).

### Removed from the cadre it joined

When an owner of A removes the app ([Removing a machine](removing-machines.md)) and its node learns of it, the edge node stops the node, deletes A's local storage the way a dissolve deletes B's, and reports status `removed`. The saved start then names `formerPartyId` without starting it unattended, or is deleted when there is no former party, so the app can tell the person and offer to go back to B.

## Moving the app's strands

A party's participation in a strand is recorded in its control database, not in the strand database. Three kinds of row carry it. `Strand` (a strand the party founded) and `JoinedStrand` (one it joined) hold the strand's shared read secret. `StrandPartyKey` holds the party's membership identity, whose public half seats the party's `Member` and `Manager` rows in the strand database.

Nothing in the strand database names a party: `Member`, `Manager` and `MemberPeer` are keyed by member key and peer id. Both stay the same across the move, because the member key is the moved party key and the peer id belongs to the app's one node. The strand's other members see the same member on the same peer and are told nothing.

### Two ends, carried as data

The app runs one node in one party at a time, so no node is ever in both cadres. `exportStrandBundle(node)` reads everything B's node knows about its strands while it still runs. `adoptStrandBundle(node, bundle)` seats the bundle on A's node once the app's key is an owner there, signing every row with that key under one owner approval. Both are in [`strand-move.ts`](../../packages/cadre-core/src/strand-move.ts).

The embedder carries the bundle between the two calls. The bundle holds every read secret, party key and bearer invitation, so it belongs in secure storage; the edge node keeps it in the key store. It contains:

- **Each strand**, with its row, its party key, its saved routing table and the addresses its formation carried. The export reads both `JoinedStrand` rows and this machine's unpublished join records ([What a joiner's node remembers](../strands/keys.md#what-a-joiners-node-remembers)).
- **Every pending join**, with its outcome. A pending join is a control row recording that the party asked to join a strand through a formation invitation.
- **Every formation invitation still redeemable.**

### Write order: peers, then party key, then row

A's strand watcher runs on every change to `Strand` and `JoinedStrand` and launches a new row at once. A closed strand's founder launch looks up the party key and, finding none, mints a fresh one, which would found the strand a second time under a different identity. Adoption therefore seats each strand in this order:

1. The saved routing table and the carried addresses, so that the launch has peers to dial.
2. The party key.
3. The row: `publishStrand` for a strand B founded, an owner-signed `JoinedStrand` insert for one it joined.

Every step is insert-if-absent, and a row already present with the same content counts as moved. The same bundle adopted again after a crash or a transient write failure finishes what is left. One transaction over the whole bundle was considered and declined, because the per-row writers already carry the stamp, signature and retry policy.

### What the report says

`StrandMoveReport` lists each strand under `moved`, `refused` or `failed`. A refusal is permanent: A already participates in the strand under its own identity, or holds a row for it with different content, and keeps its existing membership. A failure is transient, and adopting the same bundle again retries it.

A bundle is not always adopted during the join: the owner key may not be wired yet, or the app may be killed after the start was saved. The next start whose key is wired adopts it before reporting `running`, and `EdgeNode.finishStrandMove()` adopts it on demand. `EdgeNode.pendingStrandMove()` reports a move that is still waiting.

### The founder rule

`publishStrand` records the publishing machine as `Strand.FounderPeerId`. In A that machine is the app's node, which kept its peer id, so the machine that founded B's strands founds them in A, and the founder bootstrap runs at the first launch there ([Strand membership bootstrap](../strands/membership.md#strand-membership-bootstrap)). The bootstrap is insert-if-absent and derives the founding member from the seated party key, so on a strand founded in B it writes nothing.

One kind of row changes provenance. A `Strand` row that B seated without an owner signature, for an open strand created when another party redeemed one of B's unbound invitations, can be seated in A only with an owner signature. Its row in A names the app's node as founder and the app's key as signer. The strand's content does not change.

### Invitations and pending joins

An open formation invitation names the inviting machine, not a party, and that machine is the app's node, whose peer id and relay address do not change. An invitation already handed out therefore keeps dialling the right machine, and copying its `FormationInvite` row into A is what keeps it redeemable.

Adoption copies a row that is unexpired and has uses left, with its use cap reduced by the uses B recorded. It drops, and counts in the report, a row with a `ValidationUrl`, because which keys may validate for A is A's owners' decision, and a row bound to a strand that A does not seat.

Every pending join moves, with its outcome. A `joined` outcome carries the membership invitation that A's membership reconciler has yet to redeem. A request that A already holds for the same invitation is left as A made it.

### What stays in B

Adoption deletes nothing in B. `Strand` and `StrandPartyKey` rows have no reap path, each delete would need a B-owner signature and a tombstone, and B's node is not running when the adoption happens. B's local storage goes as a whole when the app dissolves B.

## Dissolving the party it left

`EdgeNode.dissolveFormerParty()` deletes B's local storage once A holds everything B holds and no other machine is in B. It is local: it writes nothing to either party's control database.

### The check reads B's storage

The edge node's record of the move cannot prove the move complete: it is deleted after an adoption in which nothing failed, and also when it does not parse. The dissolve therefore reads B itself. In turn with start, stop and join, it reads A's holdings, stops A's node, starts a node for B alone (no addresses, no strand launched, nothing saved), exports B's bundle and lists its `CadrePeer` rows, stops that node, and starts A again.

Keeping a record of B's content at the join was rejected: it would be a second durable record that can be lost the way the move record can, and B's storage is the only ground truth.

While a move record for B exists, the dissolve is refused before anything stops, with `StrandMovePendingError`.

### What A must hold

`readStrandHoldings` and `unheldBundleContent` in cadre-core make the comparison, so any embedder can make the same check. A must hold every strand id of B's export, under either kind, and every pending join of B that is still open.

A strand the move refused is one A already holds, so it passes: its data stays reachable from A, and only B's seat in it is lost, which the join already reported. Formation invitations are not compared, because B's node never runs again and an invitation the move dropped has been unredeemable since the join.

### Refusal and discard

Anything A lacks, or a `CadrePeer` row of B other than the app's own node, refuses the dissolve with `FormerPartyNotEmptyError`, which names them. A starts again and nothing is deleted.

Something A dropped after the move, such as a moved strand the person left or a moved join that was dismissed, reads the same as something never moved. The caller may pass the named strand and join ids back as `discard` to dissolve anyway. Other machines cannot be discarded: they may hold B's data, and removing them is the person's choice, made while the app runs in B ([Removing a machine](removing-machines.md)).

### What is deleted

The dissolve deletes B's control database, its party-scoped node-local records, its anchor slot, its unpublished joined-strand records and its move record. The saved start then stops naming B as `formerPartyId`, and A starts again without it. Strand databases stay: a strand's storage scope is its strand id, so A's copy of a moved strand is the same database.

The removal is resumable. The edge node writes a node-local marker naming B before the first deletion and deletes it last. Every start and every dissolve first finishes a removal that a marker names, without checking again, because the check passed before the marker was written. `EdgeNode.unfinishedRemoval` reports a removal the last start tried to finish and could not.

## Limits and accepted tradeoffs

- **An impostor owner app can capture a joining app.** An installed app that registers `sereus-join-request` (Android) or a known app's scheme (iOS) can answer B with an invitation to a cadre of its own, and B would join it and move its strands there. Pasting from the wrong app carries the same risk, and custom schemes give no way to verify the answering app. Revisit when Sereus apps have web domains: Android App Links and iOS universal links bind a link to the app's signing identity.
- **During the pre-approval's hour, an app answering to B's scheme is admitted without a prompt.** A request with reply scheme `S` takes the pre-approval for `S` whichever app sent it, and the answer goes to `S`, so an installed app that registers B's scheme can be admitted. The mitigations are the single use, the expiry, the notice A shows when it admits an app without asking, and the invitation being listed and withdrawable in A. Revisit together with the impostor owner app.
- **A join answered by link admits a machine only.** Whether a request or recommendation answered by link should also carry ownership is not decided. Until it is, an app with strands to bring joins with an owner grant redeemed separately (ticket `decide-app-link-join-carries-ownership`).
- **A failed owner-grant join can leave the key an owner of A.** If the join fails after the grant was redeemed, the slot's key stays an owner of A while the app is back in B. A later join to A, even with a machine invitation, picks the ownership up through that key.
- **An invitation with a `ValidationUrl` does not move.** The move drops it, and B's copy can no longer be redeemed once B's node stops running.
- **A new Sereus app is not offered on iOS until the kit lists it.** `KNOWN_SEREUS_APPS` changes only with a kit release. Until then each app that should find the new one passes it as an extra ([kit README](../../packages/cadre-rn/README.md)). iOS reads at most 50 entries of `LSApplicationQueriesSchemes`.
- **A dissolve restarts A's node once**, because a node serves one party. The action is rare and started by the person.
- **A move record that does not parse is deleted.** B's rows stay in B's storage and nothing adopts them into A; the dissolve check reports them as strands A does not hold.
