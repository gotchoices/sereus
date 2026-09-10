----
description: Record which machine created a shared network on the network's own control record, so that after a restart the app re-runs its one-time founding setup instead of silently rejoining as an ordinary participant and leaving the network permanently missing its founding records.
files: schemas/control.qsql, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/src/use-cadre.ts, docs/strands.md
difficulty: hard
----

# Persist founder-ness on the `Strand` control row; make `launchStrand` honor a founder request against an already-tracked instance

## The bug being fixed (short form — full analysis lived in the fix ticket)

Founding a strand = publish its `Strand` row to the party's control DB + launch the local
instance with `founder: true`, which runs a one-time bootstrap writing the strand's `Header`
(and, closed strands, the founding `Member`/`Manager`). `CadreNode.foundStrand` does both.
But `launchStrand` (`cadre-node.ts`, the `getInstance` early return) hands back an
already-tracked instance and silently drops the `founder` flag — so if anything launched the
strand first as a joiner, `foundStrand` reports success while the bootstrap never runs, and
the strand stays up with no `Header`. Two ways something launches first:

- **App attaches its own orphan after a restart.** Nothing records which machine published
  the row, so the RN app's `strand:discovered` handler
  (`packages/reference-app-rn/src/use-cadre.ts`, the `onDiscovered` NOTE) deliberately
  attaches — it cannot tell its own orphaned strand from another party's.
- **This node's own `StrandWatcher`.** `foundStrand` publishes before `addStrand`, and
  `launchStrand` awaits `resolveCohortSeed` (a network round) between its tracked-instance
  check and `startStrand`. A watcher poll (default 5 s) landing in that window auto-launches
  the row via `handleStrandAdded` with no `founder` flag.

Root cause: founder-ness is not represented anywhere durable, so nothing after the original
`foundStrand` call can know this machine is the founder.

Repro (verified, passes today as a characterization):
`packages/cadre-core/test/publish-strand.spec.ts` →
`'KNOWN GAP: founding a strand already ATTACHED as a joiner leaves it headerless'`.
When this ticket lands, its `Header`-count expectation flips 0 → 1 (do NOT delete the test —
its comment says exactly this).

## Design

### Representation: `Strand.FounderOwnerKey` on the control row

Add a nullable `FounderOwnerKey text null` column to `table Strand` in
`schemas/control.qsql`, holding the owner public key (base64url ed25519) of the machine that
published the row. This is the machine's owner key — in the reference model owner key ≡ the
key behind the node's PeerId (`ed25519KeyPairFromLibp2p`), and each machine of a party has
its own — so the column identifies the founding *machine*, which is exactly the granularity
the bootstrap needs (only one machine may run it).

Why the control row and not a machine-local store: the knowledge must survive a process
restart, and the control DB is the only durable, always-present store cadre-core owns on
every platform (RN included). It also gives every sibling the same answer, which is what
lets `handleStrandAdded` on the *right* machine auto-launch as founder while siblings
attach. The cost the fix ticket's tradeoffs line worried about (a migration) is void: repo
rule is "no backwards compat yet" — change the schema in place, no migration.

Constraint changes in `Strand.AuthorizedInsert` — follow the `CadrePeer.VouchOwner`
precedent (stored column bound by equality to the verified context, digest unchanged):

- Owner-signed branch: add `and new.FounderOwnerKey = context.OwnerKey`. The signature
  already proves `context.OwnerKey` is a live enrolled owner signing over
  (Id, Type, MemberPrivateKey, StampId); the equality pins the stored column to the actual
  signer, so it cannot be forged. Do NOT add the column to the digest — it would be
  redundant with the equality, and would churn `buildAuthorizationMessage` /
  `insertStrand`'s field-order contract for nothing.
- Consent branch (`FormationUsage` redemption, no signature): add
  `and new.FounderOwnerKey is null`. A consent-seated strand records no founder machine —
  see the residual gap note at the bottom.

`NoUpdate` already forbids rewriting the column after the fact.

### Plumbing the column through

- `StrandRow` (`packages/cadre-core/src/types.ts`) gains `FounderOwnerKey: string | null`.
- `ControlDatabase.insertStrand` inserts it (it already receives `ownerKey`); the strand
  row read path (`queryStrand` / whatever maps rows) returns it. Check the consent-branch
  insert in `redeemInvitation` (it seats a `Strand` row too) inserts explicit null.
