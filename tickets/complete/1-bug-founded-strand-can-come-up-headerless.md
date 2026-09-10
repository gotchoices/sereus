description: Fixed and reviewed: a shared network now records which machine created it, so a restarted app re-runs its one-time founding setup instead of silently rejoining as an ordinary participant and leaving the network permanently missing its founding records.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-rn/src/use-cadre.ts, docs/architecture.md
----

# Founder-ness persisted on the `Strand` control row

## What shipped

Founding a strand is two things: publishing its `Strand` control row, and running a
one-time bootstrap that writes `Strand.Header` (plus the founding `Member`/`Manager` on a
closed strand). Nothing recorded WHICH machine published a row, so after a restart — or
when this node's own strand watcher won a race — the strand relaunched as an ordinary
joiner, the bootstrap never ran, and the strand stayed up permanently headerless while
`foundStrand` reported success.

Three-part fix, landed in `a86257e`:

- **Representation.** `Strand.FounderOwnerKey text null` in `schemas/control.qsql`
  (mirrored byte-identically in `control-schema.ts`). The owner-signed insert branch pins
  it by equality to the verified signer (`new.FounderOwnerKey = context.OwnerKey`), so a
  writer cannot record a founder it is not; the consent branch requires it null, because an
  unsigned insert has no trustworthy signer to record.
- **Derivation.** `CadreNode.launchStrand` derives founder-ness when the caller passes no
  flag: this machine founds iff the row's `FounderOwnerKey` is its own owner key. An
  explicit flag still wins. `foundStrand` derives rather than hardcoding `true`, and
  surfaces the outcome as `FoundStrandResult.founded`.
- **Seam.** A founder request arriving for an already-tracked instance is honored in place
  (`StrandInstanceManager.foundExistingStrand` → `StrandDatabase.ensureFounderBootstrap`)
  instead of being silently dropped, waking a quiesced instance first.

## Review findings

The implement-stage diff was read first, then the handoff. Everything below is CLOSED —
either fixed in this pass or recorded at a code site.

### Fixed in this pass

