# Review: `strand-contracts.md`

Critical review of [`strand-contracts.md`](strand-contracts.md) as written, against two
questions:

1. Does it **preserve** what MyCHIPs tally contracts and Stroc already do, and enhance it?
2. Will the result **maximize utility for Sereus sApps** — Taleus, chat, health,
   VoteTorrent — rather than serving one of them?

Sources read: MyCHIPs (`../../mc/mychips`) `contract/*.yaml` (all 13 documents),
`schema/contracts.wms` / `tallies.wms`, `doc/learn-contract.md`, `learn-tally.md`,
`learn-protocol.md`, `lib/control/buildpdf.js`, `wylib/src/strdoc.vue`; Stroc
(`../../stroc`) `docs/Specification.md`, `Legacy.md`, `FeatureComparison.md`, `STATUS.md`,
`packages/core/src/types.ts`, `contracts/*.json`; and in Sereus `schemas/strand.qsql`,
`schemas/control.qsql`, `architecture.md` → Strand Formation, `strands.md`,
`tickets/backlog/feat-strand-party-identity.md`, `feat-open-strand-witness-policy.md`.

The foundations are right and should stay: content-addressed templates, a template signed
together with its parameters rather than materialized into them, signing decoupled from
joining, a per-party review registry, and supersession expressed as ordinary signatures.
Everything below is either a defect in the model as written, functionality the predecessors
had that the document drops, or a gap that shows up as soon as a second sApp uses it.

## The central change

Most findings converge on one structural correction, so it is worth stating first.

**Signed content is immutable. Anything that changes is a separate signed instrument.**

The document puts terms inside the agreement and then needs an amendment pathway to change
them — its Amendment Pathway section, and the acceptance-policy layer it defers to vNext,
both exist to service that choice. Invert it. An agreement carries only what the parties
intend to be fixed for its life: who they are, what roles they take, which document governs,
and the *rules* about everything else. Values that legitimately move — credit limits, notice
addresses, contact endpoints, consents — become **postings**: separate unilateral
instruments, signed by the party they belong to, that the agreement references by role and
template rather than by value.

This makes the model smaller, not larger, because a posting is the same
`(template, params, binding, signer)` row as everything else. MyCHIPs reached the same place
by a harder route: credit terms live inside the signed tally, yet `Credit_Terms` describes
them as changeable at will subject to honoring the old call period, so the schema had to
carry `hold_sets`/`part_sets` as *cached live values* alongside the signed
`hold_terms`/`part_terms`, with settings implemented as a special kind of chit "so they can
benefit from the existing chit exchange and consensus protocol". Sereus should start where
MyCHIPs ended up.

---

## 1. Defects in the model as written

### 1.1 One `ParamsCid` cannot carry both shared terms and signer bindings

The document uses one parameter object two incompatible ways: the mutual case says "every
member signs the same pair", while the unilateral-instruments section says params are
"signer-specific (declarant binding, date, jurisdiction)".

Both are needed at once. A Taleus tally has shared terms *and* each party signs *as* a role
(Stock Holder vs Foil Holder) with its own identity. An n-party strand cannot list future
members in a founding params object, so a joiner must bind itself to a role at signing time.
The moment any signer-specific datum enters the params object, every signer's `ParamsCid`
differs and the "same pair" test that defines a mutual agreement is unsatisfiable.

**Change.** Split into two content-addressed objects, both immutable:

- `ParamsCid` — **agreement parameters**, shared by every signer: role definitions,
  required-signer policy, notice periods, governing law, and the posting rules of 1.2.
  Identical across signers is what makes them parties to the same agreement.
- `BindingCid` — the **signer's binding**: the role it executes, its identity bundle (2.1),
  signing date, per-signer declarations. Null for a bare terms-of-use acceptance.

Agreement identity becomes `(ContractCid, ParamsCid)`; a signature is
`(ContractCid, ParamsCid, BindingCid, SignerKey)`. This also settles the document's open
question 4: a renewed attestation is a fresh `BindingCid`, and the primary key becomes
`(ContractCid, ParamsCid, SignerKey, BindingCid)` — no nullable column in a primary key.

