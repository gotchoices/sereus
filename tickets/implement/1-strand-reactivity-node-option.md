description: Add an operator setting that turns on Optimystic's change notifications for chosen strands, so a strand node can announce its commits and an app on another machine can be told a strand changed instead of polling for it (GitHub #28).
architecture: docs/strands.md
files: packages/cadre-core/src/strand-reactivity.ts (new), packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-reactivity.spec.ts (new), packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/README.md, docs/strands.md, docs/architecture.md, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (NodeOptions.cohortTopic, read only), ../optimystic/packages/quereus-plugin-optimystic/README.md (§Network change notification, read only)
----
# Strand nodes opt in to reactivity: the node option

## What Optimystic 1.10.0 gives us

`createLibp2pNode({ cohortTopic: { enabled: true } })` (`@optimystic/db-p2p`, `NodeOptions.cohortTopic`) builds a cohort-topic host on the node, installs the bridge that announces (originates a signed notification for) every commit whose collection log tail this node applied, and attaches `node.reactivityWatch`. With the key absent or `enabled !== true` the node is built exactly as today. The host's construction failing (or FRET missing) **hard-fails** node creation.

On the Quereus side, a table declared `with tags ("optimystic.network_watch" = true)` on a node that has `reactivityWatch` gets one network subscription, and a commit from any machine fires `Database.watch` subscribers as a whole-table invalidation. A tail read every 20 s (edge profile) / 30 s (core profile) bounds a lost notification to one renewal. For a node the host registers with `collectionFactory.registerLibp2pNode` — which is how `compose-strand.ts` hands each strand node to the plugin — the plugin reads `node.reactivityWatch` from that registered node (`collection-factory.ts` in the plugin), so nothing in `quereus-plugin-sereus` changes: the node just has to be built with `cohortTopic`.

Today cadre-core builds every strand node in `StrandInstanceManager.buildStrandRuntime` (`createLibp2pNode({...})`, `strand-instance-manager.ts` ~line 758) with no `cohortTopic`, and no config field can carry one.

## Settled design

**Name.** `strandReactivity` everywhere (cadre-core config, CLI config key, docs). It sits beside the other `strand*` fields and names the purpose; "cohort topic" is Optimystic's substrate name and stays inside the helper.

**Type** (new module `packages/cadre-core/src/strand-reactivity.ts`, exported from the package index):

```ts
/** Node-local, operator-supplied; never read from the control database, a strand row, or a peer. */
export interface StrandReactivityConfig {
  /** Master switch. Anything but `true` leaves every strand node exactly as before. */
  enabled: boolean;
  /** Strands to enable it for, by exact strand id. Absent or empty: every strand this node runs. */
  strandIds?: string[];
}

/**
 * The `createLibp2pNode` options slice for one strand: `{ cohortTopic: { enabled: true } }` when
 * `config.enabled === true` and (`strandIds` is absent, an empty array, or contains `strandId`
 * exactly); otherwise `{}` — no `cohortTopic` key at all, never `{ enabled: false }`.
 */
export function strandCohortTopicOption(
  config: StrandReactivityConfig | undefined,
  strandId: string
): { cohortTopic?: { enabled: true } };
```

