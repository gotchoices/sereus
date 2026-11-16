# Strand Contracts (Human Agreements)

Design, not built. Nothing here is implemented.

A strand records the rules its members' nodes enforce, but not the legal terms its members agree to or any proof that a party accepted them. This design attaches human-readable agreements to strands: content-addressed documents, per-party signatures over them, and a per-party record of documents reviewed. It would add two columns to `Strand.Header` and three tables to `schemas/strand.qsql`, one table to `schemas/control.qsql`, a document-fetch protocol, and a field in the formation disclosure. The shipped behaviour it builds on is in [Strands: model and lifecycle](../strands/lifecycle.md), [Closed-strand membership](../strands/membership.md), [Inviting and joining](../strands/formation.md) and [The control schema](../cadre/control-schema.md); everything else described here is proposed.

## Purpose

A strand pins its **machine contract**: `Strand.Header` carries `sAppId`, `sAppSchema`, `sAppSignature`, `Engine` and `EngineVersion`, the rules a joining party's nodes will enforce. This design adds the **human contract**: the legal text a party agrees to, bound into a signature that proves the party agreed.

Several of its rules come from [MyCHIPs](https://github.com/gotchoices/mychips), a credit network in which a **tally** is a signed credit agreement between two parties.

It has three goals:

1. **Binding.** A party's signature provably covers the exact terms in force. Signing is its own act, recorded in the strand and separate from joining.
2. **Recognition.** A party keeps a registry of documents it has reviewed, so a new strand's terms can be shown as a breakdown: sections approved before, sections that differ from an approved version, and new ones that must be read.
3. **Generality.** One mechanism serves tallies, chat terms of use, health consents and voting rules, and the contract layer knows nothing about the sApp that adopts it.

## Background: Stroc

Contract documents are [Stroc](https://github.com/gotchoices/stroc) documents. Stroc is a general document library that does not depend on Sereus. This design relies on these properties:

- **Content-addressed.** A document's identity is its CID, the hash of its canonical encoding ([Hash Canonicalization](#hash-canonicalization)), so presentation never affects identity and wording always does.
- **Composable.** A reference section, `{"id": "ethics", "source": {"/": "<cid>"}}`, includes another document at that position, to any depth.
- **Parameterized.** A document declares the values it expects (key, label, optional default) and takes them from a separate, unhashed data object, so one document serves any number of agreements.
- **Versioned by lineage.** An optional, hashed `replaces` field lists the CIDs of the versions a document supersedes.
- **Multilingual by wrapper.** A wrapper document includes each language version by reference and states the governing language, so the strand references one CID.

## Core Model

### One primitive

Every legal act on a strand is the same thing: a signer executing an instrument under parameters, with a binding of its own. Offer, acceptance, amendment, posting, notice, attestation, renewal and closure are all this one row with different templates.

An act names three content-addressed things and a key:

- `ContractCid` is the **instrument**: a Stroc template whose prose names roles, not parties, and is identical in every strand that adopts it.
- `ParamsCid` is the **agreement parameters** every signer of one agreement shares: role definitions, required-signer policy, notice periods, governing law, posting rules, end date.
- `BindingCid` is the **signer's binding**: the role it executes, its identity bundle, its own declarations and, for a posting, the values it is posting.
- `SignerKey` is the key that executed the act.

Agreement identity is the pair `(ContractCid, ParamsCid)`: two parties are parties to the same agreement exactly when their signatures name the same pair. A signature is `(ContractCid, ParamsCid, BindingCid, SignerKey)`.

`ParamsCid` is always present. A standalone unilateral instrument that shares nothing names the CID of the canonical empty object. A posting's parameters name the agreement it serves.

### Signed content is immutable

Nothing inside `ContractCid`, `ParamsCid` or `BindingCid` is ever revised in place. Changing any of it is a new version, executed again by whoever the instrument says must sign.

A binding says who asserts a datum, never who may revise it. A party may not edit its legal name, tax ID or executed role, because the counterparty relied on those representations. The rule is workable because values that must change are kept out of signed content, in postings.

### Mutable values are postings

Values that change (credit limits, notice addresses, contact endpoints, consents) are not agreement parameters but **postings**: unilateral instruments signed by the party they belong to. The agreement references a posting by role and template CID, never by the posting's own CID, which would pin one version.

The agreement binds only the rules that govern postings:

- who maintains a posting of each kind, under which template;
- the **ratchet**: MyCHIPs' rule that a tightening takes effect only after the previously posted notice period has passed;
- the fallback when a posting is missing or stale.

Recognition depends on this. A tally whose credit limits sit in its parameters has unique parameters, which a party must read in full every time. With the terms in postings, a tally agreement's parameters shrink to the parties, their roles, the tally id and the date, and `(ContractCid, ParamsCid)` is identical across a very large number of tallies.

MyCHIPs shows the cost of the alternative: its credit terms live inside the signed tally but may be changed at will, so its schema carries cached live values beside the signed terms. Its `Credit_Terms` document is therefore a posting template here.

### Instrument declaration

A document that is meant to be signed declares itself an instrument, and nothing else may be named as a strand's `ContractCid`, so a strand cannot name a single clause as its contract. The declaration states:

- **Roles** the instrument defines, and whether each is transferable.
- **Required-signer policy:** which roles must sign for the instrument to be executed.
- **`requiredKeyClass`:** `member` or `party` ([Key class](#key-class)).
- **Maximum offer expiry:** the longest `ExpiresAt` an offer under this template may carry.
- **Revocability:** whether a signer may revoke a unilateral instrument under this template.
- **Surviving sections:** which sections outlive termination.
- **Expected posting kinds:** the template CID and the responsible role for each.
- **Parameter schema:** names, types and defaults for the agreement parameters and the binding fields. Stroc's own `parameters` declaration covers key, label and default, without types.

v1 would store and display the declaration; until it is validated by machine, review is the check. Where the declaration is carried is undecided ([Open Questions](#open-questions)).

## Anchoring: `Strand.Header`

The design adds two nullable columns to the `Header` singleton in `schemas/strand.qsql`:

```sql
	-- CID of the Stroc instrument governing this strand (null = no human contract)
	ContractCid text,
	-- CID of the agreement parameters completing the pair
	ParamsCid text,
```

`Header` is insert-only, so the pair it names is immutable. It is the **founding proposal**: what the founder offered, not proof that anyone executed it. Execution is recorded in `Signature`, and any member may later propose a different pair, so the founding pair has no privilege beyond being first. A constraint requires the two columns to be both null or both set. Open and closed strands both carry them.

Null means the strand carries no legal instrument; it does not mean "testing". A test strand adopts an explicit wrapper template that voids the real contract, so that test strands exercise the whole signing path.

## Signing

Joining a strand and signing its contract are distinct acts. Joining admits a party's nodes to the network and, on a closed strand, seats its `Member` row; this design does not change it. Signing would be recorded in a new strand table:

```sql
	table Signature (
		StrandId text,          -- Header.Id: binds this act to THIS strand
		ContractCid text,       -- the instrument executed
		ParamsCid text,         -- agreement parameters (empty-object CID if none)
		BindingCid text,        -- this signer's binding
		SignerKey text,         -- the key that executed the act
		SignedAt datetime,
		-- Required while the instrument is not yet fully executed; see Offers
		ExpiresAt datetime null,
		-- ed25519 over ('Strand.Signature', 'v1', StrandId, ContractCid, ParamsCid,
		--               BindingCid, SignerKey, SignedAt, ExpiresAt)
		Sig text,
		primary key (ContractCid, ParamsCid, BindingCid, SignerKey),
		constraint InsertOnly check on update, delete (false),
	);
```

**The signature is stored on the row.** `Sig` is a column any reader can verify, not a value passed through `with context`. Unlike the membership tables, the row carries no `StampId`: the primary key is the replay guard, as for `Invite` and `ConsumedInvite` in `schemas/strand.qsql`. Nobody can forge a row for another party's key, because `Sig` must verify against `SignerKey`.

**`StrandId` is in the digest.** Instruments and their parameters are designed to be identical across many strands, so without the strand id a signature row copied from one strand would verify in any other that adopted the same pair.

**The two datetimes are canonical.** `SignedAt` and `ExpiresAt` are stored through the `canonicalDatetime()` transform used for `Invite.Expiration`, so both sides of a comparison hash identical bytes.

Signing is separate from joining for three reasons:

- **Review can happen after joining.** A party may join, sync the `Document` table, review the breakdown and sign afterwards.
- **The signature block is strand data.** Every member's nodes replicate the rows, so any reader can verify who executed what.
- **A strand has more than one act.** Postings, notices, riders and replacement agreements are each a row in the same table.

What an admitted member that has not signed may do is policy, not schema. The sApp's constraints can make writes depend on `exists (select 1 from Signature ...)`, and the instrument can state grace terms for the time between joining and signing.

### Key class

The instrument declares which class of key may execute it, because no single answer fits every sApp: an enclave-held key for every acceptance would make joining a public strand slow, and a replicated software key is too weak for a credit obligation.

- **`member`:** the party's key in `Strand.Member`, whose private half every machine of the party holds ([Closed-strand member key handling](../strands/keys.md#closed-strand-member-key-handling)). It is cheap, verifiable from strand tables alone, and adequate for terms of use, participation rules and chat confidentiality.
- **`party`:** a key the party controls outside the strand's replication, such as an enclave-held owner key or a signing key the member registers. It is required for anything that creates an external obligation: tallies, guarantees, health consents.

The `party` class needs a registration that the strand itself can verify:

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

A `Signature` row is admissible when `SignerKey` is a live `Member.Key` (`member` class) or appears in `SigningKey` (`party` class).

**Membership is checked at insert time only, never at read time.** A departing member's `Member` row is deleted, but the obligations most in need of enforcement afterwards (confidentiality, data destruction, an unsatisfied balance) are that party's. `Signature` and `SigningKey` are therefore insert-only and never joined to live `Member` rows on read, which would void the signatures that matter most. Replacing a party's member key seats a new key and removes the old one ([Replacing the party's key](../strands/keys.md#replacing-the-partys-key)), and signatures under the retired key likewise remain valid acts.

### Offers, and why there is no withdrawal

A signature over a pair is an offer while the other required signers are absent, and an acceptance once they are present. The design needs no other negotiation mechanism: a counterparty that wants different terms signs a different pair, which is a counter-offer.

Every signature that is not yet an acceptance carries a mandatory `ExpiresAt`. An offer lapses; it is never withdrawn.

A strand has no global order, so whether a withdrawal was replicated before an acceptance was signed cannot be answered from the rows, and every withdrawal would have a period in which two honest parties hold valid, contradictory signatures. Expiry can be decided from the digests alone: both sides read the same `ExpiresAt` and `SignedAt`, and the question reduces to whether the acceptor's clock was honest, which the offeror checks on receipt.

A firm offer with a stated expiry is a long-established instrument, so nothing a contract needs to express is lost. A party that wants room to change its mind offers with a short expiry and offers again, within the instrument's declared maximum. Breach and mistake are asserted as instruments against the executed agreement, never by undoing its formation, so the record only grows.

An offeror can supersede an outstanding offer by filing a replacement whose binding names it. If the counterparty accepts the earlier offer before it expires, that offer binds, as a firm offer should.

### Unilateral instruments

Each signature row has one signer and its own binding, so the table also holds instruments executed by one party: a representations-and-warranties template written for a role, a posting, a notice of termination, a consent, an attestation. The mutual contract is the special case in which every required role has signed the same pair.

Renewal is a fresh binding under the same pair: a new `BindingCid` with a new date, which the primary key admits.

## Ending an Agreement

An agreement ends in one of three ways:

1. **Natural expiry** is an agreement parameter: an end date in `ParamsCid`. It can be decided from the signed pair alone and cannot be disputed on ordering.
2. **Termination by notice** under the agreement's own terms is a unilateral instrument whose effect is determined by the agreement it names. As with a posting, the instrument asserts and the agreement interprets.
3. **Termination conditioned on observable state.** A MyCHIPs tally closes only when its balance reaches zero, and a health consent may require records to be destroyed.

In the third case the condition is app state, not contract state. The contract layer records "notice filed, effect per terms", and the sApp computes whether the agreement is in force. Once the condition is met, the closing party files a **Certificate of Closure**, which gives the chain of acts a verifiable final record.

Revoking a unilateral instrument is separate. No counterparty agreement exists to interpret the notice, so the instrument itself declares whether it can be revoked.

**In-force status is per clause, not one boolean per agreement.** Confidentiality, data destruction, dispute resolution and unsatisfied balances survive termination by design, and the instrument declares which sections survive.

## Effective Agreement

For a given instrument, the agreement in force is the latest pair that has not expired, has not been terminated, and has been signed by every role the instrument requires. It includes the postings in force under it and any surviving clauses of superseded or terminated predecessors.

The required-signer policy comes from the instrument, not from a global rule. "All current members" is right for a small mutual agreement and wrong for a chat whose terms of use are executed once by an Operator and accepted individually by each joiner.

In v1 the app computes the effective agreement. Making it a machine-checkable view over `Signature` waits on the instrument declaration being machine-readable.

## Roles

Legal roles are never derived from the membership tables. A role is declared by the instrument and bound in the signer's binding, and whether its holder also holds a `Manager` row is unrelated.

The shipped schema requires this. An open strand has no member or manager rows (the `OnlyClosed` constraints in `schemas/strand.qsql`), and on a closed strand manager rows change hands and can all be removed ([Who may administer a closed strand](../strands/membership.md#who-may-administer-a-closed-strand)). Mapping a legal role such as "Operator" onto `Manager` would give control of a strand's terms of use to whoever holds a manager row, and would lose the role on an open strand.

Role succession is therefore explicit: the instrument declares a role transferable, and the transfer is a signed instrument executed by the current holder.

## sApp Integration

The machine contract and the human contract would be linked at the schema: the signed sApp schema would declare which instruments it requires or permits, as a set of template CIDs or a publisher key. A chat sApp could then require its terms of use, with its own constraints making writes depend on `Signature` rows for those templates. This adds little to the check of the signed sApp schema that a node performs when it starts a strand.

State that belongs to one party, such as a read position, is covered by shipped guidance: [Party-private app state](../schema-guide.md#party-private-app-state).

## Self-Contained Storage: `Strand.Document`

The strand would carry its own legal text:

```sql
	table Document (
		Cid text primary key,
		Body text,  -- the Stroc document (or params/binding object) as canonical DAG-JSON
		constraint InsertOnly check on update, delete (false),
	);
```

At founding, the bootstrap writer would insert the full instrument tree (the wrapper and every document it includes, transitively) and the parameter object. Every member's nodes then sync the complete agreement with the strand, so nothing outside the strand is needed after joining.

**Inserts must be restricted.** Nothing in the sketch stops a member from filling the table with junk on a closed strand, or anyone from doing so on an open one. The insert must be in the same transaction as a `Signature` that references the document, or at least carry a member signature over the CID.

**Where verification runs.** A check of the form `Cid = cid(Body)` needs a CID function the engine does not have. Until it does, the app verifies: the inserting node once, on insert, and any other reader on first read, caching the result by CID. Tampering stays detectable because the CID is the identity.

### Pre-join availability

A closed strand restricts reads to members, but a joiner must read the instrument before signing. The invitation would carry the agreement pair, two CIDs, which fit in a QR code or link. The joiner resolves the documents from these sources in order:

1. **Its local registry cache.** Standard sections are usually present.
2. **The inviter.** A new document-fetch protocol (`/sereus/doc/1.0.0`) modelled on the shipped control-network protocols: length-prefixed JSON frames, a request naming a CID, a response carrying the document bundle. The formation exchange can also carry the bundle in a protocol frame.
3. **A public document-library strand.** An open strand whose sApp is only the `Document` table. It reuses the same fetch protocol and verification, and does not depend on IPFS, which Sereus does not run.

The joiner verifies every source's bytes by hash, so no source needs to be trusted. Stroc's HTTP resolver can add a publisher's web server as a further source on the same terms.

**The pre-join receipt.** Because the invitation carries the pair, the breakdown runs before a party commits to joining. The joiner's consent signature (`FormationUsage.PeerSig`) serves as a receipt of having been shown the terms only if the joiner copies the pair into a field of its own disclosure. The shipped consent digest covers `(Token, UsageStampId, PeerKey, Disclosure)`, where `Disclosure` is the joiner's own text, so without that copy the signature covers nothing about the contract.

The `FormationUsage` row is written to the control database of the party that answers the formation. It is that party's evidence of disclosure, and is distinct from executing the terms, which only a `Signature` row does.

## The Registry: `KnownDocument`

A party's review memory would live in its control database, so approvals follow the user across devices:

```sql
	table KnownDocument (
		Cid text primary key,
		-- 'approved' | 'rejected' | 'seen' (extensible)
		Verdict text,
		-- root CID of the composition under which the verdict was given (null = standalone)
		ContextCid text null,
		Label text null,      -- user's own note
		DecidedAt datetime,
		StampId text,         -- one-off marker, owner-signed add/remove per control conventions
	);
```

Rows are added and removed under an owner signature and never updated, with a `StampId` retired through `Revocation`, like the other owner-signed control tables ([Stamps and tombstones](../cadre/control-schema.md#stamps-and-tombstones)). The registry is flat: one row per CID at any granularity. Tree structure is recovered by resolving the composition at review time.

`ContextCid` strengthens the breakdown's hints: "approved under this same parent before" is a stronger signal than "approved this text somewhere once". A segment approved standalone (`ContextCid` null) matches anywhere.

**A rejection must not be silently overwritten.** Last-writer-wins on the `Cid` primary key is wrong for the verdict that matters for safety: a later `approved` row from another device would replace a `rejected` one. Either the registry keeps verdict history, or it refuses to overwrite a rejection without the user's explicit override.

## The Breakdown

When a party is presented with an instrument, at joining or later, the app does the following:

1. **Resolve** the instrument tree from `ContractCid` through the sources under [Pre-join availability](#pre-join-availability), verifying the hash of every node. Resolve `ParamsCid` the same way.
2. **Classify** each node against the registry into one of four classes.
3. **Render** an outline of the whole composition with a count per class, the parameters as a data table, and the new text expanded.
4. **On acceptance,** add the wrapper CID and any newly approved segment CIDs to the registry, each with `ContextCid` set to the wrapper. Acceptance permits joining; executing the instrument is the separate `Signature` row.
5. **Apply the party's policy.** A party may choose to accept automatically when every segment is `approved` and the parameters pass a filter the party defines. This makes joining a public strand built from standard text quick. It only makes sense when signing is cheap, which is why key class is declared per instrument.

The classes are:

- **approved:** an exact CID match. Rendered collapsed, with a marker when `ContextCid` also matches the parent.
- **modified:** the document's `replaces` names a CID the party has approved, or, as a fallback heuristic, a sibling's section id or title matches an approved document. Rendered as a difference against the approved version.
- **rejected:** explicitly rejected before. Shown prominently.
- **novel:** no registry row. It must be read.

**What a match means.** Every interface that shows the registry must say that a match means "you have read this text before", never "this text is safe in any context", because a clause's meaning depends on the clauses around it. The legal act is always the signature over the whole act; segment approval is a review aid.

### Clause modularity

A clause needs no new concept: it is a small Stroc document included by reference. Only a whole document has a CID, so recognition at clause level requires authors to put clauses in their own documents, which the breakdown rewards.

Two properties of Stroc limit how far this goes:

- **A clause cannot refer to a sibling or a parent.** A Stroc reference may point only within its own document and the documents that document includes. A library clause therefore refers to anything outside itself by a defined term.
- **Defined terms have no carrier.** A library needs a convention in which a template declares the defined terms and library clauses use them without owning them.

## Supersession

"This contract replaces that one" exists at two layers, which are kept apart:

1. **Authorial lineage, in the document.** Stroc's `replaces` field is the author's assertion that a document supersedes the listed versions. It gives the breakdown a deterministic version to compare against, where a title match is only a heuristic. Anyone can publish a document that claims to replace anything, so the registry uses the claim for comparison and lineage display, never as inherited approval.
2. **Executed supersession, in the strand.** A signer's binding names the act this one supersedes, because that is the signer's claim about its own act and not a fact about the agreement. Replacement documents are inserted into `Document`, and signers execute the new pair. The chain of executed acts can then be followed and verified from strand data alone. The two layers should normally agree, and the breakdown reports a mismatch.

Amendment needs no further machinery: it is a replacement agreement plus fresh signatures. The `Header` pair is never rewritten; the [effective agreement](#effective-agreement) is computed. Postings absorb the routine changes that would otherwise force a round of amendment.

## Rendering an Executed Agreement

A party needs the artifact it would keep or take to court. The canonical rendering of an executed agreement contains:

- the instrument text, fully resolved, with each section's CID;
- the agreement parameter table;
- each signer's binding, including its identity bundle and role;
- the postings in force, with their dates;
- the strand id, every CID, and every signature.

Any party must be able to produce it offline from `Document` and `Signature` rows alone, which is why the strand carries its own text. Stroc's renderer lays out the composed document with a supplied data object and places blocks the app supplies, which is where bindings, postings and signatures would go.

## Identity Bundles

A binding's identity bundle is what makes an agreement enforceable against a person instead of a key. It is a canonical DAG-JSON object that starts from the fields of the certificate MyCHIPs embedded in signed tally data: name, ID type and ID, contact or agent, public key, and optionally a birth record.

The bundle is placed in the binding, where it is immutable. Contact endpoints that change go in a Contact posting, not in the bundle.

`StrandFormationDisclosure.identityBundle`, an untyped field of the shipped disclosure, would carry the same object during formation.

## Template Authoring Conventions

Nothing checks these v1 authoring rules by machine until the instrument declaration is validated.

- **Declare every value the prose depends on.** A term's text refers to its value through a declared parameter, whether an agreement parameter or a posting value.
- **Declare a default for every value that has a fallback.** A missing value takes the declared default; one with no default is a validation error at review time, which Stroc's data check reports. The same rule covers a missing or stale posting.
- **Link translations.** Without a `translates` field beside `replaces`, treated as advisory in the same way ([Stroc work](#stroc-work)), a party that approved the English Ethics clause sees its Spanish rendering, and the multilingual wrapper, as novel.

## Hash Canonicalization

There is one encoding everywhere, the one the Stroc specification prescribes: CIDv1, DAG-JSON codec (0x0129), SHA-256, lowercase base32, so every CID begins `baguqeera`. Database columns and wire frames store that string. Parsers accept any multibase prefix and store the canonical form only.

Inside a Stroc document, `source` and `replaces` are DAG-JSON links (`{"/": "baguqeera…"}`). Inside this design's own objects, the agreement parameters and the bindings, a CID is a string. The two forms hash differently, and the string form is what the SQL columns and signature digests carry.

## Prerequisites

### Per-party strand identity

The design depends on each party having its own identity in a strand. A closed strand provides it: the party's membership key, whose public half is its `Member` row ([Closed-strand member key handling](../strands/keys.md#closed-strand-member-key-handling)), so `SignerKey` distinguishes the parties.

Open strands do not. `Member` is closed-only by schema, so signature admissibility as specified here does not work on an open strand. Until an open strand has a signer identity (ticket `feat-open-strand-witness-policy`), its instrument has the meaning of terms of use with unverified countersignatures, and multilateral instruments, which a voting sApp would need, are not supported.

### Stroc work

This design needs the following, none of which Stroc has:

- **`translates` metadata** as hashed content.
- **Structural comparison** of two documents, for the breakdown's "modified" class. Stroc stores one paragraph string per section, so a sentence-level comparison is computed by the tool.
- **A defined-terms declaration,** so that library clauses can use terms a template defines ([Clause modularity](#clause-modularity)).
- **A carrier for the instrument declaration** ([Open Questions](#open-questions)).

## Code Placement

- **Stroc, existing:** CID computation, verification and validation in `@stroc/core`; tree resolution and the local document store in `@stroc/compose`; rendering in `@stroc/render` and `@stroc/pdf`.
- **`@serfab/cadre-core`:** the disclosure field, the `/sereus/doc/1.0.0` fetch protocol, the registry and signing writers, and the effective-agreement computation.
- **Reference apps:** the breakdown viewer, registry management and rendering of executed agreements.

## Open Questions

1. **Which layer owns the tables.** Stroc's `docs/Sereus.md` assigns signatures, offers, expiry and in-force status to the app, and has Sereus only carry a document reference in a strand invitation. Under that division each sApp's schema would declare `Signature`, `SigningKey` and `Document`, and `KnownDocument` would need a home outside the control schema. This document places them in the Sereus schemas. The two documents disagree, and the placement must be settled before any schema change.
2. **Carrier for the instrument declaration.** Stroc rejects unknown document fields and has set aside a declaration inside the document, on the ground that who signs is the app's concern. The declaration could be a separate content-addressed object named by the agreement parameters, or part of the sApp schema's list of required instruments.
3. **Agreement parameters and Stroc's data object.** Stroc renders a document with a data object that maps parameter paths to plain-text values. `ParamsCid` names a richer object (role definitions, signer policy, posting rules). How the rendered values are derived from the parameter object and the bindings is unspecified.
4. **Stale or missing postings.** Whether the agreement fails closed until a required posting exists, or falls back to the template defaults. The choice matters for a party that goes offline, and it interacts with the ratchet.
5. **Role transfer.** Whether transferring a transferable role requires the incoming holder's countersignature. It matters most where the outgoing holder has left, as with a chat's Operator.
6. **Posting timing.** "Which posting was in force on date D" needs an order the strand does not have. `SignedAt` plus the relying party's own replication record is evidence for a dispute, not proof, and no part of this design should imply that the chain of acts is authoritative on timing.
7. **Signing-key retirement.** `SigningKey` is insert-only so that past signatures stay verifiable, so a compromised key cannot be retired. A tombstone carrying an effective date, which invalidates later signatures and preserves earlier ones, is the likely form and is unspecified.
8. **Key lineage.** When a party replaces its member key, nothing links the new key to the signatures under the old one. Whether the effective-agreement computation counts the party as having signed, or requires it to execute again, is undecided.
9. **Who may file a `party`-class signature.** Whether inserting such a row also requires a signature by a live member key, so that only members can file, in addition to the `SigningKey` registration.
10. **Capabilities of a member that has not signed.** Whether the period between admission and signing is bounded, and what such a member may write, are policy the instrument decides. A default convention should be chosen before v1.
11. **Machine-checkable required-signer policy.** When the [effective agreement](#effective-agreement) becomes a view over `Signature`.
12. **Third-party signers.** A witness, guarantor or notary is not a member and so cannot sign. Either the limitation is accepted, or the instrument names roles that verify against a key stated in the binding instead of against the member roster.
13. **An empty registry on first use.** A new party's first breakdown is entirely novel. A list of well-known CIDs shipped with the app, or trust in a publisher (Stroc can confirm that a document's `author` domain lists it), would fill the registry. Neither is designed.
14. **Engine `cid()` function.** It would move `Document` verification from the app into a check constraint.
15. **Registry size.** `KnownDocument` grows with review history, which is acceptable for one person's history.