- `CadreNode.publishStrand` includes it in the `desired` row it builds.
- `strandRowMismatches` / `requireMatchingStrandRow` (`cadre-node.ts` ~line 190) must
  **exclude** `FounderOwnerKey` from the identical-content comparison, with a comment
  saying why: it is provenance, not content. Two machines of one party racing to found the
  same id must keep resolving as "the winner's row stands" — the loser adopts the row and,
  per the derivation below, correctly comes up as a joiner. Including it would turn that
  benign race into a hard throw.

### Deriving `founder` where it was being guessed

- `CadreNode.launchStrand(strand, sAppConfig, founder?)`: when `founder` is `undefined`,
  derive it: `strand.FounderOwnerKey !== null && strand.FounderOwnerKey ===
  this.getSelfSigningKey()?.publicKeyB64`. (`getSelfSigningKey` is the existing
  non-throwing accessor, ~line 2080; a node with no owner key derives `false`.) An
  explicit `founder` argument still wins — the formation/responder flows pass it
  deliberately and their strands can carry a null column.
- `handleStrandAdded` needs no change beyond this: its `launchStrand(strand, sAppConfig)`
  call now derives founder from the row, which closes the watcher-race arm (the poll that
  used to win the race now launches as founder, so it does the bootstrap itself) AND the
  app-restart arm (RN's plain `addStrand` on a self-published orphan now founds).
- `foundStrand`: replace the hardcoded `founder: true` at ~line 4187 with the derived
  value from the row it resolved (`strandRow.FounderOwnerKey === own owner key`). A fresh
  publish sets the column to this machine's key, so the common path still founds; a
  machine that lost a concurrent founding race to a sibling adopts the sibling's row and
  attaches — which is the *correct* behavior the old hardcoded `true` got wrong (two
  machines bootstrapping the same strand on separate replicas is the double-`Header`
  hazard the RN comment describes). Log clearly when `foundStrand` resolves to attaching
  because another machine's key is on the row. Consider surfacing `founded: boolean` on
  `FoundStrandResult` so callers can tell; if added, keep it additive.

### The seam: stop `launchStrand` dropping a founder request on a tracked instance

Even with derivation, `foundStrand` can still arrive after something else already launched
the instance (the app-attach shape the repro test builds). `launchStrand`'s early return
must stop discarding the resolved `founder`:

- Retained launch config already records how the instance was launched
  (`StrandInstanceManager.launchConfigs`, `StartStrandConfig.founder`) — that is the
  observable "was it founded" bit; no new instance field needed.
- Add a method on `StrandInstanceManager` (e.g. `foundExistingStrand(strandId)` — name
  free) that: no-ops if the retained config already has `founder: true`; otherwise sets it
  `true` in the retained config (so every later quiesce → resume rebuild founds — the
  bootstrap is insert-if-absent, `bootstrapFounderMembership` is idempotent) and runs the
  bootstrap against the live instance now. `StrandDatabase.bootstrapFounder` is private;
  expose a public idempotent entry (e.g. `ensureFounderBootstrap()`), or have the manager
  reach it another clean way. Mind the mutation: `StrandDatabase` captured
  `config.founder` at construction — decide whether the public entry bypasses that field
  or updates it; keep it coherent.
- Quiesced instance (no live `database`): updating the retained config alone would defer
  the bootstrap to an eventual wake, but `foundStrand` promises founding is done when it
  resolves — resume the strand (the manager's own `resumeStrand`) with the updated config
  so the bootstrap actually runs, or document loudly why deferral is acceptable if
  resuming from inside this seam turns out to fight the hibernation manager. Prefer
  actually running it.
- `launchStrand`'s early return then becomes: resolved founder && tracked instance →
  `foundExistingStrand` before returning the instance. Keep the derivation cheap — the
  early return today costs one map lookup and the comment says so; a `getSelfSigningKey`
  call is pure key-derivation (no I/O) so it is fine, but do not add network work there.
- `StrandInstanceManager.startStrand`'s own `instances.has` early return can keep its
  current shape (its callers now resolve founder first), but add a log line when it
  returns an existing instance while `config.founder` is true and the retained config's is
  not — that mismatch should never be silent again.

## Validation

- Flip the KNOWN GAP test's expectation to `Header` count 1 (instance active, bootstrap
  ran via the seam fix). Update its comment from "characterizes a gap" to "guards the
  fix".
- New coverage worth adding in `publish-strand.spec.ts` (or a sibling spec):
  - plain `addStrand` (no flag) on a row this node published → `Header` written
    (derivation arm — this is the RN restart-orphan shape and also stands in for the
    watcher race, whose exact timing window still has no test seam; that stays noted, not
    forced).
  - plain `addStrand` on a row whose `FounderOwnerKey` is another key → no `Header`
    (joiner unchanged).
  - `foundStrand` adopting a row founded by a different owner key → attaches, does not
    bootstrap.
  - closed-strand variant of the seam fix if cheap (bootstrap seats Member/Manager).
- Sweep existing tests for the schema change: anything constructing `StrandRow` literals
  (`reference-app-rn/test/chat-strand.spec.ts` builds `{ Id, MemberPrivateKey, Type }`)
  or asserting on `insertStrand` SQL. `yarn lint` + full `cadre-core` suite; run the RN
  and web package suites that touch strand types. Integration scenarios that pass
  explicit `founder:` flags (`integration-tests/src/harness/strand-join.ts`,
  `strand-membership-*.integration.ts`) should be unaffected — explicit flag wins — but
  read them once to confirm, and remember integration tests may exceed agent runtime
  (defer to CI if so, and say so in the handoff).

## Doc/comment sweep (the gap descriptions come out)

- `docs/strands.md` ~line 617: the "Known gap — founding is only guaranteed when
  `foundStrand` launches the instance" bullet — rewrite to describe the new
  representation + seam behavior.
- `cadre-node.ts`: `foundStrand`'s NOTE (~4157–4167, "filed as backlog debt"),
  `launchStrand`'s doc, `publishStrand`'s doc, `StartStrandConfig.founder` /
  `StrandConfig.founder` docs in `strand-instance-manager.ts` / `types.ts`.
- `packages/reference-app-rn/src/use-cadre.ts` `onDiscovered` NOTE (~175–182): now stale —
  the row DOES record who published it and cadre-core derives founder-ness; the handler's
  attach call is now safe for its own orphans. Behavior of the handler itself need not
  change.
- Leave `packages/reference-app-web/e2e/fixtures/formation-responder.ts` and
  `tickets/backlog/debt-e2e-formation-host-never-founds-its-strand.md` alone — that is the
  consent-formation flow, tracked separately.

## Residual gap to write down, not fix here

A consent-seated strand (`FormationUsage` branch) carries `FounderOwnerKey = null` by
construction — no signature, no trustworthy signer to record. The responder that provisions
such a strand still relies on an explicit `founder: true` at launch, so the
restart-before-founding orphan shape persists for that flow only. Record this as a `NOTE:`
tripwire at the consent branch in `schemas/control.qsql` (revisit condition: if
consent-formed strands ever hit the headerless symptom in practice, the redemption record —
`FormationUsage` names the redeeming peer — is the candidate derivation source).

## TODO

Phase: schema + plumbing
- Add `FounderOwnerKey text null` to `Strand` in `schemas/control.qsql`; bind it in the
  owner-signed branch (`= context.OwnerKey`), null in the consent branch; add the
  consent-branch tripwire NOTE.
- Extend `StrandRow`, `insertStrand`, the strand row read path, `redeemInvitation`'s
  strand insert, `publishStrand`'s desired row; exclude the column from
  `strandRowMismatches` with the provenance comment.

Phase: founder derivation + seam
- Derive `founder` in `launchStrand` when unset (explicit argument wins); replace
  `foundStrand`'s hardcoded `true` with the row-derived value; log the attach-instead
  outcome (consider `FoundStrandResult.founded`).
- Expose an idempotent founder-bootstrap entry on `StrandDatabase`; add
  `StrandInstanceManager.foundExistingStrand` (retained-config update + live bootstrap +
  quiesced-instance handling); call it from `launchStrand`'s early return; add the
  mismatch log in `startStrand`'s early return.

Phase: tests + docs
- Flip the KNOWN GAP expectation to 1 and update its comment; add the derivation-arm and
  wrong-key coverage above; sweep `StrandRow` literals in other packages' tests.
- Doc/comment sweep listed above.
- `yarn lint` + cadre-core suite green; run affected package suites; note anything
  deferred to CI in the review handoff.
