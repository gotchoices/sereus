# Strand Contracts (Human Agreements)

> **Design-stage.** Nothing in this document is implemented. It records the agreed design for
> attaching human-readable legal agreements to strands, so implementation tickets can be cut
> from it. Companion documents: [`architecture.md`](architecture.md) (strand formation, control
> schema), [`strands.md`](strands.md) (membership/RBAC), and the Stroc workspace (`../stroc`,
> referenced throughout).

## Purpose

A strand already pins its **machine contract**: `Strand.Header` carries `sAppId`,
`sAppSchema`, `sAppSignature`, `Engine`, `EngineVersion` — the rules a joining party's nodes
will enforce. This design adds the missing twin: the **human contract**, the legal text a
party agrees to when joining, bound into the same signatures that admit them.

Two goals:

1. **Binding**: a party's signature provably covers the exact terms in force, the way a
   MyCHIPs tally signature covers the tally contract's hash. Signing is its own act, recorded
   in the strand — **joining a strand and signing its contract are separate events** (see
   [Signing](#signing-separate-from-joining)).
2. **Recognition**: a party keeps a registry of contract documents it has already reviewed, so
   that when considering a new strand it is shown a *breakdown* — which sections are standard
   text it has approved before, which differ from an approved version, and which are novel and
   actually need reading.

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

Stroc ships as `@stroc/core` (CID compute/verify, normalization, validation) plus a Lit-based
editor. Sereus consumes the library; the editor's view mode is the seed for the breakdown UI.

## Core Model: Template + Parameters, Signed as a Pair

Real contracts are parameterized — party identities, credit limits, notice periods. The design
**never materializes** parameters into the text for signing. Instead:

- The **contract template** is a Stroc document (tree). Its prose is role-generic ("the
  Members", "as specified in the Strand Parameters") and identical across every strand that
  adopts it. Stable text is what makes registry recognition work: a materialized document would
  be unique per strand (different names, different amounts) and never match anything.
- The **parameters** are a canonical DAG-JSON object — role bindings, term values — with its
  own CID (`ParamsCid`).
- The **agreement** a party signs is the pair `(ContractCid, ParamsCid)`.

This mirrors MyCHIPs exactly: the tally contract stays generic, the tally *data* binds roles
to parties and carries the credit terms, and the tally signature covers both. Materialization
happens only at render time (screen/PDF export), where the renderer may append a signature
block and parameter table from strand data — presentation, not identity.

Review burden under this model: the template tree is matched against the reviewer's registry
(templates are stable, so matches happen), and the parameters render as a short **data table**,
always shown in full. What a careful joiner actually reads is novel template text plus a table
of names and numbers.

### Placeholder mechanics

- **v1**: role-generic prose only, MyCHIPs style. Zero Stroc changes.
- **vNext**: Stroc gains `<var:credit_limit>` inline markup plus a declared parameter schema
  (name/type/description) in the template. Buys inline value rendering, argument validation
  against the declaration, and a "this template takes N parameters" panel in the breakdown.
  Tracked on the Stroc side; nothing in v1 precludes it.

## Anchoring: `Strand.Header`

Two nullable columns on the `Header` singleton in `schemas/strand.qsql`:

```sql
	-- CID of the Stroc contract template governing this strand (null = no human contract)
	ContractCid text,
	-- CID of the canonical DAG-JSON parameter object completing the agreement
	ParamsCid text,
```

`Header` is `InsertOnly`, so the pair it names is immutable with the header. It is the
**offered founding agreement** — what is on the table — not proof anyone executed it;
execution lives in the `Signature` table below. A constraint ties the pair together
(`ParamsCid` null unless `ContractCid` present). Open and closed strands both carry the
columns.

## Signing (Separate from Joining)

Joining a strand and signing its contract are **distinct acts**. Joining (invite consumption,
formation) admits a party's nodes to the network and, on a closed strand, seats its `Member`
row — those flows are untouched by this design. Signing is a first-class event of its own,
recorded in the strand database:

```sql
	table Signature (
		ContractCid text,
		ParamsCid text null,
		SignerKey text,
		-- prior agreement this signing supersedes, null for a first signing
		ReplacesCid text null,
		SignedAt datetime,
		-- ed25519 over ('Strand.Signature', 'v1', ContractCid, ParamsCid,
		--               ReplacesCid, SignerKey, SignedAt)
		Sig text,
		primary key (ContractCid, SignerKey),
		constraint InsertOnly check on update, delete (false),
	);
```

Why the separation:

- **Review can happen in-band.** A party may join, sync the `Document` table, take its time
  over the breakdown, and sign afterwards — instead of the legal act being welded to the
  admission handshake.
- **The signature block is strand data.** Every member's nodes replicate the `Signature` rows,
  so any reader re-verifies who has executed which agreement — the tally-signature-section
  analog, held where the contract itself is held.
- **More than one document, more than one moment.** NDAs, riders, and replacement agreements
  (below) are each their own signing event against the same table; nothing about admission
  needs to change when the strand's paperwork grows.
- **Open strands become signable.** An open strand has no join signature at all, but any
  participant can still file a `Signature` row (see open questions for who counts as a valid
  signer there).

On a closed strand the CHECK verifies `Sig` against an existing `Member.Key` and that the
`ContractCid` names a committed `Document` row. What an admitted-but-unsigned member may *do*
is policy, not schema: the sApp's own constraints can gate writes on
`exists (select 1 from Signature ...)`, and the contract text can state grace terms for the
window between joining and signing.

**Pre-join review still happens.** The formation disclosure (and invite payload) carries the
agreement pair so the breakdown runs *before* a party commits to joining. The joiner's
existing disclosure signature (`FormationUsage.PeerSig` — see [architecture.md → Strand
Formation](architecture.md#strand-formation)) then serves as a re-verifiable **receipt of
having been shown the terms** — deliberately distinct from executing them, which only a
`Signature` row does.

## Self-Contained Storage: `Strand.Document`

The strand carries its own legal text. A new insert-only table in the strand schema:

```sql
	table Document (
		Cid text primary key,
		Body text,  -- the Stroc document (or params object) as canonical DAG-JSON
		constraint InsertOnly check on update, delete (false),
	);
```

At founding, the bootstrap writer inserts the full template tree (wrapper plus every
transitively referenced document) and the parameter object. Every member's nodes then sync the
complete agreement with the strand itself — no dependency on IPFS or any external store after
joining, and any reader can re-verify every row (`Cid` recomputed from `Body`).

Verification placement: a CHECK of the form `Cid = cid(Body)` requires a CID function in the
engine, which Quereus does not have today. Until it does, verification is app-layer on write
and on read — cheap, and tampering is detectable by any reader because the CID is the
identity. An engine-level `cid()` is a nice-to-have, not a blocker.

### Pre-join availability (the bootstrap problem)

A closed strand gates reads on membership, but a joiner must read the contract **before**
signing. The invitation therefore carries the agreement pair (two CIDs — small enough for
QR/link), and the joiner resolves the documents up a trustless ladder:

1. **Local registry cache** — standard sections are usually already on hand (the point of the
   registry).
2. **The inviter** — a document-fetch RPC (`/sereus/doc/1.0.0`, modeled on the existing
   control-stream protocols: length-prefixed JSON frames, CID request → document bundle
   response). The formation path can also inline the bundle in a protocol frame.
3. **Public stores** — IPFS or a public Sereus document node, per the resolution strategy in
   the Stroc spec.

Every hop verifies hashes locally, so no source needs to be trusted.

## The Registry: `KnownDocument`

Per-party review memory lives in the **control database** — replicated across the party's
cadre, so approvals follow the user across devices, like everything else in `CadreControl`:

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
sibling control tables — the machinery exists and the data, while advisory, still merits the
same replay hygiene. The registry is **flat**: one row per CID at any granularity (whole
contract, wrapper, single clause). Tree structure is not stored; it is recovered by resolving
the composition at review time.

`ContextCid` upgrades the breakdown's hints: "approved under this same parent before" is a
stronger signal than "approved this text somewhere once". A segment approved standalone
(`ContextCid` null) matches anywhere.

## The Breakdown (Join-Time Review)

When a party considers joining a strand:

1. **Resolve** the template tree from `ContractCid` via the ladder above; hash-verify every
   node. Resolve `ParamsCid` the same way.
2. **Classify** each node of the tree against the registry:
   - **approved** — exact CID match; render collapsed/green, with a context marker when
     `ContextCid` also matches the parent.
   - **modified** — the document declares it `replaces` a CID the party has approved (see
     [Supersession](#supersession-replaces)), or — fallback heuristic — a sibling `as`-alias
     or title matches an approved document; render a sentence-level diff against the approved
     version. (Stroc's structured paragraphs are what make this diff meaningful — this is the
     payoff.)
   - **rejected** — the party has explicitly rejected this CID before; flag loudly.
   - **novel** — no registry row; must be read.
3. **Render**: outline of the whole composition ("9 sections — 7 previously approved, 1
   modified, 1 new"), parameters as a data table, novel text expanded.
4. **On acceptance**: the registry gains the wrapper CID and any newly approved segment CIDs
   (each with `ContextCid` = the wrapper). Acceptance clears the way to join; **executing**
   the agreement is the separate `Signature` row from [Signing](#signing-separate-from-joining)
   — filed immediately after joining in the common case, later if the party wants more time.
5. **Policy knob**: a party may opt into auto-accepting a join when *every* segment is already
   `approved` and the parameters pass a party-defined filter — low-friction entry to public
   strands built entirely from standard text.

### Clause modularity

A "clause" needs no new concept: it is simply a small Stroc document included by reference.
Addressability stops at the section boundary — text inside one section's paragraph string is
not independently hashable — so clause-level recognition requires authors to factor clauses
into their own documents. The breakdown UI rewards exactly that, so standard clause libraries
are the expected equilibrium (the shared MyCHIPs Ethics document is the existing proof).

**Semantic caveat (belongs in every UI surfacing the registry):** a registry hit means "you
have read this text before", never "this text is safe regardless of context" — a clause's
meaning depends on its siblings (defined terms, cross-references). The legal act is always the
signature over the root pair; segment approval is a review aid, not a legal shortcut.

## Supersession (`replaces`)

"This contract replaces that one" exists at two layers, deliberately kept apart:

1. **Authorial lineage — in the document.** Stroc gains an optional `replaces` metadata field
   (array of CIDs, part of the hashed content): the author's assertion that this document
   supersedes those versions. This is what gives the breakdown a *deterministic* diff target —
   "v3 of the Ethics clause, and you approved v2" — instead of leaning on the title-match
   heuristic. The claim is advisory: anyone can publish a document claiming to replace
   anything, so the registry treats a `replaces` link as a diff hint and lineage display,
   never as inherited approval. (Publisher signatures, vNext, are what would let a trusted
   author's lineage carry more weight.) Requires a small Stroc spec addition.
2. **Executed supersession — in the strand.** A `Signature` row's `ReplacesCid` names the
   agreement that signing supersedes *for that signer*. A replacement agreement's documents
   are inserted into `Document`, and members sign the new pair with `ReplacesCid` pointing at
   the old — the chain of executed agreements is walkable and re-verifiable from strand data
   alone. The two layers should normally agree (the new contract's `replaces` names the old
   `ContractCid`), and the breakdown flags a mismatch.

The registry rows follow along: reviewing a successor shows the party's verdict on the
predecessor plus the structural diff, so re-approval effort is proportional to what actually
changed.

## Hash Canonicalization

One encoding everywhere: **CIDv1, DAG-JSON codec (0x0129), SHA-256, base32-lower** (`bafy…`) —
the IPFS default and what the Stroc spec already prescribes. Database columns and wire frames
store the canonical base32 string. Parsers accept any multibase prefix (free via
`multiformats`) but persist canonical form only. The legacy 43-character base64url raw digests
in `stroc/contracts/*.json` predate the spec's CID section; those documents are recomputed and
republished before anything here ships.

## Amendment Pathway (vNext)

Separating signing from joining collapses amendment machinery into what already exists: an
amendment **is** a replacement agreement plus fresh signatures — no dedicated
`Amendment`/`Acceptance` tables.

- `Header` stays `InsertOnly`; its pair is the **founding offer**, never rewritten.
- To amend: insert the successor documents into `Document` (the successor contract's
  `replaces` field naming the current `ContractCid`), then members sign the new
  `(ContractCid, ParamsCid)` with `ReplacesCid` set — ordinary `Signature` rows.
- The **effective agreement** for a signer set is the head of the executed supersession
  chain. *When* a proposed replacement becomes effective for the strand as a whole — all
  current members signed, a quorum, a manager-declared cutover — is acceptance **policy**,
  expressible in the contract text itself; default all-current-members. Making that policy
  machine-checkable (a constraint or view over `Signature`) is the vNext work; the storage
  and signature shapes above need nothing new.
- New joiners are shown and sign the effective head; digests are domain-tagged and versioned
  (`'Strand.Signature', 'v1', …`) so any future shape change is a new tag, not an ambiguity.
- Until the policy layer lands, renegotiation = form a new strand.

## Publisher Trust (vNext)

Stroc's `author` field is an unsigned string. A later layer adds document signatures (Stroc's
own planned signing workflow) plus a party-side registry of trusted publisher keys, giving the
breakdown a middle tier: "unread, but signed by MyCHIPs Foundation". `Verdict` is a text
column so the taxonomy can grow without migration.

## Code Placement

| Piece | Where |
|-------|-------|
| CID compute/verify, tree resolution, structural diff, `replaces` field | `@stroc/core` (external workspace, consumed as a dependency; Stroc's stated destiny is the Sereus family) |
| Formation disclosure structure, `/sereus/doc/1.0.0` fetch RPC, registry writers, signing writer | `@serfab/cadre-core` |
| `KnownDocument` table | `schemas/control.qsql` |
| `Header.ContractCid`/`ParamsCid`, `Document` + `Signature` tables | `schemas/strand.qsql` |
| Breakdown viewer (seeded from Stroc's Lit view mode), registry management UI | reference apps |

## Open Questions

1. **Open-strand signers.** The `Signature` table makes an open strand's contract signable,
   but with no `Member` table there is no key roster to verify signers against — any keypair
   can file a row. Options: accept that (a signature still proves *some* key executed the
   terms, and the sApp decides which keys matter), or introduce a lightweight signer registry
   for open strands. Unresolved; until then an open strand's contract has terms-of-use
   semantics with optional unverified countersignatures.
2. **Unsigned-member capabilities.** The join/sign gap means an admitted member may hold the
   strand's data before executing its contract. Whether that window is bounded (sign within
   N days, manager may evict), and what the sApp lets an unsigned member write, are policy
   decisions — the doc's stance is schema-supports, contract-text-decides, but a default
   convention is worth picking before v1 ships.
3. **Effective-agreement policy.** Which supersession-chain head governs when signatures are
   partial (see Amendment Pathway) — the main vNext design item.
4. **Params schema validation.** Until the `<var:>` declaration lands, nothing machine-checks
   that a params object supplies what the template's prose expects — review is the check.
5. **Engine `cid()` function.** Would move `Document` verification from app layer into a CHECK;
   depends on Quereus function surface.
6. **Registry scale.** `KnownDocument` grows monotonically with review history; fine at
   personal scale, same "bounded by something other than forever" note as other append-only
   control tables.
