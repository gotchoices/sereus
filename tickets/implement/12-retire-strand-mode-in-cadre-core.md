----
description: A workspace started by a lone device currently runs on a private, local-only storage path and only switches to the normal shared one if the device happens to sleep and wake. Delete the private path so every workspace uses the normal one from the start.
prereq: strand-network-transactor-solo-parity
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-writer.ts, docs/architecture.md, docs/STATUS.md
difficulty: hard
----

# Retire `StrandMode` — one transactor for every strand

Second of three (`strand-network-transactor-solo-parity` proved the ground; then
`drop-strand-mode-option-from-sql-plugin` cleans the SQL package's API). This ticket removes the
choice from `cadre-core` and from the public `@serfab/cadre-core` API.

## Why

Today `StrandMode` (`types.ts:646`) is `'bootstrap' | 'networked'`, and
`selectStrandMode` (`strand-cohort.ts:75`) resolves it:

```ts
return explicitMode ?? (hasOtherPeers ? 'networked' : 'bootstrap');
```

`'bootstrap'` selects the Optimystic plugin's **local** transactor, so a strand founded by a lone
device reads and writes entirely inside the process with the peer-to-peer layer bypassed rather than
merely idle. Three reasons that is wrong:

- **It is the wrong layer.** "A device alone serves itself" is a property of the storage engine, not
  of Cadre. The control database has never had an equivalent mode and works solo through the network
  transactor. Keeping a second, application-level answer means two things to keep correct — and the
  asymmetry reads to an outside integrator as evidence the *control* database is missing something
  (it is not; that request should be declined, not implemented).
- **The switch-over is not driven by anything reliable.** The mode is resolved at exactly two sites:
  launch (`cadre-node.ts:3501`) and resume from hibernation (`cadre-node.ts:3011`). A strand founded
  alone and left running therefore stays local **after peers join** — nothing relaunches it on cohort
  growth, and a node that disables hibernation (the NativeScript reference app does) never
  re-resolves at all. Block backfill is gated the same way (`strand-instance-manager.ts:375` runs it
  only when the mode is `networked`), so the peers do not get the blocks by that route either. This
  is read from the code, not observed in the field; after this change the question is moot, which is
  why no archaeology is asked for here.
- **It costs public API for no capability.** `StrandMode`, `StrandConfig.mode`,
  `StrandInstance.mode`, `StartStrandConfig.mode` and `ResumeStrandOverrides.mode` exist only to
  carry this choice. `instance.mode` is *written* on every runtime build and **never read** anywhere
  in `src` — confirmed by grep, and no consumer package serializes it (`cadre-host`'s strand
  service and `cadre-cli`'s admin server do not mention it).

## Do not start until the prereq's numbers exist

`strand-network-transactor-solo-parity` produces (a) a before/after solo latency and
storage-operation table, (b) a passing local→network handover spec, (c) a passing membership
constraint parity spec. Read its handoff first. If it reported a failure and filed a `fix/` ticket,
**stop and re-file this ticket as blocked on that slug** rather than shipping the removal.

## The removal, site by site

**`types.ts`** — delete `StrandMode` (the type and its long doc comment, `:633-646`),
`StrandInstance.mode` (`:549-555`), `StrandConfig.mode` (`:656-662`). `StrandMode` is public via
`export * from './types.js'`; this is a deliberate breaking change (the repo carries no backwards
compatibility yet).

**`strand-cohort.ts`** — delete `selectStrandMode` (`:69-77`) and the now-unused `StrandMode`
import. `hasOtherPeers` existed only to feed it: drop it from `CohortSeed` (`:19-24`) and from
`CohortMembers` / `deriveCohortMembers` (`:31-36`, `:51-67`). With one field left, collapse
`CohortSeed` entirely — have `resolveCohortSeed` return `string[]` (the bootstrap addresses) and
delete the interface. `strand-cohort.ts` is **not** re-exported from `src/index.ts`, so none of this
is public API. Keep the module's doc comments about why `CadrePeer.Multiaddr` must never seed the
strand mesh — that reasoning is unrelated and load-bearing.

**`strand-database.ts`** — delete `StrandDatabaseConfig.mode` (`:24-29`) and the local resolution at
`:94`. Also delete `StrandDatabaseConfig.rawStorage` (`:30-37`) and stop passing `storage` to
`connectToStrand` (`:113`): the plugin only consumes `storage` to build the local transactor's
`rawStorageFactory` or to create a node it was not given, and `cadre-core` always injects the node.
Rewrite the block comment at `:100-107` accordingly. (The plugin keeps its `storage` option — the
browser entry point needs it.)

**`strand-instance-manager.ts`** — delete `StartStrandConfig.mode` (`:40-45`),
`ResumeStrandOverrides.mode` (`:85-90`), the seed assignment at `:247`, the resolution at `:283`,
`instance.mode = mode` (`:342`), the `mode`/`rawStorage` arguments to `StrandDatabase` (`:353-366`),
and the override merge at `:490`. Update the `ResumeStrandOverrides` doc (`:80-84`) — the cohort seed
is now the only volatile input.

**Backfill gate (`strand-instance-manager.ts:375`) — decide deliberately, do not default.** The
condition becomes `strandStorage && config.backfill?.enabled !== false`: peer-join block catch-up is
armed for **every** strand that has per-strand storage. That is right, and say why in the comment:
`StrandBackfill` only does work when the strand's libp2p node reports a peer connection, so on a
device that is genuinely alone it is inert, and arming it at launch is exactly what removes the
"founded alone, never replicates" hole this ticket is closing. The cost is one `StrandBackfill`
object and one connection listener per running strand.

**`cadre-node.ts`** — `resumeStrandRuntime` (`:3003-3016`) passes only the seed;
`launchStrand` (`:3464-3522`) loses its `explicitMode` parameter and the `mode` argument to
`startStrand`; `resolveCohortSeed` (`:3549-3587`) returns the address list. Update the doc comments
that describe mode resolution (`:2986-2988`, `:2995-3002`, `:3449-3453`, `:3524-3535`) and both
`addStrand` / `handleStrandAdded` call sites of `launchStrand`. The `NOTE:` at `:3553-3563` about the
unbounded `queryCadrePeers()` read stays — it is about the control read, not the mode — but its last
clause ("or degrades to `hasOtherPeers: false`") must be rewritten now that the flag is gone.

**`strand-membership-writer.ts:1378-1390`** — the prose credits "the optimystic bootstrap-mode
transactor" with evaluating deferred `CHECK` constraints on `DELETE`. That attribution is a
misnomer: enforcement is Quereus plus the Optimystic vtab session, and the prereq ticket's parity
spec proves it holds on the network transactor. Reword to name the mechanism, citing that spec. Same
sentence, same misnomer, at `docs/architecture.md:670`.

## Call sites and fixtures to update

Unit tests (`packages/cadre-core/test/`): `cadre-node.spec.ts` (~14 `mode:` fixture fields plus the
resume-overrides assertion at `:483`), `cadre-node-strand-seed.spec.ts` (`hasOtherPeers` assertions
at `:106`, `:118`, `:142`, `:153`, `:165`, `:182`, `:222` — the seed is now an address list; keep
each test's real subject, which is *which* addresses come back), `strand-cohort.spec.ts` (delete the
`selectStrandMode` describe at `:61-70`; keep `deriveCohortMembers`),
`control-database-solo-warm-start.spec.ts` (`:230`, `:274`, `:309`, `:353`, `:377` and the header
paragraph at `:36-41` — this suite's whole point is that solo/stale-cohort launches do not hang, and
after this change **all six cases are the same transactor**, which is worth stating rather than
deleting), `strand-instance-manager.spec.ts` (`:118`, `:243`, `:260`, `:265`, `:282`),
`strand-instance-manager-hibernation.spec.ts` (`:114`, `:157`, `:169`, `:221`, `:226`, `:243`),
`strand-instance-manager-cluster-size.spec.ts` (`:78`, `:101`), `strand-founder-bootstrap.spec.ts`
(`:37`), `hibernation-manager.spec.ts` (`:25`), `push-fanout.spec.ts` (`:12`),
`strand-wake-protocol.spec.ts` (`:28`), `types.spec.ts` (`:103`, `:124`), and
`strand-solo-write-budget.spec.ts` — **delete its baseline (`bootstrap`) arm** and keep the
networked arm with the committed budgets.

Integration scenarios (`packages/integration-tests/src/scenarios/`): drop the now-invalid `mode`
argument in `websocket-chat.integration.ts` (`:121`, `:124`), `convergence-stress.integration.ts`
(`:201`, `:204`), `multi-party-workflows.integration.ts` (`:136`, `:139`),
`strand-membership-closed-strand-e2e.integration.ts` (`:446`),
`strand-unpublish-sibling-convergence.integration.ts` (`:142` plus the recipe note at `:25-28`,
which explains a deliberate `bootstrap` choice that no longer exists — the scenario's subject is the
control-plane watcher and stays valid), and `strand-addr-seed-convergence.integration.ts` (comments
at `:24`, `:183`).

`rbac-signed-write.integration.ts:170-206` needs care. It currently explains that cross-node
replication is **expected to be false** because the inferred mode is `bootstrap`, and logs the
observation instead of asserting it. Both nodes' strand libp2p nodes *are* dialed together at
`:137`, so after this change replication becomes plausible. **Keep it an observation, not a gating
assertion** — a two-machine strand's read-repair corroboration floor is a known separate exposure
(`backlog/debt-read-repair-single-voter-corroboration`), and turning an RBAC test into a replication
test would buy flakiness for no new coverage. Rewrite the comment to say replication may now be
observed either way and why it is still not asserted, and drop the `aliceStrand.mode` /
`bobStrand.mode` interpolation from the log line at `:203`.

`packages/reference-app-rn/test/chat-strand.spec.ts:16` — drop the `mode` field. No app source
passes `mode` to `addStrand` (checked across `reference-app-ns`, `reference-app-rn`,
`reference-app-web`, `cadre-cli`, `cadre-host`, `cadre-provider`), so app code needs no change.

## Docs

- `docs/architecture.md` — delete the "Strand Mode: Bootstrap vs Networked" section (`:498-509`,
  heading, table and both following paragraphs). Replace it with a short statement that a strand
  always runs on the network transactor and that a device alone is a situation the storage engine
  handles (self-coordination, no cohort consult at a cohort of one), pointing at the solo coverage
  as the evidence. Fix the "Asymmetric bootstrap" bullet at `:522` — the first node up runs the
  strand solo with an empty seed, but not "in `bootstrap` mode". Fix the transactor misnomer at
  `:670`.
- `docs/STATUS.md:1005-1015` — the `control-database-solo-warm-start` entry describes mode flipping
  both ways; rewrite for one transactor, and catalogue the specs the prereq ticket added.
- `docs/strands.md` — grep before editing; the current text was checked and does not describe the
  modes, so it may need nothing.

## Edge cases & interactions

- **Warm restart across the change is the highest-risk path** and is covered by the prereq's
  `strand-transactor-handover.spec.ts`: every strand founded solo on a shipped build has
  local-transactor-written blocks on disk. Re-run that spec here as part of validation and say so in
  the handoff — it is this ticket's data-safety evidence, not the previous ticket's.
- **Founder membership bootstrap.** `StrandDatabase` writes the founding `Header` / `Member` /
  `Manager` rows straight after schema apply (`strand-database.ts:123-149`) — a solo write by
  definition. Already proven on the network transactor by
  `control-database-solo-warm-start.spec.ts`'s closed-strand case (`:286-324`), which founds a
  closed strand as the last member standing under `networked` with an empty seed and reads the
  founding `Member` back. That case is the existing proof; do not remove it.
- **Open vs closed strands.** Closed strands carry a `MemberPrivateKey` and a founding
  `Member`+`Manager`; open strands get a `Header` only. Transactor selection never branched on this,
  and after the change there is no branch at all — but the warm-start suite covers both shapes, so
  keep both.
- **Backfill now arms on every stored strand.** Watch for hibernation specs that assert on the
  `backfills` map or on listener counts, and for `releaseRuntime` (`:414-432`) stopping the backfill
  before the database closes — that order is already correct and must stay.
- **Launch failure cleanup.** `startStrand`'s catch (`:258-269`) drops both the instance and the
  retained launch config so the id can be relaunched. The retained config simply no longer carries
  `mode`; the invariant ("`launchConfigs` has an entry iff `instances` does") is untouched.
- **Resume path.** `resumeStrand` still merges overrides into the retained config so a later resume
  reuses the freshest seed. Confirm — by reading `handleStrandWake`, `handleStrandCheckIn` and
  `serviceWake` — that nothing triggered work off a *mode change*; grep already shows `instance.mode`
  is never read in `src`, so the expected answer is nothing.
- **Three reference apps launch strands over three storage backends** (web browser storage, React
  Native LevelDB, NativeScript SQLite). None passes `mode`, so none needs a source change — but the
  transactor they get does change. `packages/reference-app-ns/src/solo-smoke.ts` is the only
  on-device solo exercise of this path in the repo and it requires a device or emulator, so it is
  **not agent-runnable**: skip it inside this ticket and state the deferral explicitly in the
  handoff so a human runs it before release. Do the same for `yarn smoke:published` if it is not
  runnable in the sandbox.
- **The `strandFilter.mode` and `admission.mode` fields are unrelated** (`strand-member-registry.ts:151`,
  node config). Do not touch them; a careless grep-and-delete on `mode` will.

## Validation

```
packages/cadre-core:          yarn typecheck
packages/cadre-core:          yarn vitest run 2>&1 | tee /tmp/cadre-core.log
packages/quereus-plugin-sereus: yarn typecheck && yarn vitest run 2>&1 | tee /tmp/plugin.log
repo root:                    yarn lint
repo root:                    yarn build   (or per-package typecheck for the app packages)
```

Integration scenarios (`packages/integration-tests`) boot real libp2p nodes; run the ones whose
files this ticket edits if they are runnable in the sandbox, and name any you skipped and why. Do not
paper over a pre-existing failure — follow the `tickets/.pre-existing-known.md` /
`.pre-existing-error.md` procedure.

## TODO

- Read the prereq handoff; confirm the three facts came back proven, with numbers.
- Delete `StrandMode`, `StrandInstance.mode`, `StrandConfig.mode` from `types.ts`.
- Delete `selectStrandMode` and `hasOtherPeers`; collapse `CohortSeed` to a `string[]` return.
- Delete `mode` and `rawStorage` from `StrandDatabaseConfig`; stop passing `storage` to
  `connectToStrand`; rewrite the surrounding comments.
- Delete `mode` from `StartStrandConfig` and `ResumeStrandOverrides` and every resolution site in
  `strand-instance-manager.ts`.
- Re-gate backfill on storage + config only, with the "inert when alone, armed when a peer arrives"
  rationale in the comment.
- Strip mode resolution from `launchStrand`, `resumeStrandRuntime`, `resolveCohortSeed` and their
  doc comments in `cadre-node.ts`.
- Reword the "bootstrap-mode transactor" misnomer in `strand-membership-writer.ts` and
  `docs/architecture.md:670`.
- Update every unit fixture, integration scenario and the RN test spec listed above; delete the
  budget spec's baseline arm.
- Rewrite `docs/architecture.md:498-522` and the `docs/STATUS.md` entry; catalogue the new specs.
- Re-run `strand-transactor-handover.spec.ts` and the solo budget spec; put the post-change numbers
  in the handoff next to the prereq's.
- Handoff: state the deferred on-device NativeScript smoke and any integration scenario not run.
