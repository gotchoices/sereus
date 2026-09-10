# Strand Contracts (Human Agreements)

> **Design-stage.** Nothing in this document is implemented. It records the agreed design for
> attaching human-readable legal agreements to strands, so implementation tickets can be cut
> from it. Companion documents: [`architecture.md`](architecture.md) (strand formation, control
> schema), [`strands.md`](strands.md) (membership/RBAC), and the Stroc workspace (`../stroc`,
> referenced throughout). [`strand-contracts-review.md`](strand-contracts-review.md) records
> the critical review this design was revised against.

## Purpose

A strand already pins its **machine contract**: `Strand.Header` carries `sAppId`,
`sAppSchema`, `sAppSignature`, `Engine`, `EngineVersion` — the rules a joining party's nodes
will enforce. This design adds the missing twin: the **human contract**, the legal text a
party agrees to, bound into a signature that proves it agreed.

Three goals:

1. **Binding**: a party's signature provably covers the exact terms in force, the way a
   MyCHIPs tally signature covers the tally contract's hash. Signing is its own act, recorded
   in the strand — **joining a strand and signing its contract are separate events**.
2. **Recognition**: a party keeps a registry of documents it has already reviewed, so that a
   new strand presents a *breakdown* — which sections are standard text it has approved
   before, which differ from an approved version, and which are novel and need reading.
3. **Generality**: one mechanism serves Taleus tallies, chat terms of use, health consents and
   VoteTorrent rules. An sApp adopts it without the contract layer knowing anything about that
   sApp.

## Background: Stroc

Contract documents are [Stroc](../../stroc/docs/Specification.md) documents — the successor to
MyCHIPs' sDoc/strdoc format. The properties this design leans on:

- **Content-addressed.** A document's identity is its CID: normalize (NFC, whitespace,
  entities) → encode IPLD DAG-JSON (canonical key order) → SHA-256 → CIDv1. Presentation
  never affects identity; wording always does.
- **Composable.** A section may be a *reference section* — `{"source": "<cid>", "as": "Alias"}`
  — incorporating another document at that position. The MyCHIPs Tally Contract is already a
  thin wrapper over nine section documents (Recitals, Ethics, Credit_Terms, …) included this
  way. Composition recurses to any depth.
- **Verifiable anywhere.** Any holder of a document can recompute its CID; any fetch from any
  source is trustless because verification is hash equality.
- **Multilingual by wrapper.** A wrapper document includes per-language versions by reference
  and states the governing language as hashed content; the strand references one CID.

