description: Let an operator turn on Optimystic's change notifications for chosen strands, so an app on another machine can be told a strand changed instead of polling for it (GitHub #28, now possible with Optimystic 1.10.0).
architecture: docs/strands.md
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/cadre-cli/src/config/, packages/integration-tests/src/scenarios/, docs/strands.md, docs/architecture.md, ../optimystic/packages/quereus-plugin-optimystic/README.md (§Reactive Watching, §Network change notification), ../optimystic/docs/reactivity.md (§The node's watch service, §Origination point), ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (NodeOptions.cohortTopic)
----
# Strand nodes opt in to reactivity (GitHub #28)

## What Optimystic 1.10.0 offers

`createLibp2pNode({ cohortTopic: { enabled: true, wantK?, host? } })` builds the cohort-topic
host, installs the change bridge that originates a signed notification for each commit this node
applied as a tail-holder, and attaches `node.reactivityWatch`. Absent or `enabled !== true`, the
node is built exactly as today.

On the Quereus side, a table tagged `with tags ("optimystic.network_watch" = true)` on a node that
has `reactivityWatch` gets one network subscription per table, and a commit from any machine fires
`Database.watch` subscribers as a coarse whole-table invalidation. A tail read every 20 s (edge) /
30 s (core) bounds a lost notification to one renewal. A node the host registers
(`collectionFactory.registerLibp2pNode`, which is how cadre-core hands strand nodes to the plugin)
must itself have been built with `cohortTopic`.

cadre-core builds every strand node in `StrandInstanceManager.buildStrandRuntime`
(`createLibp2pNode({...})` around `strand-instance-manager.ts:758`) and passes no `cohortTopic`, and
no config field can carry one. So no strand node ever originates or watches.

## Decided shape (tend pass, from the #28 proposal)

- **Node-local, operator-supplied only.** A field on `CadreNodeConfig`, never read from the control
  database, a strand row, or a peer:
  `strandReactivity?: { enabled: boolean; strandIds?: string[] }`.
  The planner may keep the reporter's name `strandCohortTopic` if it reads better beside the other
  `strand*` fields; pick one and use it everywhere.
- **Default off.** Enabling registers the cohort-topic and reactivity protocols on the strand node.
  On an open strand any peer can reach them (see #23); on a closed strand the revocation gate
  (`authorizeInboundStream`) already covers inbound streams. Off by default keeps both unchanged.
- **Fail-closed filter.** `enabled === true` and either no `strandIds` / an empty array, or an exact
  match on the strand id. Otherwise spread **no** `cohortTopic` key at all.
- **No `minSigs`, no `wantK`.** The reactivity root verifies against the tail's storage group with
  the consensus super-majority (`docs/reactivity.md` §Origination point); the cohort-topic `minSigs`
  does not apply to it, and db-p2p wants the host's `wantK` and the membership gate's to match,
  which its default keeps.
- **Carried by the retained launch config** (`launchStrand` → `startStrand({...})` in
  `cadre-node.ts`), so a hibernation wake rebuilds with it, as `strandBackfill` and
  `strandFirstSync` are.
- **cadre-cli / cadre-host config files** expose it where they expose the other `strand*` node
  options, through `@serfab/config-check` strict checking.

## Questions the plan must settle by reading code

- **How a strand table gets the tag.** Strand schemas are declarative (`schema {}` / `apply schema`),
  and `control-database.ts:675` notes declarative tables carry no per-table `using optimystic(...)`.
  Find whether a sApp's declared table can carry `with tags ("optimystic.network_watch" = true)`
  through `quereus-plugin-sereus` (`compose-strand.ts`) and Quereus's declarative schema, and what
  the plugin's "a tag change is not persisted across restart" caveat means for a strand reopened
  from storage (the schema is re-applied at open, so it may not matter). If tags cannot pass
  through, decide the smallest route: a sApp-config list of watched tables that cadre-core applies,
  or a Quereus/plugin upstream request (then a `blocked/report-…` ticket with draft text).
- **The plugin README's "every machine in every cohort" caveat.** It was written 2026-09-30, before
  Optimystic's 10-02 work that roots a collection's tree at its tail block's storage group
  (`docs/reactivity.md` §Origination point says that is implemented). Strands default to
  `strandClusterSize` 4. The scenario below is what settles whether a strand with more machines
  than its cluster size is woken; if it is not, record the limit in `docs/strands.md` and tell
  optimystic-tend (the caveat would still hold) rather than working around it here.
- **Known upstream cost:** optimystic backlog `bug-first-registration-proof-of-work-freezes-the-node-for-seconds`
  (0.3–17 s of proof of work on a cold-start registration, on Node). On a phone this is worse. Note
  it in the docs beside the option; do not enable by default anywhere because of it.

## Tests that matter

- **Unit (cadre-core):** `buildStrandRuntime`'s option assembly spreads `cohortTopic: { enabled: true }`
  for an enabled, matching strand and **no key** for absent / `enabled: false` / non-matching
  `strandIds`. Extract the spread into a small pure helper so this is a table test, not a mock of
  `createLibp2pNode`.
- **Scenario (integration-tests, real network):** two machines (two parties, or one party's two
  machines) on one strand with the option on, a sApp table tagged `optimystic.network_watch`. A
  `Database.watch` on machine B fires within one renewal of a commit made on machine A, and fires
  on the push path well inside that bound in the common case (assert the bound, log the measured
  latency). A negative arm with the option off on B sees no wake from A's commit within the same
  window. If the tag cannot be declared (question 1), the scenario applies it the way the plan
  decides.
- Reuse the existing scenario harness helpers (`packages/integration-tests/src/harness/`); do not
  build a new harness.

## Out of scope (park in backlog if found necessary)

- The control network node (control-table reactivity).
- The reference apps replacing their poll loops: `backlog/feat-reference-apps-watch-strand-changes`.
- Public/unauthenticated readers (#23, `blocked/decide-public-read-only-strand-access`).

## After it lands

Reply on GitHub #28 with the released version and the final field name, and note that the
reporter's regression test inverts (it detects the landed feature).
