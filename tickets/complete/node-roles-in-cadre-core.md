description: A node's behaviour used to follow from one two-way choice (device or server). It is now four separate settings — always on, overlay traffic tier, change-notification forwarding, and holding strand data — with the device/server choice as the preset, so a deployment can tune each one.
architecture: docs/cadre/node.md#node-classes
files: packages/cadre-core/src/node-roles.ts (new), packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-server.ts, packages/cadre-core/src/strand-reactivity.ts, packages/cadre-core/src/arachnode-stub.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/node-roles.spec.ts (new), packages/cadre-core/test/strand-reactivity.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/cadre-core/README.md, docs/cadre/node.md, docs/cadre/control-schema.md, docs/architecture.md, docs/concepts.md, docs/strands/app-schema.md, .release-notes.pending.md
difficulty: medium
----
# Node roles: one preset, separately settable roles

Implemented in `ticket(implement): node-roles-in-cadre-core`; reviewed here. First of two — `cadre-cli-config-sets-node-roles` puts the same four roles in the CLI's config file.

## What shipped

`packages/cadre-core/src/node-roles.ts` is the only place in cadre-core that turns a node class into behaviour. It declares `NodeRoles` (`alwaysOn`, `overlayTier`, `reactivity`, `strandCohortMember`), the two string-role types (`OverlayTier`, `ReactivityRole`), `NODE_ROLE_PRESETS` and `resolveNodeRoles(nodeClass, overrides?)`; all five are exported from `index.ts`. `CadreNodeConfig.roles?: Partial<NodeRoles>` is the embedder's surface, resolved once in `CadreNode`'s constructor.

Every former class comparison in cadre-core now reads the resolved roles: the control node's `fretProfile` (`overlayTier`) and `arachnode.enableRingZulu` (`alwaysOn`), the `network.enableRelay` default (`resolveRelayServer(network, roles)`), the `hostUnclaimedStrands` default, the published `CadrePeer.Profile`, and — through `StartStrandConfig.roles`, which replaced its `nodeClass` — every strand node's tier, Ring Zulu, relay server and cohort-topic host profile. Because the roles travel with the retained launch config, a strand woken from hibernation is rebuilt with the same ones.

Behaviour is unchanged for a node that sets no `roles`. The presets are `device` → `{ false, 'edge', 'forwarder', true }` and `server` → `{ true, 'core', 'forwarder', true }`, and `'forwarder'` passes Optimystic's `coreProfile()` explicitly, which is what db-p2p builds when no profile is given.

## Review findings

The implement diff was read first, then the handoff. Checked: the resolution function's branches; every site that used to compare `nodeClass`; the hibernation resume path; the published-profile/heartbeat pair; the behaviour-preservation claim about the cohort-topic host profile; the three decisions the handoff asked for a view on; every doc the change touched and the two it should have; and the whole repo for class comparisons the diff missed.

**Confirmed sound, so not findings.** Two claims carried the behavioural risk and both hold.

- *The reactivity change is behaviour-preserving.* db-p2p resolves `const profile = options.profile ?? coreProfile()`, and every other `cohortTopic.host` field it reads is `host?.X ?? default`. So adding `host: { profile: coreProfile() }` where `host` was absent changes nothing, and `host.profile` is what drives the subscription manager and the collection watch.
- *The `subscriber` cost written into `docs/strands/app-schema.md` is accurate, including the strongest claim in it.* A cold registration at a root whose routed member is unwilling for the reactivity tier returns `no_state` with no candidate members; the walk re-issues once with `bootstrap: true` to the same routed member, gets `no_state` again and falls to `retry_later` — so that root does stay on the poll, not for one tick. The 30 s / 20 s figures are the watch tick, which is `ttl/3` of the profile's subscriber TTL (90 s core, 60 s edge). The `unwilling_member` reply on a live root does name sibling members, as the doc says.
- *One effect of the role is undocumented and should stay that way.* An edge host profile also sets `deltaMaxBytes` to 0, so a `subscriber` accepts no inline delta payload. Cadre never reads one — a notification is a wake signal and the watcher re-reads — so there is nothing to state.

**Minor — fixed in this pass.**