Stroc ships `@stroc/core` (CID compute/verify, normalization, validation) and a Lit-based
editor. Everything else this design needs from Stroc is unwritten — see
[Prerequisites](#prerequisites).

---

## Core Model

### One primitive

Every legal act on a strand is the same thing: **a signer executing an instrument under
parameters, with a binding of its own**. Offer, acceptance, amendment, posting, notice,
attestation, renewal and closure are all this one row with different templates. There is no
separate amendment mechanism, no separate consent mechanism, and no separate attestation
mechanism.

An act names four content-addressed things plus a key:

| Part | What it is |
|------|-----------|
| `ContractCid` | The **instrument**: a Stroc template whose prose is role-generic and identical across every strand that adopts it. |
| `ParamsCid` | The **agreement parameters**: what is shared by every signer of one agreement. Role definitions, required-signer policy, notice periods, governing law, posting rules, end date. |
| `BindingCid` | The **signer's binding**: the role it executes, its identity bundle, its own declarations, and — for a posting — the values it is posting. |
| `SignerKey` | The key that executed the act. |

Agreement identity is the pair `(ContractCid, ParamsCid)`. Two parties are parties to the
*same* agreement exactly when their signatures name the same pair. A signature is
`(ContractCid, ParamsCid, BindingCid, SignerKey)`.

`ParamsCid` is always present. A standalone unilateral instrument that shares nothing names
the CID of the canonical empty object; a posting's params name the agreement it serves.

### Signed content is immutable

Nothing inside `ContractCid`, `ParamsCid` or `BindingCid` is ever revised in place. Changing
any of it is a new version, re-executed by whoever the instrument says must sign.

**Position in a signer's own binding confers no permission to change it.** A binding says who
*asserts* a datum, never who may revise it. A party may not edit its legal name, tax ID or
executed role, because those are precisely the representations the counterparty relied on in
agreeing at all (MyCHIPs' `Representations`: "the identity of each Party, as represented in
the Tally, is true and accurate").

That rule is only affordable because of postings.

### Mutable values are postings

Values that legitimately move — credit limits, notice addresses, contact endpoints, consents
— are **not** agreement parameters. They are **postings**: unilateral instruments signed by
the party they belong to, which the agreement references **by role and template CID, never by
posting CID** (pinning a CID would pin a version and defeat the purpose).

The agreement binds only the rules governing them:

- who maintains a posting of each kind, under which template;
- the **ratchet** — MyCHIPs' rule that a tightening takes effect only after the
  previously-posted notice period elapses ("when reducing the call from 120 to 30, the
  effective terms will still be 120 until that period of time has first elapsed");
- the fallback when a posting is missing or stale.

This is where recognition is won. Stable template text is what lets the registry match, but
a tally whose credit limits sit in its parameters has *unique* parameters, so every tally's
parameters are novel and must be read in full. With terms in postings, a tally agreement's
parameters shrink to the parties, their roles, the tally id and the date — a table of names
and a date — and `(ContractCid, ParamsCid)` becomes identical across a very large number of
tallies.

MyCHIPs reached the same conclusion the hard way: credit terms live inside the signed tally,
yet are described as changeable at will, so the schema carries `hold_sets`/`part_sets` as
*cached live values* beside the signed `hold_terms`/`part_terms`, with settings implemented as
a special kind of chit "so they can benefit from the existing chit exchange and consensus
protocol". `Credit_Terms` is therefore reclassified here as a **posting template**, not a
clause of the agreement — which is what it already reads like ("Maximum Balance (limit);
Default: 24").

### Instrument declaration

A Stroc document that is meant to be *signed* declares itself, replacing MyCHIPs' `top: true`
marker with something that carries real information. Nothing else may be named as a strand's
`ContractCid`.

The declaration states:

- **roles** it defines, and whether each is transferable;
- **required-signer policy** — which roles must sign for the instrument to be executed;
- **`requiredKeyClass`** — `member` or `party` (see [Key class](#key-class));
- **maximum offer expiry** — the longest `ExpiresAt` an offer under this template may carry;
- **revocability** — whether a unilateral instrument under this template may be revoked by its
  signer;
- **surviving sections** — which sections outlive termination;
- **expected posting kinds** — template CID and the role responsible for each;
- **parameter schema** — names, types, and defaults for both agreement parameters and binding
  fields.

v1 stores and displays the declaration. Machine validation against it is vNext; until then
review is the check.

---

## Anchoring: `Strand.Header`

Two nullable columns on the `Header` singleton in `schemas/strand.qsql`:

```sql
	-- CID of the Stroc instrument governing this strand (null = no human contract)
	ContractCid text,
	-- CID of the agreement parameters completing the pair
	ParamsCid text,
```

`Header` is `InsertOnly`, so the pair it names is immutable with the header. It is the
**founding proposal** — what the founder put on the table — not proof anyone executed it.
Execution lives in `Signature`, and the founding pair carries no privilege beyond being first:
any member may later propose a different pair. A constraint ties the pair together
(`ParamsCid` null unless `ContractCid` present). Open and closed strands both carry the
columns.

Null means *this strand carries no legal instrument* — a chat with no terms. It does not mean
"testing": a test strand adopts an explicit non-binding wrapper template (MyCHIPs'
`Tally_Testing` pattern, which wraps the real contract in a clause voiding it) so that test
strands exercise the whole signing path.

---

## Signing

Joining a strand and signing its contract are **distinct acts**. Joining admits a party's
nodes to the network and, on a closed strand, seats its `Member` row — untouched by this
design. Signing is a first-class event recorded in the strand:

```sql
	table Signature (
		StrandId text,          -- Header.Id: binds this act to THIS strand
		ContractCid text,       -- the instrument executed
		ParamsCid text,         -- agreement parameters (empty-object CID if none)
		BindingCid text,        -- this signer's binding
		SignerKey text,         -- the key that executed the act
		SignedAt datetime,
		-- Required while the instrument is not yet fully executed; see Offers below
		ExpiresAt datetime null,
		-- ed25519 over ('Strand.Signature', 'v1', StrandId, ContractCid, ParamsCid,
		--               BindingCid, SignerKey, SignedAt, ExpiresAt)
		Sig text,
		primary key (ContractCid, ParamsCid, BindingCid, SignerKey),
		constraint InsertOnly check on update, delete (false),
	);
```

`Sig` is stored and self-authenticating rather than passed through `with context`, and the row
carries no `StampId`. That departs from the sibling membership tables deliberately: the
primary key **is** the replay guard, the same argument `schemas/strand.qsql` already makes for
`Invite`/`ConsumedInvite`. Nobody can forge a row for another party's key, because `Sig` must
verify against `SignerKey`.

`StrandId` in the digest is not optional. Instruments and role-generic parameters are by
design identical across many strands, so without it a signature row lifted from one strand
verifies in any other strand that adopted the same pair. MyCHIPs avoided this because the
tally digest covered the tally UUID.

`SignedAt` and `ExpiresAt` are stored through the same `canonicalDatetime()` transform used
for `Invite.Expiration`, so both sides of a comparison hash identical bytes.

Why signing is separate from joining:

- **Review can happen in-band.** A party may join, sync the `Document` table, take its time
  over the breakdown, and sign afterwards — instead of welding the legal act to the admission
  handshake.
- **The signature block is strand data.** Every member's nodes replicate the rows, so any
  reader re-verifies who executed what — the tally-signature-section analog, held where the
  contract is held.
- **More than one document, more than one moment.** Postings, notices, riders and replacement
  agreements are each their own act against the same table.

What an admitted-but-unsigned member may *do* is policy, not schema: the sApp's constraints
can gate writes on `exists (select 1 from Signature ...)`, and the instrument can state grace
terms for the window between joining and signing.

### Key class

The instrument declares which class of key may execute it. Fixing one answer for every sApp
would be wrong in both directions: requiring an enclave-held ceremony for every acceptance
defeats the low-friction path this design wants for public strands, while permitting a
replicated software key on a credit obligation gives up what MyCHIPs protected.

- **`member`** — the strand `Member.Key`. Cheap, in-band, verifiable from strand tables alone.
  Adequate for terms of use, participation rules, chat confidentiality.
- **`party`** — a key the party controls outside the strand's replication: an enclave-held
  owner key, or a signing key registered by the member. Required for anything creating an
  external obligation — tallies, guarantees, health consents.

The `party` class needs a registration the strand itself can verify:

```sql
	table SigningKey (
		MemberKey text,
		Key text,               -- party-controlled signing key being registered
		StampId text not null unique,
		primary key (MemberKey, Key),
		constraint InsertOnly check on update, delete (false),
		constraint Authorized check on insert (
			exists (select 1 from Member M where M.Key = new.MemberKey
				and verify(digest('Strand.SigningKey', 'register', new.MemberKey, new.Key, new.StampId),
				           context.Signature, M.Key, 'ed25519'))
		),
	) with context (Signature text);
```

A `Signature` row is admissible when `SignerKey` either is a live `Member.Key` (`member`
class) or appears in `SigningKey` (`party` class).

**Membership is checked at insert time only — never at read time.** A departing member's
`Member` row is deleted, but the obligations you most need to enforce afterwards
(confidentiality, data destruction, an unsatisfied balance) are precisely that party's. So
`Signature` and `SigningKey` are insert-only and independent of live `Member` rows. A
verification path that joins to `Member` on read silently voids the signatures that matter
most. The same reasoning covers re-key, which is remove-then-add: signatures under the retired
key remain valid acts.

### Offers, and why there is no withdrawal

**A signature over a pair is an offer while the other required signers are absent, and an
acceptance once they are present.** That is MyCHIPs' `H.offer`/`P.offer`, and it is all the
negotiation machinery this design needs. A counterparty that wants different terms signs a
different pair — a counter-offer — rather than being limited to accept-or-walk-away.

**Every signature that is not yet an acceptance carries a mandatory `ExpiresAt`, and there is
no withdrawal mechanism at all.** An offer lapses on its own; it is never revoked.

Withdrawal is the wrong mechanism here specifically because a strand has no global order:
"was the withdrawal replicated before the acceptance was signed" is not answerable from the
rows, so every withdrawal has a window in which two honest parties hold valid contradictory
signatures — the worst possible failure for a legal record. Expiry is decidable from the
digests alone: both sides read the same `ExpiresAt` and the same `SignedAt`, and the question
reduces to clock honesty, which the offeror checks on receipt.

Firm offers with a stated expiry are a long-established instrument, so this costs no legal
expressiveness. A party wanting room to change its mind offers with a short expiry and
re-offers; the instrument's declared maximum expiry stops a counterparty being handed a stale
option. Breach and mistake are asserted as instruments *against the executed agreement*, never
by unforming it, so the record stays monotone.

Superseding an outstanding offer stays expressible: file a replacement whose binding names the
prior one. If the counterparty accepts the old one before it expires, the old one binds —
correct under the firm-offer rule.

### Unilateral instruments

Because signatures are per-signer rows each carrying their own binding, the table is not
limited to mutual n-party contracts. A representations-and-warranties instrument is a
role-generic template ("the Declarant represents…") plus a signer's binding, executed by
**one** party. Postings, notices of termination, consents and attestations are all this shape.
The mutual contract is the special case where every role the instrument requires has signed
the same pair.

Renewal is a fresh binding under the same pair: a new `BindingCid` with a new date, which the
primary key admits without any nullable-column trick.

---

## Ending an Agreement

Three situations behave differently and all three are supported:

1. **Natural expiry** is an **agreement parameter** — an end date in `ParamsCid`. Decidable
   from the signed pair alone, no new mechanism, immune to ordering disputes.
2. **Termination by notice** under the agreement's own terms is a **unilateral instrument**.
   The notice is unilateral; its effect is determined by the agreement it names. Same layering
   as a posting: the instrument asserts, the agreement interprets.
3. **Termination conditioned on observable state** — MyCHIPs' `C.open → close` completes only
   when the tally balance reaches zero; a health consent may require records destroyed.

Case 3 needs care because **the condition is app state, not contract state**. The contract
layer records "notice filed, effect per terms"; the **sApp** computes in-force status. The
closing party then files a **Certificate of Closure** once the condition is met, giving the
chain a verifiable terminal record — MyCHIPs effectively does this, since reaching `close` is
an observable agreed state.

Revoking a *unilateral* instrument is separate: there is no counterparty agreement to
interpret the notice, so revocability is declared by the instrument itself.

**In-force status is per-clause, not one boolean per agreement.** Confidentiality, data
destruction, dispute resolution and unsatisfied balances survive termination by design; the
instrument declares which sections survive. Revoking a health consent ends one scoped
permission while the provider's undertaking continues.

## Effective Agreement

For a given instrument, the agreement in force is the latest pair that is **un-expired**,
**un-terminated**, and for which **every role the instrument requires has signed** — plus the
postings currently in force under it, and any surviving clauses of superseded or terminated
predecessors.

The required-signer policy comes from the instrument, not from a global rule. "All current
members" is right for a small mutual agreement and wrong for a chat whose terms of use are
executed once by an Operator and accepted individually by each joiner.

In v1 this is computed app-side. Making it a machine-checkable view over `Signature` waits on
the instrument declaration being machine-readable.

## Roles

**Legal roles are never derived from the RBAC tables.** A role is declared by the instrument
and bound in the signer's binding. Whether a role-holder also holds a `Manager` row is
orthogonal, and may be many-to-many or empty.

This is not a style preference. `Manager` carries
`constraint OnlyClosed check (exists (select 1 from Header H where H.Type = 'c'))`, as do
`Member`, `MemberPeer` and `Revocation` — so an open strand has no membership or manager rows
at all. On a closed strand, manager is rotating, resignable and sealable: the founding manager
can resign, one manager can remove another, and the table can be deliberately emptied. Mapping
a legal role like "Operator" onto "Manager" would hand a strand's terms of use to whoever
happens to hold a manager row, and lose the role entirely on a public strand.

Role succession is therefore explicit: the instrument declares a role transferable, and the
transfer is a signed instrument executed by the current holder.

## sApp Integration

The machine contract and the human contract are linked at the schema. **The signed sApp schema
may declare which instruments it requires or permits** — a set of template CIDs, or a
publisher key. A chat sApp can then require its terms of use, and the sApp's own constraints
gate writes on `Signature` rows for those templates.

This is a small addition to the strand-start schema verification already in place, and it is
what makes "the sApp decides which keys matter" concrete rather than an aspiration.

## Party-Private App State (Interim)

Answers **gotchoices/sereus#6**. sApps regularly need state that belongs to one party alone —
a read position, a draft, a UI preference — that should still follow that party across its own
devices. No facility for this exists today, and none is planned before the initial release; the
real design (shape undecided) is tracked in `backlog/feat-party-private-app-state`.

**Interim answer:** store the value in the strand database, keyed by the owning party (e.g. a
row per member id).

**Caveat — read this before using the workaround.** The strand database is visible to every
member of the strand: any member can read any row in it, regardless of which key it is stored
under. A per-user key partitions the data by owner; it does **not** hide it from anyone else in
the strand. Do not put anything there whose disclosure to a fellow strand member would matter.

**The key does not protect writes either.** Nothing about a per-party key stops another member
writing to that row. If it matters that only the owner may change their own value, the sApp schema
has to say so with a check constraint over the writer's identity — the mutation-context pattern in
[`schema-guide.md` → Roles & Permissions](schema-guide.md#roles--permissions-schema-enforced-via-context).

**Node-local storage is not an alternative.** `packages/cadre-core/src/node-local-snapshot.ts`
is deliberately never replicated, so state kept there does not follow a party to a second
device — which is usually the entire reason this state is wanted in the first place.

**Migration.** Data stored under this workaround will need to move once the real facility
ships; no migration plan exists yet.

---

## Self-Contained Storage: `Strand.Document`

The strand carries its own legal text:

```sql
	table Document (
		Cid text primary key,
		Body text,  -- the Stroc document (or params/binding object) as canonical DAG-JSON
		constraint InsertOnly check on update, delete (false),
	);
```

At founding, the bootstrap writer inserts the full instrument tree (wrapper plus every
transitively referenced document) and the parameter object. Every member's nodes then sync the
complete agreement with the strand itself — no dependency on any external store after joining,
and any reader re-verifies every row by recomputing `Cid` from `Body`.

**Inserts must be gated.** Nothing in the sketch above stops a member filling the table with
junk on a closed strand, or anyone doing so on an open one. Require the insert to ride in the
same transaction as a `Signature` that references it, or at minimum a member signature over
the CID.

**Verification placement.** A CHECK of the form `Cid = cid(Body)` needs a CID function the
engine does not have. Until it does, verification is app-layer, and the caching rule is
explicit: a document verified once on insert is not re-verified on every read; a reader that
did not perform the insert verifies on first read and caches the result by CID. Tampering
stays detectable because the CID is the identity. An engine-level `cid()` is a nice-to-have,
not a blocker.

### Pre-join availability

A closed strand gates reads on membership, but a joiner must read the instrument **before**
signing. The invitation carries the agreement pair — two CIDs, small enough for a QR or link —
and the joiner resolves the documents up a trustless ladder:

1. **Local registry cache** — standard sections are usually already on hand.
2. **The inviter** — a document-fetch RPC (`/sereus/doc/1.0.0`, modeled on the existing
   control-stream protocols: length-prefixed JSON frames, CID request → document bundle
   response). The formation path can also inline the bundle in a protocol frame.
3. **A public document-library strand** — a public open strand whose sApp is just the
   `Document` table. It reuses the same fetch RPC and the same verification, needs no new
   infrastructure, and does not block on IPFS, which Sereus does not have and Stroc is itself
   waiting for.

Every hop verifies hashes locally, so no source needs to be trusted.

**The pre-join receipt.** The formation disclosure carries the agreement pair so the breakdown
runs before a party commits to joining, and the joiner's disclosure signature
(`FormationUsage.PeerSig`) then serves as a receipt of having been shown the terms — but only
if the joiner **echoes the pair into its own disclosure**. The consent digest covers
`(Token, UsageStampId, PeerKey, Disclosure)` where `Disclosure` is the joiner's own text, so
without the echo the signature covers nothing about the contract. Note also that the row lives
in the **host's** control database: this is host-held evidence of disclosure, deliberately
distinct from executing the terms, which only a `Signature` row does.

---

## The Registry: `KnownDocument`

Per-party review memory lives in the **control database** — replicated across the party's
cadre, so approvals follow the user across devices:

```sql
	table KnownDocument (
		Cid text primary key,
		-- 'approved' | 'rejected' | 'seen' (extensible; see publisher trust below)
		Verdict text,
		-- root CID of the composition under which the verdict was given (null = standalone)
		ContextCid text null,
		Label text null,      -- user's own note
		DecidedAt datetime,
		StampId text,         -- one-off marker, owner-signed add/remove per control conventions
	);
```

Writes are owner-signed add/remove-only with `StampId` + `Revocation` retirement, matching the
sibling control tables. The registry is **flat**: one row per CID at any granularity (whole
contract, wrapper, single clause). Tree structure is not stored; it is recovered by resolving
the composition at review time.

`ContextCid` upgrades the breakdown's hints: "approved under this same parent before" is a
stronger signal than "approved this text somewhere once". A segment approved standalone
(`ContextCid` null) matches anywhere.

**Rejection is sticky.** Last-writer-wins on the `Cid` primary key is wrong for the verdict
that matters for safety: a later `approved` row from another device would silently overwrite a
`rejected` one. Either keep verdict history, or refuse to overwrite a rejection without an
explicit override the user performs knowingly.

## The Breakdown

When a party considers joining a strand, or is presented with any instrument:

1. **Resolve** the instrument tree from `ContractCid` via the ladder above; hash-verify every
   node. Resolve `ParamsCid` the same way.
2. **Classify** each node against the registry:
   - **approved** — exact CID match; render collapsed, with a context marker when
     `ContextCid` also matches the parent.
   - **modified** — the document declares it `replaces` a CID the party has approved, or —
     fallback heuristic — a sibling `as`-alias or title matches an approved document; render a
     diff against the approved version.
   - **rejected** — explicitly rejected before; flag loudly.
   - **novel** — no registry row; must be read.
3. **Render**: outline of the whole composition ("9 sections — 7 previously approved, 1
   modified, 1 new"), parameters as a data table, novel text expanded.
4. **On acceptance**: the registry gains the wrapper CID and any newly approved segment CIDs
   (each with `ContextCid` = the wrapper). Acceptance clears the way to join; **executing** the
   instrument is the separate `Signature` row.
5. **Policy knob**: a party may opt into auto-accepting when *every* segment is already
   `approved` and the parameters pass a party-defined filter — low-friction entry to public
   strands built entirely from standard text. This is why key class is declared per instrument
   rather than fixed: auto-acceptance only makes sense when signing is cheap.

**Semantic caveat (belongs in every UI surfacing the registry):** a registry hit means "you
have read this text before", never "this text is safe regardless of context" — a clause's
meaning depends on its siblings. The legal act is always the signature over the whole act;
segment approval is a review aid, not a legal shortcut.

### Clause modularity

A "clause" needs no new concept: it is a small Stroc document included by reference.
Addressability stops at the section boundary, so clause-level recognition requires authors to
factor clauses into their own documents. The breakdown rewards exactly that, so standard clause
libraries are the expected equilibrium (the shared MyCHIPs Ethics document is the existing
proof).

Two constraints limit how far this goes today, and both need Stroc work:

- **Cross-references bind a clause to its parent.** Stroc validates `<ref:Alias/Section>` at
  save and blocks save on an unresolved reference, so a clause referencing a sibling cannot be
  saved standalone and means something different under a different parent. Either restrict
  library clauses to internal references, or gain external references validated at composition
  time.
- **Defined terms have no carrier.** MyCHIPs relied on capitalized terms like "Product" and
  "Pledge of Value" defined in `Recitals` and `CHIP_Definition`, which worked only because
  every tally used the same composition. A definitions convention — a template declares defined
  terms; library clauses use without owning them — is needed before a real library works.

---

## Supersession

"This contract replaces that one" exists at two layers, deliberately kept apart:

1. **Authorial lineage — in the document.** Stroc gains an optional `replaces` metadata field
   (array of CIDs, part of the hashed content): the author's assertion that this document
   supersedes those versions. This gives the breakdown a *deterministic* diff target instead of
   the title-match heuristic. The claim is advisory — anyone can publish a document claiming to
   replace anything — so the registry treats it as a diff hint and lineage display, never as
   inherited approval.
2. **Executed supersession — in the strand.** A signer's **binding** names the act this one
   supersedes. Replacement documents are inserted into `Document`, and signers execute the new
   pair with the binding pointing at the old — the chain of executed acts is walkable and
   re-verifiable from strand data alone. The two layers should normally agree, and the
   breakdown flags a mismatch.

The supersession claim sits in the binding rather than in a column because it is the *signer's*
claim about its own act, not a fact about the agreement.

**Amendment needs no further machinery.** An amendment is a replacement agreement plus fresh
signatures. `Header` stays `InsertOnly` and its pair is never rewritten; the effective
agreement is computed as described above. Postings absorb the routine changes that would
otherwise force an amendment round.

---

## Rendering an Executed Agreement

The design is not finished at the data layer. A party needs the artifact it would retain or
take to court, and MyCHIPs had one (`buildpdf.js`, specified in `learn-contract.md` → "Tally
Agreement Layout"): contract text with per-section hashes, both certificates, both parties'
terms as tables, the tally UUID/date/digest, both signatures, QR codes.

The canonical rendering of an executed agreement contains:

- the instrument text, fully resolved, with each section's CID;
- the agreement parameter table;
- each signer's binding, including its identity bundle and role;
- the postings in force, with their dates;
- the strand id, every CID, and every signature.

**Any party must be able to produce it offline from `Document` and `Signature` rows alone.**
That is the test the storage design has to pass, and it is why the strand carries its own text
rather than referencing an external store.

## Identity Bundles

A binding's identity bundle is what makes an agreement enforceable against a person rather
than against a key. MyCHIPs embedded a full **certificate** in the signed tally data: name, ID
type and ID (email, domain, tax number), contact/agent, public key, optionally a birth record.
`Representations` depends on it.

The bundle is a canonical DAG-JSON object with the MyCHIPs certificate fields as its starting
point, placed in the binding where it is immutable. Contact endpoints that legitimately change
do **not** go here — they go in a Contact posting, which is what makes the immutability rule
affordable.

`StrandFormationDisclosure.identityBundle` is the wire carrier for the same object during
formation.

## Template Authoring Conventions

These are v1 authoring rules, not machine-checked until the parameter schema is validated.

- **Name the parameter in the prose.** MyCHIPs' `Credit_Terms` headed each term with its key —
  "Maximum Balance (limit); Default: 24" — linking prose to data readably. Keep the convention
  for both agreement parameters and posting values.
- **Declare a default for every parameter.** A missing value falls back to the declared
  default; a missing value with no declared default is a validation error surfaced at review
  time. This is also the fallback rule for a missing or stale posting.
- **Namespace parameters by the including section's `as` alias** — `Credit_Terms.limit`. Once
  clauses are a shared library, two clauses will both want `limit` or `notice`, and the design
  actively encourages that library.
- **Link translations.** Stroc gains a `translates` field alongside `replaces`, with the same
  advisory-only treatment. Without it a party that approved the English Ethics clause sees a
  Spanish rendering as novel, and the multilingual wrapper as novel too — which defeats the
  registry for every non-English user.

## Hash Canonicalization

One encoding everywhere: **CIDv1, DAG-JSON codec (0x0129), SHA-256, base32-lower** (`bafy…`) —
the IPFS default and what the Stroc spec prescribes. Database columns and wire frames store
the canonical base32 **string**; a CID appearing inside a parameter object, a binding or a
`replaces` array is likewise a string, not a DAG-JSON link (`{"/": "bafy…"}`), because the two
hash differently and the string form is what the SQL columns and digests carry.

Parsers accept any multibase prefix (free via `multiformats`) but persist canonical form only.
The legacy 43-character base64url raw digests in `stroc/contracts/*.json` predate the spec's
CID section; those documents are recomputed and republished before anything here ships.

---

## Prerequisites

Neither of these is optional, and the design does not work without them.

### Per-party strand identity

`feat-strand-party-identity` is a **hard prerequisite**, and only its *founder* half has landed
(`strand-party-member-key`): the founding party now has its own membership identity in the
control-layer `CadreControl.StrandPartyKey` table, so the founder's key is no longer derivable
from `Strand.MemberPrivateKey`. A *joining* party still has none — formation hands it the shared
`Strand.MemberPrivateKey` and nothing else, so on a production closed strand the joiners still
present one indistinguishable key. Until the joiner half lands
(`strand-formation-membership-invite`), `SignerKey` cannot distinguish parties and "every
required role has signed" collapses to one row.

It also bounds what open strands can do. `Member` is closed-only by schema, so signature
admissibility as specified above **does not work on an open strand at all**. Until an open
strand has a signer identity of some kind (`feat-open-strand-witness-policy`), an open strand's
instrument has terms-of-use semantics with unverified countersignatures, and multilateral
instruments on open strands — VoteTorrent's case — are not supported.

### Stroc work

The document layer is not ready, and "zero Stroc changes in v1" would be inaccurate. Named
tickets, all prerequisites rather than existing dependencies:

- **Pin the `text` shape.** `Specification.md`'s examples show `text: [[...]]` arrays while
  `types.ts` says `string`. That inconsistency changes CIDs and must be settled before any
  strand hashes anything.
- **`replaces` and `translates` metadata** as hashed content.
- **Instrument declaration** as a document-level field.
- **Document fetcher interface** — none exists.
- **Structural diff** between two documents, for the breakdown's "modified" classification.
  Note that Stroc stores one paragraph string per section, so sentence-level diff is a
  tool-side computation over that string, not a property of the storage.
- **PDF/HTML rendering** for the executed-agreement artifact.
- **CID republish** of `contracts/*.json` off the legacy base64url digests.

## Code Placement

| Piece | Where |
|-------|-------|
| CID compute/verify, normalization, validation | `@stroc/core` (exists) |
| Tree resolution, structural diff, `replaces`/`translates`, instrument declaration, renderers | `@stroc/core` (to be written — see Prerequisites) |
| Formation disclosure structure, `/sereus/doc/1.0.0` fetch RPC, registry writers, signing writer, effective-agreement computation | `@serfab/cadre-core` |
| `KnownDocument` table | `schemas/control.qsql` |
| `Header.ContractCid`/`ParamsCid`, `Document`, `Signature`, `SigningKey` tables | `schemas/strand.qsql` |
| Breakdown viewer, registry management UI, executed-agreement rendering | reference apps |

## Open Questions

1. **Stale or missing postings.** Does the agreement fail closed until a required posting
   exists, or fall back to the template defaults? The choice matters for a party that goes
   offline, and it interacts with the ratchet.
2. **Role transfer.** Does transferring a declared-transferable role require the incoming
   holder's countersignature? It matters most where the outgoing holder is already gone.
3. **Posting timing.** "Which posting was in force on date D" needs ordering the strand does not
   globally have. `SignedAt` plus the relying party's own replication record is adequate
   evidence for a dispute, but it is evidence, not proof — no part of this design should imply
   the chain is authoritative on timing.
4. **Signing-key retirement.** `SigningKey` is insert-only so past signatures stay verifiable.
   A compromised key therefore cannot be retired. A tombstone carrying an effective date —
   invalidating later signatures while preserving earlier ones — is the likely shape, and is
   unspecified here.
5. **Unsigned-member capabilities.** An admitted member may hold strand data before executing
   its instrument. Whether that window is bounded, and what an unsigned member may write, are
   policy — schema-supports, instrument-decides — but a default convention is worth picking
   before v1 ships.
6. **Machine-checkable required-signer policy.** Effective agreement is computed app-side in
   v1; making it a view waits on the instrument declaration being machine-readable.
7. **Third-party signers.** A witness, guarantor or notary is not a member and so cannot sign.
   Either accept the limitation, or let the instrument name roles that verify against a key
   stated in the binding rather than against the member roster.
8. **Engine `cid()` function.** Would move `Document` verification from the app layer into a
   CHECK; depends on Quereus function surface.
9. **Registry scale.** `KnownDocument` grows monotonically with review history; fine at
   personal scale, same "bounded by something other than forever" note as other append-only
   control tables.