- **Broken typecheck at HEAD (build break).** `packages/reference-app-web/e2e/fixtures/formation-responder.ts:223`
  builds a `StrandRow` literal and was not swept, so `yarn workspace @serfab/reference-app-web typecheck:e2e`
  failed with `TS2741: Property 'FounderOwnerKey' is missing`. The handoff claimed all
  workspace typechecks passed; that script (a separate `tsconfig.e2e.json`, run by the
  package's `build`) was not among them. Fixed with an explicit `FounderOwnerKey: null`,
  which preserves the fixture's existing joiner-attach behavior rather than silently
  resolving the backlog debt ticket that owns it.
- **Race: a coalesced wake could swallow the bootstrap.** `launchStrand`'s `'needs-resume'`
  path flipped the retained launch config and then called `CadreNode.wakeStrand`. But
  `HibernationManager.beginWake` COALESCES — a wake already in flight had read the
  *pre-flip* config in `resumeStrand` and rebuilt as a joiner, so awaiting it returned with
  no `Header` written and `foundStrand` still resolved `founded: true`. That is the exact
  bug class this ticket exists to close, reachable whenever a founder request lands while
  the strand is hibernating and something else is waking it. Fixed by adding
  `StrandInstanceManager.ensureFounderBootstrap(strandId)` — an unconditional,
  insert-if-absent re-run against the live database, which `launchStrand` now calls after
  the wake. It throws rather than no-ops when the strand is untracked or still quiesced, so
  a missed bootstrap can never be silent again.
- **Test gap: the seam had no direct coverage.** `foundExistingStrand` was exercised only
  end-to-end through `foundStrand`, and the handoff listed the quiesced path as untested.
  Added six tests to `strand-instance-manager-hibernation.spec.ts` (which already mocks the
  heavy runtime): live instance bootstraps and the flip is retained across quiesce→resume;
  already-founder is a cheap no-op; quiesced returns `'needs-resume'` and the resume rebuild
  founds; untracked rejects; and both branches of the new `ensureFounderBootstrap`.
- **Stale premise in a neighbouring comment.** `strand-watcher.ts`'s failed-add handler
  asserts "a failed launch leaves nothing running". That is no longer universally true — a
  founder request that throws against a tracked instance leaves the instance up as a joiner
  while the watcher forgets it and retries under backoff (which is the wanted behavior).
  Comment corrected in place.
- **Misplaced comment.** The `// resolvedFounder (not the raw argument)` note sat above
  `sAppConfig` in `launchStrand`'s `startStrand` literal, several lines from the `founder`
  field it describes. Moved.
- **Doc gap.** `docs/architecture.md` documented the new column thoroughly in the Strand
  Membership Bootstrap section, but the control-table summary table (line 36) — the entry
  point a reader hits first — still described the `Strand` row without it. Added a sentence
  naming the column, its pinning, its null case, and a link onward.

### Recorded as tripwires (not tickets)

- **The derivation assumes one owner key per machine.** Two machines running the same
  identity key would each derive `founder: true` and bootstrap on separate replicas — the
  double-`Header` hazard the derivation exists to prevent. Unreachable today: that
  configuration also gives both machines one PeerId, which breaks control networking well
  before any strand launches. Parked as a `NOTE:` on `CadreNode.isSelfFoundedRow`, with the
  revisit condition (machines sharing an owner key while holding distinct transport
  identities) and the candidate fix (a per-machine discriminator on the row).

### Filed as new tickets

None. Every finding resolved at its own site; nothing needed a root-cause change large
enough to outlive this pass.

### Checked, nothing found

- **Schema authorization.** `Strand.AuthorizedInsert` has exactly two branches, both now
  constrained. Leaving `FounderOwnerKey` out of the signed digest is sound: the equality
  binds it to `context.OwnerKey`, which the signature verification already pins, so the
  column's value is fully determined and cannot be forged or replayed with a different one.
  SQL null semantics do the rest — `null = x` is not true, so the signed branch cannot
  accept a null column, and the consent branch requires one explicitly.
- **Which row the derivation reads.** `requireMatchingStrandRow` returns the LIVE row (not
  the locally-built `desired`), and `adoptPublishedStrand` returns the stored row verbatim —
  so a machine that lost a founding race derives from the winner's key and correctly
  attaches. `strandRowMismatches` excluding the column is right: comparing provenance would
  turn that benign race into a hard throw.
- **Config-object aliasing** (flagged in the handoff as worth a look).
  `StrandDatabase.ensureFounderBootstrap` mutates `this.config.founder`, but that config is
  a fresh object literal built inside `buildStrandRuntime` — not the caller's object and not
  the manager's retained launch config, which `foundExistingStrand` replaces rather than
  mutates. No aliasing hazard.
- **Stale instance handles.** `resumeStrand` mutates the same `StrandInstance` object rather
  than replacing it, so `launchStrand` returning `existing` after a wake hands back a live
  instance.
- **Sweep completeness.** No `StrandRow` literal remains without the column anywhere in
  `packages/`; `cadre-host` and `cadre-provider` never touch the type.
- **Other docs.** `docs/strands.md` and `docs/cadre-host.md` describe strand-layer
  membership and the admin projection respectively; neither enumerates control-row columns,
  so neither needed a change.

## Validation

- `yarn lint` — clean, repo-wide.
- `@serfab/cadre-core` — 109 files / 1807 passed, 1 pre-existing skip.
- `@serfab/cadre-cli` 232, `@serfab/reference-app-rn` 192, `@serfab/reference-app-ns` 103,
  `@serfab/reference-app-web` 66 — all passing.
- Typechecks pass for all eight workspaces, plus `reference-app-web`'s separate
  `typecheck:e2e` (the one that was broken).
- Integration tests are type-checked but not executed — real-network scenarios exceed agent
  runtime, so they are left to CI, as the implement stage also noted. If a strand scenario
  fails there, suspect a `toEqual` on a strand row: several were updated to expect the new
  column.
- The Playwright browser suite was not run; the e2e fixture change is type-only and
  preserves its previous behavior exactly.

## Deliberately left open

- The consent-formed strand orphan gap (`FounderOwnerKey` null by construction) stays, with
  its `NOTE:` tripwire on the consent branch in `schemas/control.qsql`. The responder flow
  keeps passing an explicit `founder: true`.
- `tickets/backlog/debt-e2e-formation-host-never-founds-its-strand.md` gained an arm noting
  that its code fix is now a one-liner (hand `addStrand` the row `publishStrand` returned),
  and that the ticket still owns the Playwright run that change needs.
