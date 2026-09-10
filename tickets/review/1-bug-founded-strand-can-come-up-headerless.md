description: Review the fix that records which machine created a shared network on the network's own control record, so a restarted app re-runs its one-time founding setup instead of silently rejoining as an ordinary participant and leaving the network permanently missing its founding records.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/use-cadre.ts, docs/architecture.md
----

# Review: persist founder-ness on the `Strand` control row; honor founder requests on tracked instances

## What was implemented

The bug: founding a strand = publish its control row + run a one-time bootstrap that
writes `Strand.Header` (closed strands also seat the founding `Member`/`Manager`). Nothing
recorded WHICH machine published a row, so after a restart (or a watcher-poll race) the
strand relaunched as an ordinary joiner, the bootstrap never ran, and the strand stayed up
permanently headerless while `foundStrand` reported success.

Three-part fix, exactly per the implement ticket's design:

1. **Representation** — `Strand.FounderOwnerKey text null` in `schemas/control.qsql`
   (mirrored byte-identically in `packages/cadre-core/src/control-schema.ts`; the drift
   spec passes). The owner-signed insert branch pins it by equality to the verified
   signer (`new.FounderOwnerKey = context.OwnerKey`, following the `CadrePeer.VouchOwner`
   precedent — NOT added to the signed digest); the consent branch requires it null and
   carries the tripwire NOTE about consent-formed strands (see gaps below). `NoUpdate`
   already forbade rewriting it. No migration — repo has no backwards-compat rule.

2. **Derivation** — `CadreNode.launchStrand` derives `founder` when the caller passes no
   flag: this machine founds iff the row's `FounderOwnerKey` equals its own owner key
   (`isSelfFoundedRow`, pure key derivation, no I/O). An explicit flag always wins
   (formation/responder flows). `foundStrand` no longer hardcodes `founder: true` — it
   derives from the resolved row, logs when it resolves to attaching (a sibling won the
   race), and surfaces the outcome as new `FoundStrandResult.founded` (additive field).
   `strandRowMismatches` deliberately EXCLUDES the column (provenance, not content), so
   two machines racing to found one id still resolve benignly.

3. **Seam** — `launchStrand`'s tracked-instance early return no longer drops a founder
   request: it calls new `StrandInstanceManager.foundExistingStrand(strandId)`, which
   flips the retained launch config (so every later quiesce→resume rebuild founds) and
   runs the idempotent bootstrap on the live database via new public
   `StrandDatabase.ensureFounderBootstrap()`. A quiesced instance returns
   `'needs-resume'` and `launchStrand` wakes it through `CadreNode.wakeStrand` (the
   hibernation manager's coalesced wake path), so the bootstrap runs before `foundStrand`
   resolves. `StrandInstanceManager.startStrand`'s own early return keeps its shape but
   now LOGS when it would drop a founder flag against a non-founder retained config.

Plumbing: `StrandRow` (types.ts) gained required `FounderOwnerKey: string | null`;
`ControlDatabase.insertStrand` writes it (= the signing owner), `queryStrand`/`queryStrands`
read it back, `redeemInvitation`'s consent-branch insert writes explicit null;
`publishStrand` builds it into the desired row. ~55 `StrandRow` object literals across
cadre-cli / reference-app-rn / reference-app-ns / reference-app-web / integration-tests
were extended with `FounderOwnerKey: null` (pure type sweep — preserves each site's old
behavior exactly, since explicit `founder:` flags win and null derives "joiner").

Docs: `docs/architecture.md` "Known gap" bullet (line ~617) rewritten to describe the new
representation + seam; `foundStrand`/`launchStrand`/`publishStrand`/`addStrand` docs,
`StrandConfig.founder`/`StartStrandConfig.founder` docs, and the RN
`use-cadre.ts` `onDiscovered` NOTE all updated (the RN handler's flagless attach is now
SAFE for its own orphans — behavior unchanged, comment rewritten).

## Validation performed

- The old `KNOWN GAP` characterization test in `publish-strand.spec.ts` flipped as its
  comment demanded: founding an already-attached strand now expects `Header` = 1, and it
  passes. Do not un-flip it.
- New coverage in `publish-strand.spec.ts` (all passing):
  - plain `addStrand` (no flag) on a row this node published → `Header` written (the RN
    restart-orphan shape; also stands in for the watcher race, below);
  - plain `addStrand` on a row with another machine's key → joiner, no `Header`;
  - null `FounderOwnerKey` (consent shape) without a flag → joiner;
  - `foundStrand` adopting a row published by a different machine → attaches,
    `founded: false`, no `Header` (uses a `queryStrand` stub for the foreign row — seating
    one for real needs a second enrolled owner);
  - closed-strand seam variant: attach as joiner first, then found → Header/Member/Manager
    all seated;
  - existing publish/found tests extended to assert `FounderOwnerKey` = the node's owner
    key on returned/stored rows.
- Raw owner-signed `Strand` inserts in three constraint specs
  (`control-authorization-binding`, `control-revocation-replay`, `control-revocation-reap`)
  updated to carry the column (the new equality clause rejects them otherwise) — all pass,
  which also proves the schema constraint has teeth.
- Suites run green: cadre-core full (109 files / 1801 tests, 1 pre-existing skip),
  cadre-cli (232), reference-app-rn (192 + typecheck), reference-app-ns (103),
  reference-app-web (66). Repo-wide `yarn lint` clean. All workspace typechecks pass
  (cadre-host/provider included, against rebuilt cadre-core dist).

## Known gaps / reviewer starting points

- **The quiesced-instance seam path (`'needs-resume'` → `wakeStrand`) has NO test.** The
  live-instance path is covered end-to-end; forcing "founder request arrives while the
  instance is hibernating" needs hibernation-timing scaffolding I did not build. The code
  path is short (flip config → coalesced wake → rebuild founds) but unexercised.
- **The watcher-race arm (poll winning `launchStrand`'s `resolveCohortSeed` window) still
  has no test seam** — its exact timing window is not forcible from a spec. The derivation
  test stands in for it (the poll now launches as founder and bootstraps itself), per the
  implement ticket's explicit allowance.
- **Consent-formed strands keep the orphan gap** (`FounderOwnerKey` null by construction —
  no signature, no trustworthy signer). Recorded as a `NOTE:` tripwire on the consent
  branch in `schemas/control.qsql` (revisit: if consent-formed strands ever hit the
  empty-Header symptom, `FormationUsage.PeerKey` is the candidate derivation source). The
  responder flow keeps passing explicit `founder: true`; the e2e fixture debt stays in
  `tickets/backlog/debt-e2e-formation-host-never-founds-its-strand.md`, untouched.
- **Integration tests were type-swept but NOT executed** (real-network scenarios exceed
  agent runtime — defer to CI). Three scenario assertions that compare discovered/queried
  rows were updated to expect `FounderOwnerKey` (`expect.any(String)` for cross-machine
  reads); if CI shows a strand scenario failing on row shape, look for a `toEqual` on a
  strand row first.
- `StrandDatabase.ensureFounderBootstrap()` mutates its captured `config.founder` to keep
  the object's self-description coherent; `foundExistingStrand` replaces the retained
  manager config with a fresh object rather than mutating the caller's. Worth a look if
  you care about config-object aliasing.
- `FoundStrandResult.founded` is a new required field — external stubs of `foundStrand`
  (there was one, in the RN chat-strand spec) must return it.
