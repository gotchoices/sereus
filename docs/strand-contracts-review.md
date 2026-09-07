# Review: `strand-contracts.md`

Critical review of [`strand-contracts.md`](strand-contracts.md) against its two predecessors
and the stated goals. Sources read for this review:

- **MyCHIPs tally contracts** (`../../mc/mychips`): `contract/*.yaml` (all 13 documents),
  `schema/contracts.wms` / `tallies.wms`, `doc/learn-contract.md`, `learn-tally.md`
  (tally data, credit terms, certificates), `learn-protocol.md` (tally state machine),
  `lib/control/buildpdf.js` (agreement rendering), and `wylib/src/strdoc.vue`.
- **Stroc** (`../../stroc`): `docs/Specification.md`, `Legacy.md`, `FeatureComparison.md`,
  `Vision.md`, `STATUS.md`, `Implementation.md`, `packages/core/src/types.ts`,
  `contracts/*.json`.
- **Sereus**: `schemas/strand.qsql`, `schemas/control.qsql` (`FormationUsage`, `Strand`),
  `architecture.md` → Strand Formation / Membership Bootstrap, `strands.md`,
  `tickets/backlog/feat-strand-party-identity.md`, `feat-open-strand-witness-policy.md`.

The design's foundations are sound: content-addressed templates, template + parameters
signed as a pair, signing decoupled from joining, a per-party review registry, and
supersession as ordinary signatures. Those should stay. What follows is where the document
is wrong, incomplete, or has quietly dropped something the earlier designs had.

---

## 1. Core-model defects

These are not polish items. Each one breaks a stated goal if implementation tickets are cut
from the document as written.

### 1.1 One `ParamsCid` conflates strand-level terms with signer-level bindings

The document uses a single parameter object in two incompatible ways:

- **Mutual contract**: "every member signs the same pair" — so the params must be shared
  (the credit terms, the notice period, the governing law).
- **Unilateral instrument**: "signer-specific params (declarant binding, date,
  jurisdiction)" — so the params are per signer.

Both are needed at once in the ordinary case. A Taleus tally has shared terms *and* each
party signs *as* a specific role (Stock Holder vs Foil Holder) with its own identity. An
n-party strand cannot list every future member in a founding params object, so a joiner
must bind itself to a role at signing time. As soon as any signer-specific datum enters the
params object, every signer's `ParamsCid` differs and the "same pair" test that defines the
mutual agreement is unsatisfiable.

**Fix**: split the parameters into two content-addressed objects with distinct roles in the
digest:

- `ParamsCid` — the **agreement parameters**, shared by every signer of one agreement
  (terms, role *definitions*, required-signer policy). Identical across signers is what
  makes them parties to the *same* agreement.
- `BindingCid` — the **signer's binding**: which role it executes, its identity bundle,
  signing date and any per-signer declarations. Nullable for pure terms-of-use acceptance.

The agreement identity is then `(ContractCid, ParamsCid)`; a signature is
`(ContractCid, ParamsCid, BindingCid, SignerKey)`. This also resolves open question 4
(re-execution): a renewed attestation is a fresh `BindingCid`, and the primary key becomes
`(ContractCid, ParamsCid, SignerKey, BindingCid)` with no nullable-in-PK trick.
<!--EC Does this split imply that a signer could later supercede his own paramaters unilaterally?  For example, could a signer update his notice address without consent of the other parties?  Because something is in the signer's own parameter block, does that imply that he can update/supercede it at his will?  Or are the other parties relying on it not changing?.  Discuss. -->
### 1.2 The signature is not bound to the strand

The `Signature` digest is `('Strand.Signature', 'v1', ContractCid, ParamsCid, ReplacesCid,
SignerKey, SignedAt)`. Nothing in it names the strand. A template plus role-generic params
is by design identical across many strands, so a signature row lifted from one strand
verifies in any other strand adopting the same pair. MyCHIPs avoided this because the tally
digest included the tally UUID. **`Header.Id` must be in the digest** (and in the row, or
derived from the strand at verify time via `exists (select 1 from Header ...)`).

### 1.3 The signing key is not a party's key

Signing verifies against `Member.Key`. Two facts about that key undermine its value as a
legal signature:

- Today every party on a production closed strand presents the **same** member key
  (`feat-strand-party-identity`: the founding key derived from `Strand.MemberPrivateKey`
  is handed to every joiner). Per-party member keys exist only in tests. Until that ticket
  lands, `Signature.SignerKey` cannot distinguish parties, and "all current members signed"
  is one row.
