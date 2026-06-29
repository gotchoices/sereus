----
description: Deciding who counts as a "member" of a party currently just checks whether a peer has published an address; making it mean "authorized" requires a trust decision that touches a subsystem we deliberately put off, so we need a human to pick the scope before building it.
prereq:
files:
  - packages/cadre-core/src/cadre-node.ts (isMember L2542, listMembers L2532, registerSelf L705, authorizePeer L2621)
  - packages/cadre-core/src/strand-wake-protocol.ts (processWakeRequest L207-213 — the wake authorization gate)
  - packages/cadre-core/src/peer-record.ts (currentMemberTrustPolicy L132-146 — "row presence == authority-vouched member" assumption)
  - packages/cadre-core/src/peer-authorization.ts (peerAuthorizationDigest / verifyPeerAuthorization — voucher sign/verify, already exists)
  - packages/cadre-core/src/seed-trust-policy.ts (pinned/DB-anchored/TOFU seed trust — the existing out-of-band anchor)
  - schemas/control.qsql (CadrePeer L56-86 AuthorizedInsert/AuthorizedUpdate; AuthorityKey L4-17)
  - packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (L450-488 non-member reject; L532-607 replication-backed authorize)
  - packages/integration-tests/src/scenarios/cadre-host-authority-node.integration.ts (L166-168 fresh-party empty membership)
  - packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (L155-183 cross-node isMember after authorize)
  - tickets/backlog/seed-accepted-authority-persistence.md (the deferred node-local trust-store design this collides with)
difficulty: hard
----

# Decision needed: how should a party decide who is an authorized member?

## The plain-language problem

A "party" is a group of cooperating nodes. Right now, the code decides whether some
peer is a **member** of the party by one cheap check: *does that peer have an address
record in our local control database?* (`CadreNode.isMember` → `listMembers()` → the
`CadrePeer` table.)

That check is wrong in two ways, and both show up as real failing tests:

1. **A brand-new party already lists itself as a member.** On startup a node publishes
   its *own* address record so others can find it. So a freshly-started party that has
   invited nobody still reports one member — itself.

2. **An outsider can wave its way past the door.** "Membership" is what authorizes the
   most sensitive action we have — waking a hibernating node over the network
   (push-wake). Because *having an address record* is treated as *being authorized*, a
   stranger who simply publishes its own address record first can pass the wake check.
   This is a security gap, not a cosmetic one: a non-member can wake a sleeping strand.

The fix everyone agrees on in principle: **membership must mean "this peer was
authorized by our party's authority," not "this peer has published an address."** The
disagreement — and the reason this needs a human — is *how much machinery to build to
make that distinction reliable*, because the reliable version reaches into a subsystem
we explicitly chose to defer.

## Why this isn't a simple one-line gate change

You might expect: "just have the wake check consult a real authorization flag instead of
address-record presence." We dug into whether that's possible without new machinery, and
it isn't. Here is why, in concrete terms.

### How the leak actually happens

- The party's control database is a single shared, replicating store. The only thing
  that scopes it is the party id. **Any node that uses the same party id and connects is
  in the same store**, and rows it has written become readable to the others by
  ordinary "pull-on-read" replication (this is exactly what
  `control-db-two-node-convergence` proves for the *legitimate* case).

- A `CadrePeer` (address) row can only be *written* if **some** key in the writer's
  *local* authority list signed it (schema constraint `AuthorizedInsert`,
  `control.qsql:62-68`). The codebase leans on this to assume "a row exists ⇒ an
  authority vouched for it" (`peer-record.ts:132-146`).

- The catch: an outsider can be **its own authority**. It mints its own authority key,
  signs its own membership row, and — because it shares the party id — that row
  replicates into our view. The constraint was satisfied (by *its* authority, not
  *ours*), so the row is "valid," and our `isMember` says yes.

### Why a smarter read-time check can't tell the two apart by itself

The only real difference between a legitimate member `S` (vouched by our genuine
authority `A`) and an outsider `O` (vouched by itself) is **which authority signed the
row**. But:

- The `CadrePeer` row **does not record who vouched it.** The authority's signature is
  checked once at write time and thrown away; it isn't stored. (The signing/verifying
  helpers already exist — `peerAuthorizationDigest` / `verifyPeerAuthorization` in
  `peer-authorization.ts` — they're just not persisted on the row.)

- You can't fall back to "is the voucher in our `AuthorityKey` table?" either, because
  **that table is part of the same shared store and replicates too.** A genuine
  authority's key reaches a member that way (`control-db-two-node-convergence` shows
  A's key reaching B). By the same path, the outsider's self-minted authority key would
  also reach us. So the `AuthorityKey` table is **not a pollution-proof anchor** against
  a same-party self-authority outsider.

The upshot: to reliably separate "our authority vouched this" from "someone vouched
this," a node needs a **trusted-authority anchor that does NOT come from the shared,
replicating store** — i.e. a node-local record of "these are *my* party's authority
keys," established out-of-band (from the invite that enrolled me, or from being the
genesis authority myself), plus the voucher recorded on each membership row so it can be
checked against that anchor at read time.

### That anchor is the subsystem we deferred

