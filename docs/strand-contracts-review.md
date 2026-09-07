# Review: `strand-contracts.md`

Critical review of [`strand-contracts.md`](strand-contracts.md) against its two predecessors
and the goals set for it. Sources read for this review:

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

The design's foundations are sound and should stay: content-addressed templates, a template
signed together with its parameters rather than materialized into them, signing decoupled
from joining, a per-party review registry, and supersession expressed as ordinary
signatures. What follows is where the document is wrong, incomplete, or has quietly dropped
something the earlier designs had.

## The central recommendation

Most of what follows converges on one structural change, so it is worth stating before the
detail.

**Signed content is immutable. Anything that changes is a separate signed instrument.**

The design currently puts the terms inside the agreement and then needs machinery to amend
them. Invert that. An agreement carries only what the parties intend to be fixed for its
life: who they are, what roles they take, which document governs, and the *rules* about
everything else. Values that legitimately move — credit limits, notice addresses, contact
endpoints, consents — live in **postings**: separate unilateral instruments, signed by the
party they belong to, that the agreement references by role and template rather than by
value.

This is not a new mechanism. A posting is the same `(template, params, binding, signer)`
row as everything else, so the model gets *smaller*, not larger. MyCHIPs arrived at the same
place by a harder route: credit terms live inside the signed tally, yet `Credit_Terms`
describes them as changeable at will subject to honoring the old call period, so the schema
had to carry `hold_sets`/`part_sets` as *cached live values* alongside the signed
`hold_terms`/`part_terms`, with settings implemented as a special kind of chit "so they can
benefit from the existing chit exchange and consensus protocol". That seam is the posting
model, discovered late. Sereus should start there.

---

## 1. Core-model defects

Each of these breaks a stated goal if implementation tickets are cut from the document as
written.

### 1.1 One `ParamsCid` conflates agreement terms with signer bindings

The document uses a single parameter object in two incompatible ways:

- **Mutual contract**: "every member signs the same pair" — so the params must be shared
  (the notice period, the governing law).
- **Unilateral instrument**: "signer-specific params (declarant binding, date,
  jurisdiction)" — so the params are per signer.

Both are needed at once in the ordinary case. A Taleus tally has shared terms *and* each
party signs *as* a specific role (Stock Holder vs Foil Holder) with its own identity. An
n-party strand cannot list every future member in a founding params object, so a joiner must
bind itself to a role at signing time. As soon as any signer-specific datum enters the params
object, every signer's `ParamsCid` differs and the "same pair" test that defines the mutual
agreement is unsatisfiable.

**Recommendation.** Split into two content-addressed objects, both immutable, with distinct
positions in the digest:

- `ParamsCid` — the **agreement parameters**, shared by every signer of one agreement: role
  definitions, required-signer policy, notice periods, governing law, the posting rules
  described in 1.2. Identical across signers is what makes them parties to the *same*
  agreement.
- `BindingCid` — the **signer's binding**: which role it executes, its identity bundle
  (2.1), signing date, and any per-signer declarations. Null for a bare terms-of-use
  acceptance.

Agreement identity is `(ContractCid, ParamsCid)`; a signature is
`(ContractCid, ParamsCid, BindingCid, SignerKey)`. This also settles the document's open
question 4 (re-execution): a renewed attestation is a fresh `BindingCid`, and the primary key
becomes `(ContractCid, ParamsCid, SignerKey, BindingCid)` with no nullable-in-primary-key
trick.

**Nothing in either object is unilaterally changeable.** Position in the signer's own binding
is a statement about *who asserts* a datum, never a permission to revise it. A party may not
edit its own legal name, tax ID or executed role, because those are exactly the
representations the counterparty relied on in agreeing at all — `Representations` puts it
plainly ("the identity of each Party, as represented in the Tally, is true and accurate").
Changing any of them is a new version of the agreement, re-executed.

That rule is only affordable because of postings. A party that moves house must be able to
update its notice address without dragging every counterparty through a re-execution round —
so the address is not a binding field at all. It is a posting, and the agreement says notices
go to the address in the party's current Contact posting.