- The member private key is deliberately held **in plaintext on every node of the cadre**
  ([`strands.md`](strands.md) → Closed-Strand Member Key Handling). A signature made with
  a key intentionally replicated to every device the party owns — and, today, to every
  *other* party — is a weak basis for non-repudiation. MyCHIPs signed with the user's own
  signing key.

**Fix**: the document must (a) declare `feat-strand-party-identity` a hard prerequisite,
and (b) decide which key executes contracts. The defensible answer is the party's
enclave-held key (owner key or a dedicated signing key registered against the member), with
the strand `Member.Key` acting as the *authorization* to file the row, not the signature
itself. A `SigningKey` registered by the member (a signed `Member → SigningKey` row, same
stamp idiom as `MemberPeer`) keeps the strand's own tables sufficient for verification.
<!--EC Is the point here that MyCHIPs/taleus needs a transaction signing key that is distinct from the node's member key?  I wonder if some apps (like chat) _want_ to sign the contract with a member key or if it should _always_ be separate.  One use case for chat is some type of confidentiality agreement on the content of the chat strannd. -->

### 1.4 No negotiation, no offer, no withdrawal

MyCHIPs' tally protocol is mostly negotiation: `draft → P.draft → offer → (counter-offer |
void | open)`, with the joiner able to revise terms and re-sign, the offeror able to void an
unaccepted offer, and a `revision` counter that clears stale signatures. The strand design
has a founding pair fixed by the bootstrap writer and an insert-only `Signature` table. A
joiner can accept or walk away; it cannot propose its own credit limit; and a signed offer
that the counterparty never countersigned stands forever, acceptable years later.

The document's own machinery already contains the fix if it is stated: **a signature over a
pair by party A is an offer while B has not signed and an acceptance once B has.** That is
exactly MyCHIPs' `H.offer`/`P.offer`. What is missing:

- **Proposal = signature.** Drop the notion that the `Header` pair is special beyond
  being the *first* proposal. Any member may insert documents and sign a new pair; the
  breakdown shows unaccepted proposals to the other members.
- **Withdrawal / expiry.** A signature needs either an `ExpiresAt` bound into the digest
  (an offer lapses on its own) or a signed `Withdrawal` tombstone valid only while the
  required counter-signatures are absent. Without one there is no `offer.void`.
- **Ordering.** A strand has no global order, so "withdrawn before accepted" is not
  decidable from replicated rows alone. Expiry in the digest sidesteps this; a tombstone
  does not. Prefer expiry, and say so.
  <!--EC I'm inclined to not allow premature withdrawl.  In my view, a signed offer is a binding offer as long as it is counter-signed before it expires.  The idea of signed withdrawl brings up all kinds of timing issues which are representative of the real-world legal problem of what does it mean to withdraw an offer (not sure you really can unless it has expired naturally or the other party has breached somehow)
  -->

### 1.5 Fixed terms vs unilaterally adjustable terms

MyCHIPs split tally data into **fixed credit terms** (both signatures required to change)
and **trading variables / settings** (unilaterally changeable by one party, signed by that
party alone, still binding via the contract's "Lift Authority" clause). The strand design
has only the heavy path — any parameter change is a replacement agreement re-signed by
everyone. Raising your own credit limit should not require an amendment round.

**Fix**: the agreement parameters declare which keys a given role may change unilaterally.
A change is then a **unilateral instrument** (template "Parameter Update", binding names the
key/value and the agreement it modifies) — the same `Signature` row shape as everything
else. This is the generalization the document is already reaching for in the unilateral
section; it just needs to be applied to amendments.
<!--EC Contrast this with the alternate approach of:
- Only put in the contract what you want to be bound to the contract
- Unilaterally modifiable terms are instead posted/asserted outside the contract as a separate rep/warranty type document.
Which makes more sense from a structural design standpoint?
 -->

### 1.6 No termination

Contracts end. MyCHIPs tallies close (`C.open → close`); a health-data consent is revoked;
a member leaves a chat and its terms-of-use acceptance should no longer bind it to new
terms. The design has no termination event at all — supersession replaces, nothing ends.
Same fix as 1.5: **termination is a unilateral instrument** ("Notice of Termination",
binding names the agreement). Effective-agreement logic then reads the chain: head of
supersession, minus terminated.

Taken together, 1.4–1.6 suggest the real primitive: **every legal act is (template,
params, binding, signer)** — offer, acceptance, amendment, unilateral update, termination,
attestation, renewal. The document should say this once, up front, instead of introducing
supersession, unilateral instruments and amendments as three separate mechanisms.
<!--EC Can't we just put an ending date in a contract as a parameter?
In the case of a close request, I think this is a unilateral assertion which will be interpreted according to the original bi-lateral agreement (i.e. it has to be honored).
See any problem with that?
-->

---

## 2. Regressions from the MyCHIPs design

### 2.1 Party identity in the signed record

A MyCHIPs tally embedded each party's **certificate** in the signed data: name, ID type and
ID (email, domain, tax number), contact/agent, public key, optionally birth record. The
Representations clause ("the identity of each Party, as represented in the Tally, is true
and accurate") depends on it, and it is what makes the agreement enforceable against a
person rather than a key. The strand design says params carry "role bindings" and never
says what a binding contains. `StrandFormationDisclosure` has `partyId` and an
`identityBundle: unknown`. **Define the identity bundle** (a Stroc-independent, canonical
DAG-JSON object with the MyCHIPs certificate fields as the starting point) and put it in the
signer binding (1.1).

### 2.2 The rendered agreement

`buildpdf.js` produced the artifact a party would actually retain or take to court:
contract text with per-section CIDs, both certificates, both parties' terms as tables, the
tally UUID/date/digest, both signatures, QR codes. `learn-contract.md` → "Tally Agreement
Layout" specifies it. The strand design covers this in one clause ("the renderer may append
a signature block and parameter table"). It needs a section: the **canonical rendering of
an executed agreement** — template + parameter table + each signer's binding + strand id +
every CID + signatures — and a statement that every party can produce it offline from
`Document` + `Signature` rows alone. Stroc's PDF export is an unstarted phase; this is a
dependency, not a footnote.

### 2.3 Prose ↔ parameter linkage convention

MyCHIPs' `Credit_Terms` named each parameter's JSON key in the heading — "Maximum Balance
(limit); Default: 24" — so the prose and the data object were linked by a readable
convention, and every term had a **default** for when the data omitted it. The strand
design defers linkage to a vNext `<var:>` markup and says nothing about defaults. v1 needs
at least the MyCHIPs convention stated as a template-authoring rule, plus a rule for
missing parameters (default declared in prose; absent-with-no-default is a validation
error at review time).
<!--EC Again, since credit terms (under MyCHIPs) can be changed any time by a party (as long as he honors the old ones for their lifetime), I wonder if credit terms should not be in the bilateral contract at all. -->

### 2.4 Parameter namespacing for reusable clauses

MyCHIPs sidestepped key collisions by having exactly two term objects (stock/foil). Once
clauses are a shared library, two clauses will both want `limit` or `notice`. Namespace
parameters by the including section's `as` alias (`Credit_Terms.limit`) or the design's
"clause library equilibrium" collides on its first reuse.

### 2.5 Suitability marker (`top`)

MyCHIPs marked documents "suitable for direct inclusion in a tally" with `top: true`;
Stroc removed it. Nothing stops a strand naming the Ethics clause as its `ContractCid`.
A signable **instrument** should declare itself: its roles, its parameter schema, the
signatures it requires. That declaration is what the params-schema vNext item needs
anyway; pull the *existence* of the declaration into v1 even if validation stays vNext.

### 2.6 Non-binding test agreement

`Tally_Testing.yaml` wraps the real contract in a clause that makes the whole agreement
non-binding — so test tallies still exercise the full signing path. The strand design
allows `ContractCid` null for "no human contract", which is the wrong default for
dev/test strands. Recommend: test strands adopt an explicit non-binding wrapper template,
and null means "this strand carries no legal instrument" (a chat with no terms), not
"testing".

### 2.7 Version and translation lineage

MyCHIPs coordinates `(host, name, version, language)` let a reader find "the same document,
newer version" and "the same document, in my language". Stroc dropped all four; the
design's `replaces` restores version lineage only. **Translation lineage is missing**: a
party that approved the English Ethics clause sees a Spanish rendering as *novel*, and the
multilingual wrapper is novel too. Add a `translates` (or `renders`) link alongside
`replaces` in the Stroc metadata request, with the same advisory-only trust treatment.

### 2.8 Where the "receipt" actually lives

The document claims `FormationUsage.PeerSig` is a re-verifiable receipt of having been
shown the terms. Checked against `control.qsql`: the consent digest covers
`(Token, UsageStampId, PeerKey, Disclosure)` where `Disclosure` is the **joiner's own**
disclosure text, and the row lives in the **host's control database**, not the strand. So
the receipt holds only if the joiner *echoes* the agreement pair into its own disclosure
(then its signature covers it), and even then only the host holds it. State that echo as a
protocol requirement, and note that the receipt is host-held evidence, not strand data.

---

## 3. Mismatches with Stroc as it exists

- **"Zero Stroc changes in v1" is not true.** The breakdown's "modified" classification
  leans on `replaces`; hash canonicalization requires republishing every legacy document;
  the diff and tree-resolution code the placement table assigns to `@stroc/core` does not
  exist (STATUS: no fetcher, no included-doc display, no diff, no PDF; project paused on
  Sereus IPFS). List the Stroc work as explicit tickets: `replaces`/`translates` metadata,
  instrument declaration, document fetcher interface, structural diff, PDF/HTML render,
  CID republish of `contracts/*.json`.
- **Sentence-level diff claim is stale.** Stroc's final spec stores **one paragraph string
  per section** (Legacy.md listed that as a shortcoming, then Specification.md re-adopted
  it). "Stroc's structured paragraphs are what make this diff meaningful" is not true at
  the storage level; sentence diff is a tool-side computation over a string. The spec's own
  examples still show `text: [[...]]` arrays while `types.ts` says `string` — that
  inconsistency changes CIDs and must be pinned before anything is hashed.
- **Cross-references make clauses non-portable.** Stroc validates `<ref:Alias/Section>` at
  save and blocks save on an unresolved reference. A library clause that references a
  sibling (`<ref:Credit_Terms/limit>`) cannot be saved standalone and silently means
  something different under a different parent. The design's "semantic caveat" mentions
  defined terms but not this mechanical constraint. Either restrict library clauses to
  internal refs, or ask Stroc for "external refs validated at composition time".
- **IPFS as the public store.** Stroc's resolution ladder ends in IPFS; Sereus has none
  and Stroc is waiting on it. A cheaper, already-consistent answer: a **public open strand
  whose sApp is just the `Document` table** — a document library strand. It uses the same
  fetch RPC, the same verification, and no new infrastructure.
- **DAG-JSON links.** DAG-JSON encodes CIDs as `{"/": "bafy…"}`. Decide whether
  `ContractCid` inside a params object, a `replaces` array, or a binding is a string or a
  link — the two hash differently.

---

## 4. Missing for the stated goals

### Taleus tally contracts

Covered *if* 1.1–1.6 and 2.1–2.4 are fixed. Two additions: a tally is a two-party strand
with **asymmetric roles** — the instrument must declare roles and the binding must name
which one the signer takes (the document never records the role anywhere); and MyCHIPs'
"credit terms per direction" is the model for role-scoped parameters.

### Chat

A chat strand's instrument is **terms of use**: one role ("Operator" or "Manager") that
executes once, and an open-ended "Member" role each joiner accepts. That is an asymmetric
n-party agreement — the operator's signature is the standing offer, each member's is an
acceptance, and the operator's replacement of the terms should not require every member to
re-sign before it binds *new* joiners. The document's default effective-agreement policy
("all current members signed") is wrong for this shape; role-based policy ("effective when
every *required* role has signed") is needed and is what the instrument declaration (2.5)
should carry. Not worked through anywhere in the document.
<!--EC Good to keep in mind that both members or neither member may end up a manager.  And public strands have no concept of manager. -->

### Health

Consent to data sharing is **unilateral, revocable, and often scoped** (this provider, this
record class, until this date). It needs: unilateral instruments (present), termination
(1.6, absent), expiry in the digest (1.4, absent), and an sApp-readable view of "is consent
X currently in force" — the vNext policy layer. Also the strongest argument for signing with
a party-controlled key (1.3). Not mentioned.
<!--EC a healthcare provider probably should sign an agreement as well (if you haven't already considered that.) -->

### VoteTorrent

Multilateral with many signers and rule-bearing documents (election rules, voter pledges).
The `Signature` table scales fine, but the interesting property is that a **rule change
must be witnessed by distinct parties** — precisely `feat-open-strand-witness-policy`, which
is itself blocked on party identity. On an open strand the document's own answer ("any
keypair can file a row") makes a rules agreement meaningless. Say plainly that multilateral
instruments on open strands wait on both tickets.

### Apps implementing strand contracts

The goal "allows apps to implement strand contracts where applicable" has no mechanism.
The machine contract (`sAppSchema`, signed by the sApp author) and the human contract are
unconnected. The natural link: the **signed sApp schema declares which instruments it
requires or permits** (a set of template CIDs or a publisher key), so a chat sApp can
require its ToS, and the sApp's own constraints can gate writes on `Signature` rows for
*those* templates. That closes the loop between "sApp decides which keys matter" and the
contract layer, and it is a small addition to the strand-start schema verification already
in place.

### Modular legal documents

Composition by reference is inherited from Stroc and adequate for **structure**. Missing
for **modularity**: parameter namespacing (2.4), portable cross-references (§3), a
**definitions** convention (a template declares defined terms; library clauses use them
without owning them — MyCHIPs relied on capitalized terms like "Product", "Pledge of Value"
defined in Recitals/CHIP_Definition, which only works because every tally used the same
composition), and publisher trust so a party can pre-approve a publisher's whole library.
Publisher trust is vNext in the document; a v1 substitute is an app-shipped **seed list of
well-known CIDs** so the first-run breakdown is not 100% novel.

### Unilateral and multilateral

Covered in shape; broken in detail by 1.1 (per-signer params), 1.2 (strand binding), and
the missing role record. Third-party signers — a witness, a guarantor, a notary — cannot
sign at all because verification requires `Member.Key`. Either admit that limitation or
let the instrument declaration name roles that verify against a key stated in the binding
rather than the member roster.

### Templates with parameterized key items

Parties, dates, terms are the three named examples. Parties: no identity bundle (2.1).
Dates: `SignedAt` is self-asserted with no bound; an effective date or expiry is not
representable outside prose. Terms: linkage convention absent (2.3). The vNext `<var:>`
item is the right end state; v1 needs the conventions written down so templates authored
now do not have to be re-hashed later.

---

## 5. Schema-level notes

- `Signature.Sig` is a stored, self-authenticating column rather than `with context`, and
  the row carries no `StampId`. That is fine (PK collision is the replay guard, same
  argument as `ConsumedInvite`) but the document should say so, since it departs from every
  sibling table.
- `Signature.ParamsCid null` versus `Header`'s "ParamsCid null unless ContractCid" — the
  two nullability rules disagree; after 1.1 neither is needed.
- `SignedAt` in a digest requires the `canonicalDatetime` transform already used for
  `Invite.Expiration`; name it.
- **Who may insert `Document` rows?** Nothing gates it. On a closed strand any member can
  fill the table with junk; on an open strand anyone can. Require the insert to ride in the
  same transaction as a `Signature` (or proposal) that references it, or at least a member
  signature over the CID.
- `Document.Cid` must be verified somewhere; "app layer on write and on read" means every
  reader re-hashes every row on every read or trusts its own earlier verification. State
  the caching rule.
- `KnownDocument` is advisory and per-party, yet uses the owner-signed stamp/revocation
  machinery. Acceptable, but note that a *rejected* verdict is the one that matters for
  safety, and it should not be silently overridden by a later `approved` row from another
  device (last-writer-wins on `Cid` PK is wrong for that; keep history or make rejection
  sticky).
- Member re-key is "remove + fresh add". Signatures under the old key survive but the
  "all current members signed" test then fails. Decide: re-sign on re-key, or let a
  member's key lineage (the `Revocation` chain) carry signatures forward.

---

## 6. Recommended shape after refinement

Not a rewrite of the design; a consolidation of what it already implies.

1. **One primitive.** `Signature(StrandId, ContractCid, ParamsCid, BindingCid, SignerKey,
   ExpiresAt, Sig)`. Offer, acceptance, amendment, unilateral update, attestation, renewal
   and termination are all this row with different templates. `ReplacesCid` moves into the
   *binding* (it is the signer's claim about what this act supersedes), and the successor
   template's `replaces` stays the author's claim.
2. **Instrument declaration** in the template: roles, parameter schema with defaults and
   per-role unilateral-change rights, required-signer policy. v1 stores it; validation can
   follow.
3. **Two parameter objects** — agreement params (shared) and signer binding (identity
   bundle, role, dates). Agreement identity is `(ContractCid, ParamsCid)`.
4. **Signing key** is a party-controlled key registered against the member; the member key
   authorizes filing, not signing. Hard dependency on `feat-strand-party-identity`.
5. **Effective agreement** is a view: latest un-terminated, un-expired pair for which every
   role the instrument requires has signed. Default policy comes from the instrument, not
   from "all current members".
6. **sApp ↔ contract link**: the signed sApp schema may name required/allowed instruments.
7. **Rendering** section specifying the canonical executed-agreement document and its
   offline reproducibility from strand rows.
8. **Stroc work as named tickets**, with the `text` shape pinned and legacy CIDs
   republished before any strand hashes anything.
9. **Public document-library strand** instead of IPFS as the third rung of the fetch
   ladder.

Items 1–4 change the schema sketch and should land in the design before tickets are cut.
Items 5–9 can be sections added to the existing document without disturbing what is there.
