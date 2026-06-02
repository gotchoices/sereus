----
description: Implement a real waitForControlSync (query control DBs for convergence instead of sleeping) and make happy-path + multi-party-sync honest — assert real control-network state or mark clearly as connectivity-only, never fabricated state.
prereq: formationinvite-fix-curve-and-wire-consent
files: packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, packages/integration-tests/src/scenarios/multi-party-sync.integration.ts, packages/cadre-core/src/control-database.ts
----

After `formationinvite-fix-curve-and-wire-consent` lands, `TestCadreNetwork.createInvitation`
and `joinStrand` insert real `FormationInvite` / `FormationUsage` / `Strand` rows via
`ControlDatabase` (it explicitly replaces the `test-network.ts:139,166-169` TODOs). Two gaps
remain that that ticket does not touch: `waitForControlSync` is still a `sleep(100)` placeholder
(`test-network.ts:186-189`), and `happy-path.integration.ts` / `multi-party-sync.integration.ts`
still build every membership assertion on the `strand.parties` array the old stub mutated — so
they verify harness bookkeeping, not the system. This ticket closes both, completing the source
ticket's "replace stubs with real implementations, or mark clearly" requirement for the sync
method and the two stubbed scenarios.

## Design finding — cross-party "join" vs intra-cadre consent

The `FormationInvite`/`FormationUsage` consent model is **intra-cadre**: an authority publishes
an invite into its own `control-<partyId>` optimystic network and its own cadre peers redeem it
(`formationinvite-fix-curve-and-wire-consent` "Roles & signing recap"). The happy-path and
multi-party-sync scenarios instead depict **cross-party** joins (Alice's party + Bob's *separate*
party, each with its own control network). Bob cannot redeem an invite that lives only in Alice's
control network. Real cross-party strand formation is the libp2p `StrandSolicitationService` +
`addStrand` path already covered end-to-end by `strand-formation-e2e.integration.ts`.

Consequently, do **not** force happy-path/multi-party-sync to fake a cross-party control-DB join.
Per scenario, choose the honest option:

- **Mark as connectivity-only**: keep the parts that genuinely exercise real code (party/cadre
  bring-up, intra-cadre libp2p connectivity via `waitForCount` on `getConnections()`), rename the
  `it(...)` titles to say what they actually verify, and **delete the fabricated membership
  assertions** (`expect(strand.parties).toHaveLength(...)` / `toContain(...)`), adding a header
  comment pointing real cross-party formation coverage at `strand-formation-e2e.integration.ts`.
- **Or make it real** where it maps cleanly: assert intra-cadre convergence — after
  `createStrand`/`createInvitation`/redemption, query the party's `ControlDatabase`
  (`queryStrands()`, and a new read for `FormationInvite`/`FormationUsage`) and assert the rows
  exist, via `waitForControlSync`.

Prefer marking the cross-party membership assertions connectivity-only (they duplicate
strand-formation-e2e), and add a small real intra-cadre convergence assertion where it adds
signal. The bar: no test may assert on state that only a harness stub produced.

## waitForControlSync

Replace the `sleep(100)` placeholder with a real poll. Signature today is
`(party, table, expectedRows, timeoutMs?)`. Query the party's control database for the row count
in `table` and wait (reuse `waitUntil`/`waitForCount` from `wait-utils.ts`) until it reaches
`expectedRows` or times out. Use a typed read on `ControlDatabase` rather than raw string SQL
where one exists (`queryStrands()` already; add a generic `countRows(table)` or table-specific
reader on `ControlDatabase` if needed — keep it small and single-purpose).

Note the multi-node caveat: the harness builds **one** `ControlDatabase` per party (on the
authority node — `test-party.ts:116-122`); drones are libp2p peers in the same control network
but have no `ControlDatabase` instance. "Convergence across a party's nodes" therefore can only be
checked against the authority DB unless per-node `ControlDatabase` instances are added. Decide:
either (a) scope `waitForControlSync` to the authority DB and document that it asserts the
authoritative view (sufficient for these scenarios), or (b) if a scenario genuinely needs to prove
drone-side convergence, stand up a `ControlDatabase` on a drone node and query it. Do not silently
pretend multi-node convergence is checked when only one DB is consulted — `log()`/comment the
scope.

## Expected behavior

- `waitForControlSync` polls a real control database and only resolves when the expected rows are
  present (or rejects on timeout); the placeholder `sleep` is gone.
- `happy-path` and `multi-party-sync` contain no assertion that depends on stub-mutated state.
  Each surviving assertion either reflects real libp2p connectivity or a real control-DB read, and
  scenario/test titles honestly describe what is exercised.
- The suite stays green, with cross-party strand-formation coverage explicitly delegated (in
  comments) to `strand-formation-e2e.integration.ts`.

## Key references

- `packages/integration-tests/src/harness/test-network.ts:178-190` — `waitForControlSync` placeholder;
  `:130-173` — `createInvitation`/`joinStrand` (wired by the prereq ticket).
- `packages/integration-tests/src/harness/test-party.ts:116-126` — single `ControlDatabase` per party (authority).
- `packages/cadre-core/src/control-database.ts:285-296` — `queryStrands` (typed-read template); `:336-346` — `queryCadrePeers`.
- `packages/integration-tests/src/scenarios/happy-path.integration.ts:86-89,147-149` and
  `multi-party-sync.integration.ts:50-53,97-117,141-149` — fabricated `strand.parties` assertions to remove/replace.
- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` — the real cross-party formation coverage these scenarios should defer to.
- `packages/integration-tests/src/harness/wait-utils.ts` — `waitUntil`/`waitForCount` for the poll.

## TODO

### Phase 1 — real waitForControlSync
- Add a small typed reader on `ControlDatabase` for counting rows in a control table (or reuse
  `queryStrands`); replace the `sleep(100)` in `waitForControlSync` with a `waitUntil` poll
  against it. Document/scope the single-DB (authority) convergence caveat.

### Phase 2 — scenario honesty
- In `happy-path` and `multi-party-sync`, remove every `expect(strand.parties)...` assertion that
  reflects stub state. Mark cross-party membership coverage as deferred to strand-formation-e2e
  (header comment + honest `it` titles), keeping only real connectivity / real control-DB reads.
- Where it adds signal, assert real intra-cadre convergence via `waitForControlSync` /
  `queryStrands()`.

### Phase 3 — validation
- Run `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/sync.log` (stream output) for
  the two touched scenarios; package type-check/build green before handoff. If the prereq's
  wiring shape differs from what this ticket assumed, adapt the assertions to the real wired
  behavior rather than reintroducing fabricated state.