- **`resolveNodeRoles` checked role values but ignored misnamed role keys,** so `roles: { alwaysON: true }` from a JavaScript embedder resolved silently to the preset. That is the same failure the value checking exists to prevent and the likelier half of it: a key has no small set of right answers to land in by accident. Added `refuseUnknownRoles`, driven by a `Record<keyof NodeRoles, true>` so a role added to the interface without a line there is a type error rather than a key rejected as a typo. One test replaces the hole; `types.ts`, `docs/cadre/node.md`, the README and the pending release notes now all say "misnamed or outside its set".
- **`NODE_ROLE_PRESETS` was exported deeply mutable.** An embedder — or a test that hands a preset straight to `StartStrandConfig.roles`, as several do — could have reassigned a field and changed every node's defaults. Now `Readonly<Record<NodeClass, Readonly<NodeRoles>>>`; `Readonly<NodeRoles>` is still assignable where `NodeRoles` is wanted, so no caller changed.
- **The module comment claimed cadre-wide what is true of cadre-core.** cadre-host's orchestrator reads the class to decide what to *provision* for a child (push credentials, a file store) before any node exists, and the integration harness built a node from it. The comment now scopes itself and names the provisioning case as its own decision rather than a node role.
- **`packages/integration-tests/src/harness/test-party.ts` kept its own copy of the class-to-tier mapping,** under a comment requiring it to match what `CadreNode` configures — the exact drift this ticket removed everywhere else. It now reads `NODE_ROLE_PRESETS[nodeClass].overlayTier`.
- **Two `ControlNodeOpts` comments in `node-fixtures.ts` still described the production defaults for `enableRelay` and `hostUnclaimedStrands` as `nodeClass === 'server'`.** Both now name the `alwaysOn` role.
- **A stray blank line split the `docs/concepts.md` glossary** between the `Node class` and `Node role` entries.

**Tests.** The implementer's `node-roles.spec.ts` over-covered the rejection path — six rows for three distinct rejections, since the two string roles share `checkedOneOf` and the two boolean roles share `checkedBoolean` — and asserted `NODE_ROLE_PRESETS[nodeClass]` against a hand copy of a constant the same test already proves through `resolveNodeRoles`. Trimmed to one row per rejection, dropped the constant assertion and the override row that restated a role's own preset, and added the one test the new key check needs. Net 2681 tests from 2684. Nothing else was added: each wiring site already has a spec asserting the built option through `CadreNodeConfig`, and those now exercise the role path unchanged — which is the real evidence the refactor preserved behaviour.

**Tripwires — parked at the code site, not filed.**

- `packages/cadre-core/src/arachnode-stub.ts` → `createArachnodeStub` still takes a `NodeClass` and gates its storage ring on `'server'`. The handoff asked for a decision: leave it. Nothing in this repo calls it, the rings it hands out are unimplemented (`backlog/later/5-ring-zulu-storage-rings`), and it is exported from `index.ts`, so changing the parameter is a breaking change, not a rename. A `NOTE:` at the function records the divergence it would cause if it ever had a caller — a `device` told `roles: { alwaysOn: true }` joins the real Ring Zulu and would still be given no storage ring here — and says to take `NodeRoles` when the rings are built.
- `packages/cadre-core/src/strand-instance-manager.ts` → `StartStrandConfig.roles`. `strandCohortMember` is read by nothing: `CadreNode`'s constructor refuses `false`, so every launch through a node has it `true`, and an embedder driving the exported manager directly is past that refusal. A `NOTE:` says this is the site that has to read the role once `strand-node-that-holds-no-blocks` lands, and that the constructor refusal can go then. That plan ticket already lists this file.

**Declined with the reason already at the site.** `provider/client.ts` names `'device'`/`'server'` to narrow an untrusted field of an HTTP response — parsing, not behaviour, and the module comment in `node-roles.ts` says so. `cadre-host` and `cadre-provider` still hand a node class to the nodes they provision; neither needs per-role control, and the CLI ticket covers the one program whose operators do.

**No major findings.** The resolution has one branch per role and one caller, every consumer reads it, and the two behavioural claims above were traced into Optimystic rather than taken on trust. Nothing survived that serves a release anchor or names a class-level invariant.

## Validation

At the final tree state: `yarn build` (whole workspace), `yarn lint` (eslint + `check:docs`, 66 files OK) and `yarn typecheck` (whole workspace) all clean. Suites: cadre-core **200 files, 2681 passed, 1 skipped**; cadre-cli 296 passed, 1 skipped; cadre-host 444 passed, 6 skipped; cadre-provider 234 passed; quereus-plugin-sereus 167 passed, 1 todo. No pre-existing failures surfaced.

**`@serfab/integration-tests` was not run.** Its scenarios are sequential real-network runs; one file alone exceeded ten minutes without producing output, so it is not agent-runnable and was stopped. `yarn typecheck` covers the package, and the one runtime claim the harness edit rests on was checked directly — importing `@serfab/cadre-core` from that package prints `NODE_ROLE_PRESETS` with exactly the values the ternary it replaced produced. Anyone running the suite next should know the harness edit has had no scenario run against it:

```
yarn workspace @serfab/integration-tests test
```
