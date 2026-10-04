description: Review the new operator setting that turns on Optimystic's change notifications for chosen strands, so a strand node announces its commits and an app on another machine is told a strand changed instead of polling for it (GitHub #28).
architecture: docs/strands.md#change-notifications-reactivity
files: packages/cadre-core/src/strand-reactivity.ts (new), packages/cadre-core/test/strand-reactivity.spec.ts (new), packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml, docs/strands.md, docs/architecture.md, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (NodeOptions.cohortTopic, read only)
----
# Strand nodes opt in to reactivity: the node option — review

## What was built

A node-local operator setting, `strandReactivity: { enabled: boolean; strandIds?: string[] }`, that makes cadre-core build chosen strand libp2p nodes with Optimystic's `cohortTopic: { enabled: true }` option (`@optimystic/db-p2p` `NodeOptions.cohortTopic`). Such a node announces every commit whose collection log tail it applied, and a strand table tagged `"optimystic.network_watch" = true` on a node with the option wakes its `Database.watch` subscribers on another machine's commit. No change in `quereus-plugin-sereus`: the plugin reads `node.reactivityWatch` from the node `compose-strand.ts` registers.

- **`packages/cadre-core/src/strand-reactivity.ts`** (new, exported from the package index): `StrandReactivityConfig` and `strandCohortTopicOption(config, strandId)`, which returns `{ cohortTopic: { enabled: true } }` only when `enabled === true` and `strandIds` is absent, `[]`, or contains the id exactly; otherwise `{}` with no `cohortTopic` key. Fails closed on a non-boolean `enabled` or a non-array `strandIds`.
- **Threading** (same route as `strandBackfill`): `CadreNodeConfig.strandReactivity` (doc comment in `types.ts`) → `CadreNode.launchStrand` passes `reactivity:` into `startStrand` (the only `startStrand` call site) → `StartStrandConfig.reactivity` → `buildStrandRuntime` resolves the slice before the `try`, logs `strand %s: change notifications on` when non-empty, and spreads it last into `createLibp2pNode({...})`.
- **cadre-cli**: `CliConfig.strandReactivity`, checked in `schema.ts` with `objectOf({ enabled: booleanValue, strandIds: arrayOf(nonEmptyString) }, { required: ['enabled'] })`, passed through in `commands/start.ts`. No environment variable. README gains a "Strand change notifications" subsection under Configuration; `example.cadre.yaml` gains a commented-out block (not in the original file list; the README calls that file "a complete configuration example", and the CLI test that loads it still passes).
- **Docs**: `docs/strands.md` new section "Change notifications (reactivity)" — what it does, the table tag with example, the filter rules, frozen-at-build, enable-on-every-machine, exposure, known cost, profile effect. `docs/architecture.md` → "Reactive Strand Management" gets one sentence linking to it.

cadre-host and cadre-provider are deliberately untouched (`backlog/feat-cadre-host-and-provider-nodes-carry-strand-reactivity`).

## Deviations from the plan text

- **The plan's reason for passing no `wantK` was stale.** It said db-p2p wants the host's `wantK` to agree with "its membership gate's". Optimystic's completed ticket `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort` deleted that FRET membership gate; `wantK` is now only the width of non-root cohorts. The helper's comment and the docs give the current reason instead: the root is the tail block's storage group (`clusterSize` wide), verified at the consensus super-majority, which neither `wantK` nor `host.minSigs` governs.
- **No "every machine in every cohort" caveat in the docs.** Optimystic's plugin README (§Network change notification, "Today, every machine in every cohort") still states that limit, but the same completed ticket removed it, and `../optimystic/docs/architecture.md` records a six-machine, three-member-storage-group real-libp2p run where a watcher outside the tail's group is woken. That README line is stale upstream; it is a sibling repo, so it was not edited.

## Checked by inspection (no test)

- **Hibernation wake** rebuilds with the same option: `resumeStrand` builds `resumeConfig` as `{ ...launchConfig, ... }` and only overrides `bootstrapNodes`/`servingMachines`, so `reactivity` carries through (`strand-instance-manager.ts` ~line 1398).
- **Host construction failure** (or FRET missing) throws from `createLibp2pNode`, which sits inside `buildStrandRuntime`'s existing `try` → `releaseRuntime` rollback, like any other build failure.
- **Teardown**: db-p2p wraps `node.stop()` to release the watch service and host; cadre-core's stop path is unchanged.
- **Control node** untouched: `buildControlNodeOptions` never sees the setting.
- **The per-stream gate does not cover the new handlers**: `libp2p-node-base.ts` spreads `inboundAuthorization` into exactly four service inits (lines ~899/933/952/970), and `createCohortTopicHost` receives none of it. This is what the docs' exposure section says.

## Tests

- `packages/cadre-core/test/strand-reactivity.spec.ts` — one table test over `strandCohortTopicOption`, 11 shapes: the three enabling shapes (absent / empty / matching `strandIds` under `enabled: true`) yield `{ cohortTopic: { enabled: true } }`; non-matching ids, absent config, `enabled: false` (with and without the id named), `enabled` as `'true'` and as `1`, `strandIds` as a string and as `null` all yield `{}`, and the test asserts `'cohortTopic' in result` is false for them, so db-p2p's "absent" path is taken rather than `{ enabled: false }`.

Nothing mocks `createLibp2pNode`. The CLI checker was exercised by hand (not committed — `@serfab/config-check`'s own tests cover the mechanism): `{enabled:'true'}`, missing `enabled`, a non-string `strandIds` entry, and an unknown key `strandId` are each refused with a message naming the key; the two valid shapes pass through.

The real-network proof — a commit on one machine waking a watcher on another through a strand — is the follow-on ticket `strand-reactivity-scenario`.

## Validation run

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core test` — 150 files, 2353 passed, 1 skipped.
- `yarn workspace @serfab/cadre-cli build` then `yarn workspace @serfab/cadre-cli test` — 19 files, 254 passed (includes "accepts the shipped example.cadre.yaml").
- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/cadre-cli typecheck` — clean.
- `yarn lint` — exit 0.

## For the reviewer

- **Docs claims not measured here**: what a watcher sees when only some of the tail's storage machines have the option (the docs say it is unmeasured and that the renewal tail read should bound it to 20/30 s); the 0.3–17 s proof-of-work figure is Optimystic's measurement (`bug-first-registration-proof-of-work-freezes-the-node-for-seconds`), quoted, not re-run.
- **The tag-survives-restart claim** rests on `compose-strand.ts` re-applying the sApp schema at every open after `hydrate`, and on Quereus's declarative differ issuing `alter table … set tags` on drift. Confirmed by reading `compose-strand.ts` (hydrate at ~line 288, then apply); the differ behaviour is taken from the plan's citation (`../quereus/packages/quereus/test/declarative-equivalence.spec.ts` "decorations (tags)") and not re-run. The scenario ticket is the place that would catch it.
- The log line uses the module's existing `sereus:cadre:strand-manager` debug namespace, so an operator sees it only with `DEBUG` on.