Position in a signer's own binding must confer no permission to revise it. A party may not
edit its legal name, tax ID or executed role, because those are the representations the
counterparty relied on — `Representations` says so directly ("the identity of each Party, as
represented in the Tally, is true and accurate"). Changing one is a new version, re-executed.
That rule is only affordable because of 1.2: a party that moves house updates a Contact
posting, not the agreement.

### 1.2 Mutable terms do not belong in the signed agreement

MyCHIPs split tally data into fixed credit terms (both signatures required) and trading
variables and settings (unilaterally changeable, signed by the changing party alone, binding
through the contract's "Lift Authority" clause). The document has only the heavy path: every
parameter change is a replacement agreement re-signed by everyone. Raising your own credit
limit should not require an amendment round.

**Change.** Mutable terms leave the agreement and become **postings**. The agreement binds
only the rules governing them:

- who maintains a posting of each kind, under which template;
- the **ratchet** — MyCHIPs' rule that a tightening takes effect only after the
  previously-posted call notice elapses ("when reducing the call from 120 to 30, the
  effective terms will still be 120 until that period of time has first elapsed");
- the fallback when a posting is missing or stale, which is what makes 2.3's defaults matter.

The agreement must reference a posting **by role and template CID, never by posting CID** —
pinning a CID pins a version and defeats the purpose.

**This is where the document's own registry story is won or lost.** The design argues that
stable template text is what makes recognition work, and it is right — but then leaves the
numbers in the parameters, so every tally's params are unique and must be read in full. Move
the terms out and a tally agreement's parameters shrink to the parties, their roles, the
tally id and the date: a table of names and a date, exactly what the document says a joiner
should have to read. The pair `(ContractCid, ParamsCid)` then becomes identical across a very
large number of tallies, which is what the registry needs to be worth building.

One reclassification follows: MyCHIPs' `Credit_Terms` becomes a **posting template**, not a
clause of the agreement. That is a clarification — the document already reads like the
definition of a data object rather than contract prose ("Maximum Balance (limit);
Default: 24").

### 1.3 The signature is not bound to the strand

The digest is `('Strand.Signature', 'v1', ContractCid, ParamsCid, ReplacesCid, SignerKey,
SignedAt)`. Nothing names the strand. Since a template plus role-generic parameters is by
design identical across many strands, a signature row lifted from one strand verifies in any
other strand that adopted the same pair. MyCHIPs avoided this because the tally digest
covered the tally UUID.

**Change.** Put `Header.Id` in the digest, and either on the row or resolved at verify time
from the strand's own header.

### 1.4 The signing key is not a party's key

The document verifies `Sig` against `Member.Key`. Two facts undermine that as a legal
signature:

- Every *joining* party on a production closed strand presents the **same** member key:
  formation hands it `Strand.MemberPrivateKey` and nothing else. The founder is now the
  exception — `strand-party-member-key` gave the founding party its own
  `CadreControl.StrandPartyKey` identity — but the joiner half of
  `feat-strand-party-identity` (`strand-formation-membership-invite`) has not landed. Until it
  does, `Signature.SignerKey` cannot distinguish the joining parties, and "all current members
  signed" is one row.
- That key is held **in plaintext on every node of the cadre**
  ([`strands.md`](strands.md) → Closed-Strand Member Key Handling), minted by software and
  rotated by remove-then-add. Appropriate for "this party's software authorized this write";
  weak for "this party agreed to be bound". MyCHIPs signed with the user's own signing key.

**Change.** Name `feat-strand-party-identity` a hard prerequisite, and let the **instrument
declare which class of key may execute it** rather than fixing one answer for every sApp.
Requiring an enclave-held ceremony for every acceptance would defeat the document's own
auto-accept policy knob, which only makes sense if accepting is cheap; permitting a
replicated software key on a credit obligation gives up what MyCHIPs protected.

- **`member`** — the strand member key. Cheap, in-band, verifiable from strand tables alone.
  Adequate for terms of use, participation rules, chat confidentiality.
- **`party`** — a key the party controls outside the strand's replication: an enclave-held
  owner key, or a signing key registered by a member-signed `Member → SigningKey` row using
  the same stamp idiom as `MemberPeer`. Required for external obligations — tallies,
  guarantees, health consents.

In both cases the member key authorizes *filing*; in `party` class the filing key and signing
key differ and both are checked. Keeping the registration in strand data preserves the
document's goal that a reader verifies from strand rows alone.

**Departure changes the table shape.** A confidentiality undertaking is among those you most
need to enforce after someone leaves, and a departing member's `Member` row is deleted. So
`Signature` rows and key registrations must be insert-only and independent of *live* `Member`
rows, with membership checked at insert time only. A verification path that joins to `Member`
at read time silently voids the signatures that matter most.

### 1.5 No negotiation, no offer, no expiry

MyCHIPs' tally protocol is mostly negotiation: `draft → P.draft → offer → (counter-offer |
void | open)`, with the joiner able to revise terms and re-sign, the offeror able to void an
unaccepted offer, and a revision counter that clears stale signatures. The document has a
founding pair fixed by the bootstrap writer and an insert-only `Signature` table. A joiner
can accept or walk away; it cannot propose its own terms; and a signed offer the counterparty
never countersigned stands forever, acceptable years later.

The machinery is already there once stated: **a signature over a pair is an offer while the
other required signers are absent, and an acceptance once they are present** — MyCHIPs'
`H.offer`/`P.offer`. Two changes:

- **Proposal is just a signature.** The `Header` pair is not special beyond being the first
  proposal. Any member may insert documents and sign a new pair; the breakdown shows
  outstanding proposals to the other members.
- **Mandatory expiry, and no withdrawal.** Every signature that is not yet an acceptance
  carries a required `ExpiresAt` in the digest. An offer lapses on its own; it is never
  revoked, and the instrument declaration can cap the maximum term.

Withdrawal is the wrong mechanism *here specifically* because a strand has no global order:
"was the withdrawal replicated before the acceptance was signed" is not answerable from the
rows, so every withdrawal has a window in which two honest parties hold valid contradictory
signatures. Expiry is decidable from the digests alone — both sides read the same `ExpiresAt`
and the same `SignedAt` — and reduces to a clock-honesty question the offeror can check on
receipt. Firm offers with a stated expiry are a well-established instrument, so this costs no
legal expressiveness; a party wanting room to change its mind offers with a short expiry and
re-offers. Breach and mistake are asserted as instruments *against the executed agreement*,
never by unforming it, so the record stays monotone.

Superseding an outstanding offer stays expressible: file a replacement whose binding names
the prior one. If the counterparty accepts the old one before expiry, the old one binds —
correct under the firm-offer rule.

### 1.6 No ending

Contracts end. MyCHIPs tallies close (`C.open → close`); a health consent is revoked; a
member leaves a chat. The document has no ending at all — supersession replaces, nothing
terminates. Three situations behave differently and all three are needed:

1. **Natural expiry — an agreement parameter.** An end date in the parameters is decidable
   from the signed pair alone, needs no new mechanism, and cannot be disputed on ordering.
2. **Termination by notice under the agreement's own terms — a unilateral instrument.** The
   notice is unilateral; its effect is determined by the agreement it names. Same layering as
   a posting: the instrument asserts, the agreement interprets.
3. **Termination conditioned on observable state.** `C.open → close` completes only when the
   tally balance reaches zero; a health consent may require records destroyed.

Case 3 is the one needing care: **the condition is app state, not contract state.** So the
contract layer records "notice filed, effect per terms" and the **sApp** computes in-force
status — consistent with the document's own stance that the schema supports and the contract
text decides. The closing party should additionally file a **Certificate of Closure** once the
condition is met, giving the chain a verifiable terminal record; MyCHIPs effectively does
this, since reaching `close` is an observable agreed state.

Revoking a *unilateral* instrument is separate: there is no counterparty agreement to
interpret the notice, so revocability must be declared by the instrument itself.

**In-force status is per-clause, not one boolean per agreement.** Confidentiality, data
destruction, dispute resolution and unsatisfied balances survive termination by design. The
document's "head of the executed supersession chain" model has no way to express that; the
instrument must declare which sections survive.

### The single primitive

1.1–1.6 resolve into one row shape. **Every legal act is `(template, params, binding,
signer)`** — offer, acceptance, amendment, posting, unilateral update, notice, attestation,
renewal and closure. The document should say this once, up front, rather than introducing
supersession, unilateral instruments and amendments as three separate mechanisms.

---

## 2. MyCHIPs functionality not preserved

### 2.1 Party identity in the signed record

A MyCHIPs tally embedded each party's **certificate** in the signed data: name, ID type and
ID (email, domain, tax number), contact/agent, public key, optionally birth record. The
`Representations` clause depends on it, and it is what makes an agreement enforceable against
a person rather than a key. The document says parameters carry "role bindings" and never says
what a binding contains; `StrandFormationDisclosure` offers only `partyId` and an
`identityBundle: unknown`.

**Change.** Define the identity bundle as a canonical DAG-JSON object with the MyCHIPs
certificate fields as the starting point, placed in the signer binding where it is immutable.
Contact endpoints that legitimately change go in a Contact posting instead.

### 2.2 The rendered agreement

`buildpdf.js` produced the artifact a party actually retains or takes to court: contract text
with per-section hashes, both certificates, both parties' terms as tables, the tally
UUID/date/digest, both signatures, QR codes. `learn-contract.md` → "Tally Agreement Layout"
specifies it. The document covers this in one clause: the renderer "may append a signature
block and parameter table".

**Change.** Add a section specifying the **canonical rendering of an executed agreement** —
template, parameter table, each signer's binding, the postings in force, strand id, every CID,
and the signatures — plus the requirement that any party can produce it offline from
`Document` and `Signature` rows alone. Stroc's PDF export is an unstarted phase, so this is a
dependency to schedule, not a footnote.

### 2.3 Prose ↔ parameter linkage and defaults

MyCHIPs' `Credit_Terms` named each parameter's JSON key in its heading — "Maximum Balance
(limit); Default: 24" — linking prose to data by a readable convention, and gave every term a
**default** for when the data omitted it. The document defers linkage to a vNext `<var:>`
markup and says nothing about defaults, so a v1 template has no stated way to tie its prose
to the object beside it.

**Change.** State the MyCHIPs convention as a template-authoring rule for v1, plus a rule for
missing values: a default declared in prose, and absent-with-no-default treated as a
validation error at review time. Under 1.2 this governs posting templates as much as
agreement templates — and the fallback for a missing posting depends on it.

### 2.4 Parameter namespacing for reusable clauses

MyCHIPs avoided key collisions by having exactly two term objects (stock/foil). Once clauses
are a shared library — which the document actively encourages — two clauses will both want
`limit` or `notice`.

**Change.** Namespace parameters by the including section's `as` alias (`Credit_Terms.limit`),
or the predicted clause-library equilibrium collides on first reuse.

### 2.5 Suitability marker, and the instrument declaration

MyCHIPs marked documents suitable for direct inclusion in a tally with `top: true`; Stroc
removed it. Nothing in the document stops a strand naming the Ethics clause as its
`ContractCid`.

**Change.** A signable **instrument** declares itself. That declaration is already implied by
the document's vNext params-schema item, and this review adds to it: roles and their
transferability, required-signer policy, `requiredKeyClass`, maximum offer expiry,
revocability, which sections survive termination, expected posting kinds, and the parameter
schema with defaults. Store it in v1 even if validation waits.

### 2.6 Non-binding test agreement

`Tally_Testing.yaml` wraps the real contract in a clause making the whole agreement
non-binding, so test tallies exercise the full signing path. The document instead allows
`ContractCid` null for "no human contract", which is the wrong instrument for dev and test —
it exercises nothing.

**Change.** Test strands adopt an explicit non-binding wrapper template; null means "this
strand carries no legal instrument" (a chat with no terms), not "testing".

### 2.7 Version and translation lineage

MyCHIPs' `(host, name, version, language)` coordinates let a reader find "the same document,
newer version" and "the same document, in my language". Stroc dropped all four; the document's
`replaces` restores version lineage only. **Translation lineage is missing** — a party that
approved the English Ethics clause sees a Spanish rendering as novel, and the multilingual
wrapper as novel too, which defeats the registry for every non-English user.

**Change.** Add a `translates` link alongside `replaces` in the Stroc metadata request, with
the same advisory-only trust treatment.

### 2.8 Where the "receipt" actually lives

The document claims `FormationUsage.PeerSig` is a re-verifiable receipt of having been shown
the terms. Checked against `control.qsql`, the consent digest covers
`(Token, UsageStampId, PeerKey, Disclosure)`, where `Disclosure` is the **joiner's own**
disclosure text, and the row lives in the **host's** control database, not in the strand. The
claim does not hold as written.

**Change.** Require the joiner to *echo* the agreement pair into its own disclosure, so its
signature covers it, and state that the result is host-held evidence rather than strand data.

---

## 3. Stroc: what the document assumes versus what exists

- **"Zero Stroc changes in v1" is not accurate.** The breakdown's "modified" classification
  leans on `replaces`, which does not exist; hash canonicalization requires republishing every
  legacy document; and the diff and tree-resolution code the Code Placement table assigns to
  `@stroc/core` is unwritten (STATUS: no fetcher, no included-document display, no diff, no
  PDF, project paused waiting on Sereus IPFS). **Change:** list the Stroc work as explicit
  tickets — `replaces`/`translates` metadata, the instrument declaration, a document fetcher
  interface, structural diff, PDF/HTML rendering, and a CID republish of `contracts/*.json` —
  and treat them as prerequisites rather than as an existing dependency.
- **The sentence-level diff claim is stale.** Stroc's specification stores **one paragraph
  string per section** — `Legacy.md` listed that as a shortcoming and `Specification.md` then
  re-adopted it — so "Stroc's structured paragraphs are what make this diff meaningful" is not
  true at the storage level. Sentence diff is a tool-side computation over a string, which is
  fine, but the document should claim it as such. Worse for the design's purposes: the
  specification's examples still show `text: [[...]]` arrays while `types.ts` says `string`.
  That inconsistency changes CIDs and must be pinned before any strand hashes anything.
- **Cross-references make library clauses non-portable.** Stroc validates
  `<ref:Alias/Section>` at save and blocks save on an unresolved reference, so a clause that
  references a sibling cannot be saved standalone and silently means something different under
  a different parent. The document's semantic caveat covers defined terms but not this
  mechanical constraint, which directly limits the clause library it is banking on.
  **Change:** restrict library clauses to internal references, or ask Stroc for external
  references validated at composition time.
- **IPFS as the third rung of the fetch ladder.** Stroc's ladder ends in IPFS; Sereus has
  none, and Stroc is blocked waiting for it. **Change:** a **public open strand whose sApp is
  just the `Document` table** — a document-library strand using the same fetch RPC and the
  same verification, with no new infrastructure and no external dependency.
- **DAG-JSON links.** DAG-JSON encodes CIDs as `{"/": "bafy…"}`. The document specifies the
  canonicalization but not this: decide whether a CID inside a parameter object, a `replaces`
  array or a binding is a string or a link, because the two hash differently.

---

## 4. Utility across sApps

The document is written from the tally case outward. Three of its four stated targets expose
something it does not yet handle.

### Taleus tally contracts

Covered once §1 and 2.1–2.4 are addressed. A tally is a two-party strand with **asymmetric
roles**, so the instrument must declare the roles and the binding must name which one the
signer takes — the document records the role nowhere. MyCHIPs' "credit terms per direction"
becomes one Credit Terms posting per role, with the agreement declaring the posting kinds and
the ratchet.

### Chat

A chat strand's instrument is **terms of use**: one Operator role executing once, and an
open-ended Member role each joiner accepts. The operator's signature is a standing offer, each
member's is an acceptance, and replacing the terms should bind *new* joiners without every
existing member re-signing. The document's default effective-agreement policy — "all current
members signed" — is wrong for this shape; the policy must come from the instrument's
required-signer declaration.

**Legal roles must not be derived from the RBAC tables.** `Manager` carries
`constraint OnlyClosed check (exists (select 1 from Header H where H.Type = 'c'))`, as do
`Member`, `MemberPeer` and `Revocation`. An open strand therefore has no membership or manager
rows at all, and on a closed strand manager is rotating, resignable and sealable — the
founding manager can resign, one manager can remove another, and the table can be deliberately
emptied. Mapping "Operator" onto "Manager" would hand a strand's terms of use to whoever holds
a manager row, and lose the role entirely on a public strand. Roles come from the instrument
and the binding; whether a holder also holds a `Manager` row is orthogonal. Role succession
must then be explicit — the instrument declares a role transferable and the transfer is a
signed instrument by the current holder.

**A consequence the document half-admits but never connects:** because signatures verify
against `Member.Key` and `Member` is closed-only by schema, **the signing mechanism does not
work on open strands at all**. Open question 1 raises this abstractly; nothing links it to
chat, where public strands are the obvious deployment.

### Health

Consent to data sharing is unilateral, scoped, expiring and revocable — and it is only half
the arrangement. Two instruments layer:

1. **The provider's undertaking** — how data will be used, retained, secured and destroyed;
   breach notification; permitted onward disclosure. Signed by the provider, accepted by the
   patient. Durable.
2. **The patient's consent** — unilateral, scoped, expiring, revocable, sitting under the
   provider agreement and interpreted by it.

Same layering as a notice under an agreement (1.6) and a posting under an agreement (1.2), a
third instance of the one pattern. It also corrects a tempting error: **revoking consent does
not terminate the relationship** — it ends one scoped permission while the provider's
obligations continue. This is the clearest case for per-clause survival (1.6), `party`-class
keys (1.4), and signatures that outlive membership.

### VoteTorrent

Multilateral with many signers and rule-bearing documents (election rules, voter pledges). The
`Signature` table scales, but the property that matters is that a **rule change must be
witnessed by distinct parties** — `feat-open-strand-witness-policy`, itself blocked on party
identity. On an open strand the document's own answer, that any keypair can file a row, makes
a rules agreement meaningless. **Change:** state plainly that multilateral instruments on open
strands wait on both tickets, alongside the open-strand signing gap above.

### The missing sApp mechanism

The goal "allows apps to implement strand contracts where applicable" has no mechanism in the
document: the machine contract (`sAppSchema`, signed by the sApp author) and the human
contract are unconnected.

**Change.** Let the **signed sApp schema declare which instruments it requires or permits** —
a set of template CIDs, or a publisher key. A chat sApp can then require its terms of use, and
the sApp's own constraints can gate writes on `Signature` rows for those templates. That
closes the loop between the document's "the sApp decides which keys matter" and the contract
layer, and it is a small addition to the strand-start schema verification already in place.

### Modular legal documents

Composition by reference is inherited from Stroc and adequate for **structure**. Missing for
**modularity**: parameter namespacing (2.4), portable cross-references (§3), and a
**definitions** convention — a template declares defined terms and library clauses use them
without owning them. MyCHIPs relied on capitalized terms like "Product" and "Pledge of Value"
defined in `Recitals` and `CHIP_Definition`, which worked only because every tally used the
same composition. Publisher trust is the other half and is vNext in the document; a v1
substitute is an app-shipped **seed list of well-known CIDs**, so a first-run breakdown is not
100% novel.

### Third-party signers

A witness, guarantor or notary cannot sign at all, because verification requires `Member.Key`
and they are not members. **Change:** either state the limitation, or let the instrument
declaration name roles that verify against a key stated in the binding rather than against the
member roster.

---

## 5. Notes on the document's schema sketches

- `Signature.Sig` is a stored, self-authenticating column rather than a `with context` value,
  and the row carries no `StampId`. Defensible — primary-key collision is the replay guard,
  the same argument the schema makes for `ConsumedInvite` — but say so, since it departs from
  every sibling table.
- `Signature.ParamsCid null` and `Header`'s "ParamsCid null unless ContractCid" disagree.
  After 1.1 neither rule is needed.
- `SignedAt` and `ExpiresAt` in a digest need the `canonicalDatetime` transform already used
  for `Invite.Expiration`, or the two sides hash different bytes. Name it.
- **Nothing gates `Document` inserts.** On a closed strand any member can fill the table with
  junk; on an open strand anyone can. Require the insert to ride in the same transaction as a
  signature referencing it, or at minimum a member signature over the CID.
- `Document.Cid` verification is left as "app layer on write and on read", which means every
  reader re-hashes every row on every read or trusts its own earlier verification. State the
  caching rule.
- `KnownDocument` last-writer-wins on the `Cid` primary key is wrong for the verdict that
  matters most: a later `approved` row from another device silently overwrites a `rejected`
  one. Keep history, or make rejection sticky.
- **Re-key and departure.** Member re-key is remove-then-add, so signatures under the old key
  survive while "all current members signed" fails. Departure is worse: the row is gone but
  surviving obligations remain. Both argue that `Signature` rows and `Member → SigningKey`
  registrations must be insert-only and independent of live `Member` rows, plus a decision on
  whether a member's key lineage carries signatures forward.

---

## 6. Recommended changes to `strand-contracts.md`

1. **One primitive.** `Signature(StrandId, ContractCid, ParamsCid, BindingCid, SignerKey,
   ExpiresAt, Sig)`. Offer, acceptance, amendment, posting, unilateral update, notice,
   attestation, renewal and closure are all this row with different templates. The signer's
   supersession claim moves into the binding; the successor template's `replaces` stays the
   author's claim.
2. **Signed content is immutable.** Agreement parameters and signer bindings never change;
   changing one is a new version, re-executed.
3. **Mutable values are postings**, referenced by role and template CID. The agreement binds
   the posting rules — who maintains which, the ratchet, the fallback when one is missing.
   Credit terms leave the tally agreement entirely.
4. **Instrument declaration** in the template: roles and transferability, required-signer
   policy, `requiredKeyClass`, maximum offer expiry, revocability, surviving sections, expected
   posting kinds, parameter schema with defaults.
5. **Offers are firm offers.** `ExpiresAt` mandatory and instrument-capped; no withdrawal.
6. **Key class is declared, not fixed.** `member` in-band, `party` for external obligations;
   the member key authorizes filing in both. Hard dependency on `feat-strand-party-identity`.
   Signatures and key registrations survive member departure.
7. **Signatures are bound to the strand** via `Header.Id` in the digest.
8. **Legal roles never derive from the RBAC tables.** `Manager` is orthogonal, closed-only and
   rotates; open strands cannot currently sign at all.
9. **Ending an agreement**: an end date is a parameter; termination by notice is a unilateral
   instrument interpreted by the agreement; a condition-gated close is the sApp's fact plus a
   Certificate of Closure. In-force status is per-clause.
10. **Effective agreement** is a view: the latest un-expired, un-terminated pair for which
    every role the instrument requires has signed. Policy comes from the instrument, not from
    "all current members".
11. **sApp ↔ contract link**: the signed sApp schema may name required or permitted
    instruments.
12. **Rendering** section specifying the canonical executed-agreement artifact and its offline
    reproducibility from strand rows.
13. **Stroc work as named prerequisites**, with the `text` shape pinned and legacy CIDs
    republished before any strand hashes anything.
14. **Public document-library strand** instead of IPFS as the third rung of the fetch ladder.

Items 1–8 change the schema sketch and should land before tickets are cut. Items 9–14 can be
added as sections without disturbing what is already there.

## Open questions this review does not settle

- **Stale or missing postings.** Does the agreement fail closed until posted, or fall back to
  template defaults? The choice matters for a party that goes offline, and it interacts with
  the ratchet.
- **Role transfer.** Does it require the incoming holder's countersignature? It matters most
  for the chat Operator case, where the outgoing holder may already be gone.
- **Posting timing.** "Which posting was in force on date D" needs ordering the strand does not
  globally have. `SignedAt` plus the relying party's own replication record is adequate
  evidence for a dispute, but it is evidence, not proof — the document should say so rather
  than implying the chain is authoritative on timing.
- **Effective-agreement policy for partial signature sets**, which the document already flags
  as its main vNext item and which items 4 and 10 reshape rather than resolve.