Fail-closed: `enabled` must be the boolean `true`; a `strandIds` that is present but not an array (a JS embedder's mistake) enables nothing. No `wantK`, no `host` tuning, no `minSigs`: a reactivity root is the tail block's storage group verified at the consensus super-majority (`../optimystic/docs/reactivity.md` §Origination point), which `cohortTopic.host.minSigs` does not govern, and db-p2p wants the host's `wantK` and its membership gate's to agree, which the default keeps.

**Threading** — the same route `strandBackfill` takes:

- `CadreNodeConfig.strandReactivity?: StrandReactivityConfig` in `types.ts`, doc comment beside `strandClusterSize`/`strandBackfill`: default off; frozen when the strand's libp2p node is built, so a change takes effect at the next build (restart, or the next wake from hibernation); what enabling exposes (see *Exposure* below); every machine serving the strand should enable it (see *Mixed enablement*); the cold-start proof-of-work cost (see *Known cost*).
- `StartStrandConfig.reactivity?: StrandReactivityConfig` in `strand-instance-manager.ts`, forwarded from `CadreNodeConfig.strandReactivity`.
- `CadreNode.launchStrand` passes `reactivity: this.config.strandReactivity` into `startStrand({...})` (`cadre-node.ts` ~line 5900, beside `backfill`). `resumeStrand` spreads the retained launch config (`...launchConfig`), so a hibernation wake rebuilds with it — no change there; confirm by inspection.
- `buildStrandRuntime` spreads `...strandCohortTopicOption(config.reactivity, strandId)` into the `createLibp2pNode({...})` options, with a one-line comment pointing at the helper. Add a `log('strand %s: change notifications on', strandId)` when the slice is non-empty, so an operator can confirm the filter matched.
- The control node (`buildControlNodeOptions`) is untouched.

**cadre-cli.** A new top-level key `strandReactivity` in `CliConfig` (`config/types.ts`, doc comment pointing to `CadreNodeConfig.strandReactivity`), checked in `config/schema.ts` as `objectOf<…>({ enabled: booleanValue, strandIds: arrayOf(nonEmptyString) }, { required: ['enabled'] })` (match the helper names `@serfab/config-check` actually exports), passed through in `commands/start.ts` (`strandReactivity: config.strandReactivity`). No environment variable: cadre-provider is the only env-driven launcher and it is parked with cadre-host in `backlog/feat-cadre-host-and-provider-nodes-carry-strand-reactivity`. Document the key in `packages/cadre-cli/README.md` where the config file's keys are described.

**cadre-host is not touched in this ticket.** Its `host.config.json` is not checked with `@serfab/config-check`, its owner node and donated nodes get generated `cadre.json` files (`host-process-orchestrator.ts` `buildChildConfig` / `buildOwnerChildConfig`), and a donated node serves another party's strands, so whether it enables reactivity is the requester's call, which no provisioning request can carry yet. That is `backlog/feat-cadre-host-and-provider-nodes-carry-strand-reactivity`.

## How an sApp opts a table in

No Sereus code change. The sApp's declared schema (`declare schema App { … }`, applied by `compose-strand.ts`) accepts table tags, and Quereus's declarative differ converges tag drift with `alter table … set tags` on every `apply schema` (`../quereus/docs/schema.md`; `../quereus/packages/quereus/test/declarative-equivalence.spec.ts` "decorations (tags)"):

```sql
table Message (
  Id text primary key,
  Body text
) with tags ("optimystic.network_watch" = true)
```

The plugin README's caveat that a tag *change* is not persisted across restart does not bite a strand: `compose-strand.ts` hydrates the catalog and then re-applies the sApp schema at every open, so a tag the schema declares is restored (the full create-time record, tags included, is persisted; only a later `alter … set tags` is not, and the re-apply re-issues it). A tagged table on a machine without the option logs one plugin warning per table and keeps local wakes only, so an sApp can ship the tag unconditionally.

## Exposure (goes into docs/strands.md)

Enabling registers the cohort-topic, reactivity and matchmaking protocol handlers on the strand node. Those protocol ids are Optimystic's canonical, **network-agnostic** ids (not under `/optimystic/strand-<id>/`), which is harmless because each strand runs its own libp2p node.

- **Open strand:** any peer that can reach the node can open them, as it already can the four database protocols (#23, `blocked/decide-public-read-only-strand-access`).
- **Closed strand:** correct the earlier assumption — the per-stream gate (`authorizeInboundStream`, `strand-revocation-enforcer.ts` `authorizeStream`) is threaded only to db-p2p's four database protocols (`repo`, `cluster`, `sync`, `block-transfer`; `libp2p-node-base.ts` "The ONE authorization slice"), **not** to the cohort-topic or reactivity handlers. A revoked party is kept off them by the composed connection gater (`createRevocationConnectionGater` denies its inbound connections and dials) and by the enforcer's hang-up of its open connections; between a revocation landing and that hang-up, a revoked peer's open connection can still open these streams. A peer that was never a member is not denied by either layer, exactly as for the database protocols (the gate denies on positive revocation evidence only).

Off by default keeps both postures unchanged.

## Mixed enablement (goes into docs/strands.md)

A reactivity tree is rooted at the machines that store the collection's log tail. A strand node built without the option neither announces commits whose tail it applied nor serves subscriptions as part of a root group. So push wakes need the option on every machine that serves the strand — including the party's always-on replica hosts and the other parties' machines. What a watcher sees when some root-group machines lack it has not been measured; the renewal tail read should still bound it to 20/30 s. Say exactly that.

## Known cost (goes into docs/strands.md)

Optimystic backlog `bug-first-registration-proof-of-work-freezes-the-node-for-seconds`: a cold-start registration runs 0.3–17 s of proof of work on Node, worse on a phone's JS thread. Every watched table registers on each node build, so each hibernation wake pays it again. This is why the option is off by default and enabled nowhere in this repo's apps.

## Edge cases & interactions

- `strandReactivity` absent; `{ enabled: false }`; `enabled` not a boolean (`'true'`, `1`); `strandIds` absent; `[]`; containing the id; not containing it; present but not an array. Only the three enabling shapes yield a `cohortTopic` key — **verified by the unit test**.
- The spread must produce no `cohortTopic` key when off (not `{ enabled: false }`) so db-p2p's "absent" path is taken byte-for-byte — **unit test** asserts `'cohortTopic' in result === false`.
- Hibernation wake rebuilds with the same option (retained launch config) — **inspection** of `resumeStrand`'s `...launchConfig`.
- Host construction failure hard-fails `createLibp2pNode`; that lands in `buildStrandRuntime`'s existing `catch` → `releaseRuntime` rollback → strand error, like any other build failure — **inspection**; no new handling.
- Teardown: db-p2p wraps `node.stop()` to release the watch service and host before transports close; cadre-core's existing stop path needs nothing — **inspection**.
- Replica strands (`hostUnclaimedStrands`) and joined strands take the same filter; `strandFilter` (which strands run at all) and `strandIds` (which running strands announce) are independent — **inspection**, and one sentence in docs.
- `profile: 'storage'` builds a FRET `core` node (forwards notifications), `'transaction'` an `edge` node (subscriber only, 20 s renewal). No cadre-core branching on it — **docs**.
- Control node gets nothing — **inspection** of `buildControlNodeOptions`.
- CLI: an unknown key under `strandReactivity`, a missing `enabled`, an `enabled` that is not a boolean, and a non-string `strandIds` entry are refused at start by the strict checker — **covered by `@serfab/config-check`'s own tests**; no new CLI test.

## Tests

One new spec, `packages/cadre-core/test/strand-reactivity.spec.ts`: a table test over `strandCohortTopicOption` with the shapes above (expected: `{ cohortTopic: { enabled: true } }` for absent/empty/matching `strandIds` under `enabled: true`; `{}` with no `cohortTopic` key for everything else). Nothing mocks `createLibp2pNode`. The real-network proof is the follow-on ticket `strand-reactivity-scenario`.

## TODO

- Create `packages/cadre-core/src/strand-reactivity.ts` (type + helper), export both from the package index.
- Add `CadreNodeConfig.strandReactivity` (doc comment as above) and `StartStrandConfig.reactivity`.
- Thread it in `CadreNode.launchStrand`; spread the helper's slice in `buildStrandRuntime`; add the log line.
- Write `packages/cadre-core/test/strand-reactivity.spec.ts`.
- cadre-cli: `CliConfig.strandReactivity`, the schema checker, the pass-through in `start.ts`, README entry.
- docs/strands.md: add a `## Change notifications (reactivity)` section — what the option does, how a table opts in (the tag, with the example), the filter rule, *Exposure*, *Mixed enablement*, *Known cost*, profile effect, frozen-at-build. docs/architecture.md: one sentence under "Strand Lifecycle" linking to it.
- `yarn workspace @serfab/cadre-core build`, `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/cadre-cli test`, `yarn lint`.