A node-local, non-replicated trusted-authority store is precisely the work parked in
`tickets/backlog/seed-accepted-authority-persistence.md`, which states it
"belongs to the broader control-sync design ... not active work — promote to plan when
control-sync transaction application is being designed." This ticket is forcing that
question early. **Whether to pull that design forward now to close the membership gap is
a scope/sequencing call that contradicts an explicit prior deferral — so it's yours to
make, not ours to assume.**

## Two other things the decision has to settle

**(a) What does "self" count as?** A recent, deliberate change
(`tickets/complete/authority-self-registration-cadrepeer.md`) made the node publish its
own `CadrePeer` row on purpose, so its dialable address rides along in seeds, and
*inverted host tests to expect self to appear as a member*
(`trust-circle-integration.test.ts:103,108,131-132`). The fresh-party fix wants the
opposite — self absent from the membership list. These aren't actually in conflict if we
separate two surfaces:

- the **addressable set** (who can I dial — includes self; what seeds and push fan-out
  and address resolution use), versus
- the **authorized-member set** (who is a real member / who may wake us — excludes self).

The host CLI already hints at this split: its members listing carries a `self?: boolean`
flag and prints `[self]` (`host.ts:534,542`). The decision is whether to formalize that
into two methods (e.g. keep `queryCadrePeers()`/address resolution as-is; add
`listAuthorizedMembers()` + an `isAuthorizedMember()` the wake gate consults), and which
existing callers move to which surface.

**(b) An empirical question that changes the cost.** Our analysis says the replicated
`AuthorityKey` table is polluted by a same-party self-authority, which is what rules out
the cheap fix. That is *inferred* from how replication works, not measured. If — contrary
to our reading — an outsider's authority key does **not** in fact reach a peer that never
cohorted with it (while its `CadrePeer` row somehow does), then a much cheaper fix
becomes sound: record the voucher on the row and accept it only if the voucher is in our
local `AuthorityKey` table. **Confirming or refuting this with an instrumented run of the
two failing scenarios is the single highest-value next step**, because it decides between
"small fix" and "build the deferred anchor." We did not run it here (integration runs are
long/flaky under the ticket runner's idle timeout); it wants a focused spike.

## The options

**Option A — Cheap, if the empirical question allows it.** Persist the voucher
(authority public key + its signature over the peer-authorization digest) on the
`CadrePeer` row; the membership predicate accepts a peer only if its recorded voucher is
in our local `AuthorityKey` table and the signature verifies; exclude self. *Sound only
if the `AuthorityKey` table is not pollutable by a drive-by self-authority* — i.e.
contingent on the spike above. Smallest blast radius.

**Option B — Robust, pulls the deferred work forward (recommended if the spike confirms
pollution).** Everything in A, plus a **node-local trusted-authority anchor** seeded
out-of-band (the genesis node trusts its own authority key; an invited member persists
its invite's pinned authority keys — the `pinnedKeyTrustPolicy` source). The membership
predicate checks the recorded voucher against *that* local anchor, not the replicated
table. This is the correct distributed-trust answer and closes the gap for good, but it
(i) builds part of `seed-accepted-authority-persistence`, and (ii) ripples through every
cross-node `isMember` assertion — `control-db-two-node-convergence`,
`control-write-while-alone-convergence`, `control-cohort-auto-convergence`, and the two
push-wake scenarios all currently assert a reader trusts an authority it never pinned, so
each must be reworked to model real enrollment (the reader pins the authority). That is
meaningful, deliberate test surface, not a mechanical sweep.

**Option C — Defer the security fix; ship only the cosmetic half.** Do just the self /
addressable-vs-authorized split so the fresh-party test passes, and leave the non-member
wake gap open (it is already known and documented). Not recommended — it leaves the
security hole — but it's the minimal move if you want the anchor design to stay deferred.

## Recommendation

Run the spike (the empirical question) first. If it confirms the `AuthorityKey` table is
pollutable (our expectation), go with **Option B**, sequenced as a `prereq`-chain:
1. addressable-vs-authorized surface split + self handling (fixes the fresh-party test,
   no trust change);
2. record the voucher on `CadrePeer` (schema + `authorizePeer` + control-db read/write);
3. node-local trusted-authority anchor + `isAuthorizedMember` + route the wake gate
   through it + rework the convergence/push-wake tests to pin authorities.
If the spike refutes pollution, **Option A** collapses steps 2–3 into one and skips the
test rework.

## What we need from you

- **Approve pulling the node-local trusted-authority anchor forward now** (i.e. starting
  the `seed-accepted-authority-persistence` design early), or tell us to hold the line
  and ship Option C only.
- **Approve the addressable-vs-authorized surface split** (two methods; self excluded
  from the authorized surface, retained in the addressable one) — and confirm that
  re-inverting the host trust-circle member-count expectations is acceptable.
- **Approve spending a focused spike** to settle the empirical replication question
  before committing to A vs B.

Once you've signed off, this comes back out of `blocked/` into `plan/` (or straight to a
`prereq`-chained set of `implement/` tickets) with the chosen option fixed.

## For reference — acceptance the eventual fix must hit

- Fresh party reports no authorized members; `isMember(randomFreshPeerId)` is false.
- A wake from a peer never authorized by our authority is rejected (`accepted: false`)
  and the strand stays `hibernating`, **even if that peer has a `CadrePeer` address row.**
- Push fan-out and address resolution (`resolvePeerAddrs`) unchanged for legitimately
  addressable peers (including self).
- Full integration suite green (currently 98/100; these two scenarios are the gap).