### 1.2 Mutable terms do not belong in the signed agreement

MyCHIPs split tally data into **fixed credit terms** (both signatures required) and **trading
variables / settings** (unilaterally changeable, signed by the changing party alone, binding
via the contract's "Lift Authority" clause). The strand design has only the heavy path: any
parameter change is a replacement agreement re-signed by everyone. Raising your own credit
limit should not require an amendment round.

**Recommendation.** Mutable terms leave the agreement entirely and become **postings**. The
agreement binds the *rules* governing them and nothing else:

- who must maintain a posting of each kind, and under which template;
- the **ratchet** — MyCHIPs' rule that a tightening takes effect only after the
  previously-posted call notice elapses ("when reducing the call from 120 to 30, the
  effective terms will still be 120 until that period of time has first elapsed");
- the fallback when a posting is missing or stale, which is where the template defaults of
  2.3 earn their keep.

Why this is better than declaring per-field mutability inside the parameters:

1. **Agreement identity stays stable.** Otherwise every tweak to a limit or an address mints
   a new params object and therefore a new agreement identity — or forces an "identity
   ignores these keys" rule, at which point the signed pair no longer determines the terms
   and the whole content-addressing story leaks.
2. **No second mechanism.** A posting is an ordinary instrument. Per-field mutability classes
   would be a concept that exists only inside parameters and nowhere else in the model.
3. **Reliance becomes auditable.** "What were your credit terms on date D" is answered from
   the party's own signed posting chain, independently of the agreement.
4. **It generalizes.** A health consent, a chat terms-of-use acceptance, a contact-details
   update and a voter pledge are all naturally postings.

**The payoff is large and easy to miss.** With credit terms removed, a tally agreement's
parameters shrink to the parties' identities and roles, the tally id, and the date — a table
of names and a date, which is exactly what the design says a joiner should have to read. Its
`(ContractCid, ParamsCid)` then becomes *identical across a very large number of tallies*,
which is what makes the registry-recognition story actually pay off. Under the current design
every tally carries different numbers in its parameters, so every tally's parameters are
novel and must be read in full.

One reclassification follows: MyCHIPs' `Credit_Terms` stops being a clause of the agreement
and becomes a **posting template**. That is a clarification rather than a loss — the document
already reads like the definition of a data object rather than contract prose ("Maximum
Balance (limit); Default: 24").

Mechanically, the agreement must reference a posting **by role and template CID, never by
posting CID** — pinning a CID would pin a version and defeat the purpose.

### 1.3 The signature is not bound to the strand

The `Signature` digest is `('Strand.Signature', 'v1', ContractCid, ParamsCid, ReplacesCid,
SignerKey, SignedAt)`. Nothing in it names the strand. A template plus role-generic
parameters is by design identical across many strands, so a signature row lifted from one
strand verifies in any other strand that adopted the same pair. MyCHIPs avoided this because
the tally digest covered the tally UUID.

**Recommendation.** Put `Header.Id` in the digest, and either on the row or resolved at
verify time from the strand's own header.

### 1.4 The signing key is not a party's key

Signing verifies against `Member.Key`. Two facts about that key undermine it as a legal
signature:

- Today every party on a production closed strand presents the **same** member key. The
  founding key derived from `Strand.MemberPrivateKey` is handed to every joiner; per-party
  member keys are minted only in tests (`feat-strand-party-identity`). Until that ticket
  lands, `Signature.SignerKey` cannot distinguish parties at all, and "all current members
  signed" is one row.
- The member private key is deliberately held **in plaintext on every node of the cadre**
  ([`strands.md`](strands.md) → Closed-Strand Member Key Handling), minted by software and
  rotated by remove-then-add. That is appropriate for "this party's software authorized this
  write" and weak for "this party agreed to be bound". MyCHIPs signed with the user's own
  signing key.

**Recommendation.** Declare `feat-strand-party-identity` a hard prerequisite, and let the
**instrument declare which class of key may execute it** rather than fixing one answer for
all apps. The distinction that matters is not one app versus another; it is what the
signature has to survive. A tally signature may be shown to a court years later against a
party denying it. A chat confidentiality undertaking mostly has to be shown to the other
members of that strand, in-band, while the strand is live. Requiring an enclave-held human
ceremony for every acceptance would also defeat the design's own auto-accept policy knob,
which only makes sense if accepting is cheap.

So `requiredKeyClass` becomes part of the instrument declaration (2.5):

- **`member`** — the strand member key. Cheap, in-band, verifiable from strand tables alone.
  Adequate for terms of use, participation rules, and chat confidentiality.
- **`party`** — a key the party controls outside the strand's replication: an enclave-held
  owner key, or a signing key registered against the member by a member-signed
  `Member → SigningKey` row using the same stamp idiom as `MemberPeer`. Required for anything
  creating an external obligation — tallies, guarantees, health consents.

In both classes the member key authorizes *filing* the row; in `party` class the filing key
and the signing key differ and both are checked. Keeping the registration in strand data is
what lets a verifier work from the strand alone.

**Departure has a schema consequence.** A confidentiality undertaking is among the ones you
most need to enforce *after* someone leaves, and a departing member's `Member` row is
deleted. So `Signature` rows and key registrations must be insert-only and independent of
*live* `Member` rows, with membership checked at insert time only. A verification path that
joins to `Member` at read time silently voids exactly the signatures that matter most.

### 1.5 No negotiation, no offer, no expiry

MyCHIPs' tally protocol is mostly negotiation: `draft → P.draft → offer → (counter-offer |
void | open)`, with the joiner able to revise terms and re-sign, the offeror able to void an
unaccepted offer, and a revision counter that clears stale signatures. The strand design has
a founding pair fixed by the bootstrap writer and an insert-only `Signature` table. A joiner
can accept or walk away; it cannot propose its own terms; and a signed offer the counterparty
never countersigned stands forever, acceptable years later.

The design's own machinery contains the fix once it is stated: **a signature over a pair is
an offer while the other required signers are absent, and an acceptance once they are
present.** That is exactly MyCHIPs' `H.offer`/`P.offer`. Two things must be added:

- **Proposal is just a signature.** The `Header` pair is not special beyond being the
  *first* proposal. Any member may insert documents and sign a new pair; the breakdown shows
  outstanding proposals to the other members.
- **Mandatory expiry, and no withdrawal at all.** Every signature that is not yet an
  acceptance carries a required `ExpiresAt` bound into the digest. An offer lapses on its
  own; it is never revoked.

**Offers are firm offers — this is a deliberate legal design, not a compromise.** Three
reasons:

1. **It matches the distributed reality instead of fighting it.** A strand has no global
   order, so "was the withdrawal replicated before the acceptance was signed" is not
   answerable from the rows. Any withdrawal mechanism has a window in which two honest
   parties reach opposite conclusions, each holding a valid signature — the worst possible
   failure mode for a legal record.
2. **Expiry is decidable from the digests alone.** Both sides read the same `ExpiresAt` out
   of the offer and the same `SignedAt` out of the acceptance. No replication ordering
   required. It degrades to "was the acceptor's clock honest", which is smaller, familiar,
   and checkable by the offeror on receipt.
3. **It has legal precedent.** Common law does allow revocation before acceptance, but
   revocation is effective *on receipt* — precisely the ordering fact a strand cannot
   establish. An offer stated irrevocable until a date is a firm offer, long established.
   "All offers are firm offers with a stated expiry" is self-consistent and enforceable
   *because* it is decidable.

What it costs, and how each cost is met:

- **An offer without an expiry is a perpetual option**, binding the offeror until the
  counterparty feels like accepting under changed circumstances. Hence `ExpiresAt` is
  mandatory, and the instrument declaration should be able to **cap** it ("offers under this
  template expire in at most 30 days") so a template can prevent a stale option.
- **Short expiries are the withdrawal mechanism.** To keep room to change your mind, offer
  with a 24-hour expiry and re-offer. That is how firm offers work commercially, and it puts
  the timing decision where the offeror actually holds the information rather than in a race.
- **Breach and mistake belong elsewhere.** The aggrieved party asserts breach or
  misrepresentation as a unilateral instrument *against the executed agreement*, not by
  unforming it. The record stays monotone: nothing un-happens.
- **Superseding an outstanding offer is still expressible.** File a replacement offer whose
  binding names the prior one. If the counterparty accepts the old one before it expires, the
  old one binds — correct under the firm-offer rule. The replacement is a courtesy signal,
  not a revocation.

### 1.6 No ending

Contracts end. MyCHIPs tallies close (`C.open → close`); a health-data consent is revoked; a
member leaves a chat. The design has no ending at all — supersession replaces, nothing
terminates. Three situations are involved and they behave differently:

1. **Natural expiry — an agreement parameter.** The end date sits in the agreement
   parameters, decidable from the signed pair alone, needing no new mechanism and immune to
   ordering disputes. This is strictly better than an event and should be in the design.
2. **Termination by notice under the agreement's own terms — a unilateral instrument.**
   "Either party may terminate on 30 days' notice" means the *notice* is unilateral and its
   *effect* is determined by the bilateral agreement it names. That is how the paper document
   works, and it is the same layering as a posting: the instrument carries the assertion, the
   agreement carries the interpretation.
3. **Termination conditioned on observable state.** MyCHIPs' `C.open → close` completes only
   when the tally balance reaches zero; a health consent may require records destroyed. The
   notice is unilateral but the effect is conditional on a fact both parties can observe.

**Case 3 is the one with a wrinkle: the condition is app state, not contract state.** Whether
a tally balance is zero is a Taleus fact. So the contract layer records "notice filed, effect
per terms" and the **sApp** computes in-force status — consistent with the design's existing
stance that the schema supports and the contract text decides. Additionally, the closing party
should file a **Certificate of Closure** once the condition is met, so the chain has a clean,
verifiable terminal record; MyCHIPs effectively does this, since reaching `close` is an
observable agreed state.

**Revocation of a unilateral instrument is a separate case.** A patient withdrawing consent
has no counterparty agreement to interpret the notice, so revocability must be declared by
the instrument itself — the instrument declaration again.

**In-force status is per-clause, not one boolean per agreement.** Confidentiality, data
destruction, dispute resolution and unsatisfied balances survive termination by design. An
"effective agreement = head of chain minus terminated" model would wrongly wipe them. At
minimum the instrument must declare which of its sections survive.

### The single primitive

1.1–1.6 all resolve into one row shape. **Every legal act is `(template, params, binding,
signer)`** — offer, acceptance, amendment, posting, unilateral update, notice, attestation,
renewal and closure. The design should say this once, up front, instead of introducing
supersession, unilateral instruments and amendments as three separate mechanisms.

---

## 2. Regressions from the MyCHIPs design

### 2.1 Party identity in the signed record

A MyCHIPs tally embedded each party's **certificate** in the signed data: name, ID type and
ID (email, domain, tax number), contact/agent, public key, optionally birth record. The
`Representations` clause depends on it, and it is what makes an agreement enforceable against
a person rather than against a key. The strand design says parameters carry "role bindings"
and never says what a binding contains; `StrandFormationDisclosure` offers `partyId` and an
`identityBundle: unknown`.

**Recommendation.** Define the identity bundle as a canonical DAG-JSON object with the
MyCHIPs certificate fields as the starting point, and place it in the signer binding (1.1),
where it is immutable. Contact endpoints that legitimately change belong in a Contact posting
instead (1.2).

### 2.2 The rendered agreement

`buildpdf.js` produced the artifact a party would actually retain or take to court: contract
text with per-section hashes, both certificates, both parties' terms as tables, the tally
UUID/date/digest, both signatures, QR codes. `learn-contract.md` → "Tally Agreement Layout"
specifies it. The strand design covers this in one clause ("the renderer may append a
signature block and parameter table").

**Recommendation.** Add a section specifying the **canonical rendering of an executed
agreement** — template, parameter table, each signer's binding, the postings in force, strand
id, every CID, and the signatures — plus the requirement that any party can produce it
offline from `Document` and `Signature` rows alone. Stroc's PDF export is an unstarted phase,
so this is a dependency, not a footnote.

### 2.3 Prose ↔ parameter linkage convention

MyCHIPs' `Credit_Terms` named each parameter's JSON key in its heading — "Maximum Balance
(limit); Default: 24" — linking prose to data by a readable convention, and every term had a
**default** for when the data omitted it. The strand design defers linkage to a vNext
`<var:>` markup and says nothing about defaults.

**Recommendation.** State the MyCHIPs convention as a template-authoring rule for v1, plus a
rule for missing values: a default declared in prose, and absent-with-no-default treated as a
validation error at review time. Under 1.2 this now governs *posting* templates against
posting keys as much as agreement templates against agreement parameters — and the fallback
for a missing posting depends on it.

### 2.4 Parameter namespacing for reusable clauses

MyCHIPs sidestepped key collisions by having exactly two term objects (stock/foil). Once
clauses are a shared library, two clauses will both want `limit` or `notice`. Namespace
parameters by the including section's `as` alias (`Credit_Terms.limit`), or the design's
"clause library equilibrium" collides on first reuse.

### 2.5 Suitability marker, and the instrument declaration

MyCHIPs marked documents suitable for direct inclusion in a tally with `top: true`; Stroc
removed it. Nothing stops a strand naming the Ethics clause as its `ContractCid`.

**Recommendation.** A signable **instrument** declares itself. The declaration has grown
through this review and now carries: roles and their transferability, required-signer policy,
`requiredKeyClass`, maximum offer expiry, revocability, which sections survive termination,
the posting kinds the agreement expects, and the parameter schema with defaults. Store it in
v1 even if validation waits.

### 2.6 Non-binding test agreement

`Tally_Testing.yaml` wraps the real contract in a clause making the whole agreement
non-binding, so test tallies still exercise the full signing path. The strand design allows
`ContractCid` null for "no human contract", which is the wrong default for dev and test.

**Recommendation.** Test strands adopt an explicit non-binding wrapper template; null means
"this strand carries no legal instrument" (a chat with no terms), not "testing".

### 2.7 Version and translation lineage

MyCHIPs' `(host, name, version, language)` coordinates let a reader find "the same document,
newer version" and "the same document, in my language". Stroc dropped all four; the design's
`replaces` restores version lineage only. **Translation lineage is missing** — a party that
approved the English Ethics clause sees a Spanish rendering as novel, and the multilingual
wrapper as novel too.

**Recommendation.** Add a `translates` link alongside `replaces` in the Stroc metadata
request, with the same advisory-only trust treatment.

### 2.8 Where the "receipt" actually lives

The document claims `FormationUsage.PeerSig` is a re-verifiable receipt of having been shown
the terms. Checked against `control.qsql`: the consent digest covers
`(Token, UsageStampId, PeerKey, Disclosure)`, where `Disclosure` is the **joiner's own**
disclosure text, and the row lives in the **host's** control database, not in the strand.

**Recommendation.** The receipt holds only if the joiner *echoes* the agreement pair into its
own disclosure, so its signature covers it. State that echo as a protocol requirement, and
note that the result is host-held evidence, not strand data.

---

## 3. Mismatches with Stroc as it exists

- **"Zero Stroc changes in v1" is not true.** The breakdown's "modified" classification leans
  on `replaces`; hash canonicalization requires republishing every legacy document; and the
  diff and tree-resolution code the placement table assigns to `@stroc/core` does not exist
  (STATUS: no fetcher, no included-document display, no diff, no PDF; the project is paused
  waiting on Sereus IPFS). List the Stroc work as explicit tickets: `replaces`/`translates`
  metadata, the instrument declaration, a document fetcher interface, structural diff,
  PDF/HTML rendering, and a CID republish of `contracts/*.json`.
- **The sentence-level diff claim is stale.** Stroc's final specification stores **one
  paragraph string per section** — `Legacy.md` listed that as a shortcoming and
  `Specification.md` then re-adopted it. "Stroc's structured paragraphs are what make this
  diff meaningful" is not true at the storage level; sentence diff is a tool-side computation
  over a string. Worse, the specification's own examples still show `text: [[...]]` arrays
  while `types.ts` says `string`. That inconsistency changes CIDs and must be pinned before
  anything is hashed.
- **Cross-references make clauses non-portable.** Stroc validates `<ref:Alias/Section>` at
  save and blocks save on an unresolved reference, so a library clause that references a
  sibling cannot be saved standalone and silently means something different under a different
  parent. The design's "semantic caveat" mentions defined terms but not this mechanical
  constraint. Either restrict library clauses to internal references, or ask Stroc for
  external references validated at composition time.
- **IPFS as the public store.** Stroc's resolution ladder ends in IPFS; Sereus has none, and
  Stroc is waiting on it. A cheaper and already-consistent answer is a **public open strand
  whose sApp is just the `Document` table** — a document-library strand, using the same fetch
  RPC and the same verification, with no new infrastructure.
- **DAG-JSON links.** DAG-JSON encodes CIDs as `{"/": "bafy…"}`. Decide whether a CID inside
  a parameter object, a `replaces` array, or a binding is a string or a link — the two hash
  differently.

---

## 4. Coverage of the stated goals

### Taleus tally contracts

Covered once §1 and 2.1–2.4 are addressed. A tally is a two-party strand with **asymmetric
roles**, so the instrument must declare the roles and the binding must name which one the
signer takes — the document records the role nowhere today. MyCHIPs' "credit terms per
direction" becomes one Credit Terms **posting per role**, with the agreement declaring the
posting kinds and the ratchet (1.2).

### Chat

A chat strand's instrument is **terms of use**: one Operator role that executes once, and an
open-ended Member role each joiner accepts. That is an asymmetric n-party agreement — the
operator's signature is the standing offer, each member's is an acceptance, and replacing the
terms should bind *new* joiners without every existing member re-signing. The document's
default effective-agreement policy ("all current members signed") is wrong for this shape;
the policy must come from the instrument's required-signer declaration instead.

**Legal roles must never be derived from the RBAC tables.** `Manager` carries
`constraint OnlyClosed check (exists (select 1 from Header H where H.Type = 'c'))`, as do
`Member`, `MemberPeer` and `Revocation`. So an open strand has no membership or manager rows
at all, and on a closed strand manager is a rotating, resignable, sealable role — the
founding manager can resign, one manager can remove another, and the table can be
deliberately emptied. Mapping "Operator" onto "Manager" would hand your terms of use to
whoever happens to hold a manager row, and lose it entirely on a public strand. A role is
declared by the instrument and bound in the signer's binding; whether the holder also holds a
`Manager` row is orthogonal and may be many-to-many or empty. Role succession must therefore
be explicit: the instrument declares a role transferable, and the transfer is a signed
instrument executed by the current holder.

**A sharper consequence the design half-admits but never connects:** because the sketch
verifies signatures against `Member.Key`, and `Member` is closed-only by schema, **the signing
mechanism does not work on open strands at all**. Open question 1 raises this abstractly;
nobody links it to chat, where public strands are the obvious deployment.

### Health

Consent to data sharing is unilateral, scoped, expiring and revocable — but it is only half
the picture. There are two instruments, of different kinds, and they layer:

1. **The provider's undertaking** — bilateral or standing: how data will be used, retained,
   secured and destroyed; breach notification; permitted onward disclosure. Signed by the
   provider, accepted by the patient. Durable.
2. **The patient's consent** — unilateral, scoped, expiring, revocable, sitting *under* the
   provider agreement and interpreted by it.

That is the same layering as a notice under an agreement (1.6) and a posting under an
agreement (1.2) — a third instance of one pattern, and further evidence the pattern is the
right primitive.

The layering also corrects a tempting error: **revoking consent does not terminate the
relationship.** It ends one scoped permission while the provider's obligations continue.
This is the clearest case for the per-clause survival rule in 1.6, for `party`-class signing
keys (1.4), and for signatures that outlive membership.

### VoteTorrent

Multilateral with many signers and rule-bearing documents (election rules, voter pledges).
The `Signature` table scales, but the property that matters is that a **rule change must be
witnessed by distinct parties** — precisely `feat-open-strand-witness-policy`, itself blocked
on party identity. On an open strand the document's own answer ("any keypair can file a row")
makes a rules agreement meaningless. State plainly that multilateral instruments on open
strands wait on both tickets, and note the open-strand signing gap above.

### Apps implementing strand contracts

The goal has no mechanism today: the machine contract (`sAppSchema`, signed by the sApp
author) and the human contract are unconnected.

**Recommendation.** Let the **signed sApp schema declare which instruments it requires or
permits** — a set of template CIDs, or a publisher key. A chat sApp can then require its terms
of use, and the sApp's own constraints can gate writes on `Signature` rows for those
templates. That closes the loop between "the sApp decides which keys matter" and the contract
layer, and it is a small addition to the strand-start schema verification already in place.

### Modular legal documents

Composition by reference is inherited from Stroc and adequate for **structure**. Missing for
**modularity**: parameter namespacing (2.4), portable cross-references (§3), and a
**definitions** convention — a template declares defined terms and library clauses use
without owning them. MyCHIPs relied on capitalized terms like "Product" and "Pledge of
Value" defined in `Recitals` and `CHIP_Definition`, which worked only because every tally
used the same composition.

Publisher trust is the other half and is vNext in the document. A v1 substitute is an
app-shipped **seed list of well-known CIDs**, so a first-run breakdown is not 100% novel.

### Unilateral, bilateral and multilateral

The shape is right; the details are broken by 1.1 (per-signer parameters), 1.3 (strand
binding) and the missing role record. One further gap: **third-party signers — a witness, a
guarantor, a notary — cannot sign at all**, because verification requires `Member.Key`.
Either state that limitation, or let the instrument declaration name roles that verify
against a key stated in the binding rather than against the member roster.

### Templates with parameterized key items

Parties, dates and terms are the three named examples. Parties lack an identity bundle (2.1).
Dates: `SignedAt` is self-asserted with no bound, and neither an effective date nor an expiry
is representable outside prose (1.5, 1.6 fix this). Terms move to postings (1.2), which is
what makes the templates themselves stable enough to be recognized. The vNext `<var:>` markup
is the right end state; v1 needs the conventions written down so templates authored now do
not have to be re-hashed later.

---

## 5. Schema-level notes

- `Signature.Sig` is a stored, self-authenticating column rather than a `with context` value,
  and the row carries no `StampId`. That is defensible — primary-key collision is the replay
  guard, the same argument the schema makes for `ConsumedInvite` — but the document should
  say so, since it departs from every sibling table.
- `Signature.ParamsCid null` and `Header`'s "ParamsCid null unless ContractCid" disagree;
  after 1.1 neither rule is needed.
- `SignedAt` and `ExpiresAt` in a digest require the `canonicalDatetime` transform already
  used for `Invite.Expiration`. Name it, or the two sides hash different bytes.
- **Nothing gates `Document` inserts.** On a closed strand any member can fill the table with
  junk; on an open strand anyone can. Require the insert to ride in the same transaction as a
  signature that references it, or at minimum a member signature over the CID.
- `Document.Cid` must be verified somewhere. "App layer on write and on read" means every
  reader re-hashes every row on every read, or trusts its own earlier verification. State the
  caching rule.
- `KnownDocument` is advisory and per-party yet uses the owner-signed stamp and revocation
  machinery. Acceptable, but note that a **rejected** verdict is the one that matters for
  safety: last-writer-wins on a `Cid` primary key lets a later `approved` row from another
  device silently overwrite it. Keep history, or make rejection sticky.
- **Re-key and departure.** Member re-key is remove-then-add, so signatures under the old key
  survive while an "all current members signed" test fails. Departure is worse: the row is
  gone but surviving obligations remain. Both argue that `Signature` rows and
  `Member → SigningKey` registrations must be insert-only and independent of live `Member`
  rows, with membership checked at insert time only, plus a decision on whether a member's
  key lineage carries signatures forward.

---

## 6. Recommended shape

1. **One primitive.** `Signature(StrandId, ContractCid, ParamsCid, BindingCid, SignerKey,
   ExpiresAt, Sig)`. Offer, acceptance, amendment, posting, unilateral update, notice,
   attestation, renewal and closure are all this row with different templates. The signer's
   supersession claim moves into the binding; the successor template's `replaces` stays the
   author's claim.
2. **Signed content is immutable.** Agreement parameters and signer bindings never change;
   changing one is a new version, re-executed. Location in a signer's own binding confers no
   permission to revise it.
3. **Mutable values are postings** — separate unilateral instruments, referenced by the
   agreement by role and template CID, never by value. The agreement binds the posting rules:
   who maintains which posting, the ratchet on tightening, and the fallback when a posting is
   missing. Credit terms leave the tally agreement entirely.
4. **Instrument declaration** in the template: roles and their transferability,
   required-signer policy, `requiredKeyClass`, maximum offer expiry, revocability, surviving
   sections, expected posting kinds, and the parameter schema with defaults. Stored in v1;
   validation may follow.
5. **Offers are firm offers.** `ExpiresAt` mandatory and instrument-capped; no withdrawal
   mechanism. Breach and mistake are asserted against the executed agreement, never by
   unforming it.
6. **Key class is declared, not fixed.** `member` for in-band instruments, `party` for
   external obligations; the member key authorizes filing in both cases. Hard dependency on
   `feat-strand-party-identity`. Signatures and key registrations survive member departure.
7. **Signatures are bound to the strand** via `Header.Id` in the digest.
8. **Legal roles never derive from the RBAC tables.** Roles come from the instrument and the
   binding; `Manager` is orthogonal, closed-strand-only, and rotates.
9. **Ending an agreement**: an end date is a parameter; termination by notice is a unilateral
   instrument interpreted by the agreement; a condition-gated close is the sApp's fact plus a
   Certificate of Closure. In-force status is per-clause.
10. **Effective agreement** is a view: the latest un-expired, un-terminated pair for which
    every role the instrument requires has signed. The policy comes from the instrument, not
    from "all current members".
11. **sApp ↔ contract link**: the signed sApp schema may name required or permitted
    instruments.
12. **Rendering** section specifying the canonical executed-agreement artifact and its offline
    reproducibility from strand rows.
13. **Stroc work as named tickets**, with the `text` shape pinned and legacy CIDs republished
    before any strand hashes anything.
14. **Public document-library strand** instead of IPFS as the third rung of the fetch ladder.

Items 1–8 change the schema sketch and should land in the design before tickets are cut.
Items 9–14 can be added as sections without disturbing what is already there.

## Open questions this review does not settle

- **Stale or missing postings.** Does the agreement fail closed (unenforceable until posted)
  or fall back to template defaults? The choice has real consequences for a party that goes
  offline, and it interacts with the ratchet.
- **Role transfer.** Does it require the incoming holder's countersignature? It matters most
  for the chat Operator case, where the outgoing holder may already be gone.
- **Posting timing.** "Which posting was in force on date D" needs ordering the strand does
  not globally have. `SignedAt` plus the relying party's own replication record is adequate
  evidence for a dispute, but it is evidence, not proof — the design should say so rather than
  implying the chain is authoritative on timing.
- **Effective-agreement policy for partial signature sets**, which the original document
  already flags as its main vNext item and which items 4 and 10 above reshape rather than
  resolve.
