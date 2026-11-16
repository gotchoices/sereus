description: Rename the setting that says what kind of machine a node is from "transaction / storage" to "device / server". The old names come from a storage design that was never built and no longer describe the difference, and the change has to happen before real apps ship.
architecture: docs/architecture.md#node-profiles
files: packages/cadre-core/src/types.ts (NodeProfile ~74, CadreNodeConfig.profile ~832, CadrePeer row types ~2036/~2066/~2222), packages/cadre-core/src/node-class.ts (new), packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/relay-server.ts, packages/cadre-core/src/control-database.ts (~861 preferred, ~953), packages/cadre-core/src/control-cohort.ts (~139 backbone), packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/cadre-invite-protocol.ts (admittedRecord), packages/cadre-core/src/arachnode-stub.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/provider/client.ts, packages/cadre-core/src/provider/rent-node.ts, packages/cadre-core/src/control-schema.ts (CadrePeer.Profile comment only), packages/cadre-cli/src/config/{types,schema,env}.ts, packages/cadre-cli/src/commands/{init,start,start-node,node-session,status,status-query}.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-provider/src/{types.ts,server/create-request-validation.ts,service/container-env.ts,service/orchestrator.ts,service/container-service.ts,service/docker-orchestrator.ts}, packages/cadre-host/src/{hosted/types.ts,hosted/hosted-node-service.ts,hosted/hosted-node-watcher.ts,orchestrator/types.ts,orchestrator/state-store.ts,orchestrator/host-process-orchestrator.ts,server/routes/status.ts}, packages/cadre-host/ui/src/{lib/state.svelte.ts,routes/NodeDetail.svelte}, packages/reference-app-rn/src/{machines.ts,use-rental-poll.ts}, packages/reference-app-web/src/lib/machines.svelte.ts, packages/integration-tests/src/harness/*, docs/architecture.md, docs/cadre/node.md, docs/strands.md, docs/cadre-consistency.md, docs/reference-app-rn.md, packages/cadre-core/README.md, packages/cadre-cli/README.md
----

# `NodeClass` ('device' | 'server') replaces `NodeProfile` ('transaction' | 'storage')

## Why

`NodeProfile`'s values name Arachnode rings (a transaction ring and storage rings) that are not implemented, and both kinds of node now transact and store. The name also collides with Optimystic's cohort-topic `NodeProfile` (`edgeProfile()`/`coreProfile()`), which Sereus is about to pass through (`node-roles-in-cadre-core`). No real apps are deployed, so the API and every config surface change now, with no compatibility layer.

This ticket is the rename only. `node-roles-in-cadre-core` then splits the class into separately settable roles, with the class as the preset.

## The new names

- Type `NodeClass = 'device' | 'server'`. `'device'`: a phone, laptop or browser running an app, intermittently connected. `'server'`: an always-on node (cadre-host, cadre-cli, a provider container). Old → new: `'transaction'` → `'device'`, `'storage'` → `'server'`.
- `CadreNodeConfig.profile` → `nodeClass`. Same in `StrandInstanceManager` config, provider client and `rentNode` options.
- CLI config key `profile` → `nodeClass` (still required); env `CADRE_PROFILE` → `CADRE_NODE_CLASS`; `cadre init` writes `"nodeClass": "server"`; status shows "Node class".
- Provider create request `profile` → `nodeClass` (default `'server'`); container env `CADRE_NODE_CLASS`.
- cadre-host hosted-node and orchestrator types and persisted state: `nodeClass`.

## What does not change: the published `CadrePeer.Profile` column

Each machine publishes `Profile` in its self-signed control-network record, and siblings read it to dial always-on machines first, to mark seed peers preferred, and to show the owner which machines are always on. The control store is the one place where backwards compatibility applies (`docs/architecture.md` § Control schema versions and migrations; GitHub #46): a column rename cannot be migrated, and a party's machines update one at a time, so an older build's `KnownProfile` check would refuse a new value replicated from an updated sibling. So:

- The column, its values `'transaction'`/`'storage'` and the `KnownProfile` check stay. Only the schema comment changes, redefining the column as "is this machine always on" (`'storage'` = yes). A comment-only edit needs no new schema version; `control-schema-versions.spec.ts` confirms it (it compares `explain schema` hashes, which leave out comments).
- New `node-class.ts` owns the stored form. Nothing else in the codebase writes or compares the literals.

```ts
/** The stored form of CadrePeer.Profile. Kept as-is for control-store compatibility; it encodes only whether the machine is always on. */
export type PublishedProfile = 'transaction' | 'storage';
export function encodeAlwaysOn(alwaysOn: boolean): PublishedProfile;
export function decodeAlwaysOn(stored: PublishedProfile | null): boolean | null;
```

- Writers (`registerSelf`, the "record still current" check, the invitation request's signed record) publish `encodeAlwaysOn(nodeClass === 'server')`. `node-roles-in-cadre-core` replaces that argument with `roles.alwaysOn`.
- Readers decode. The control-cohort backbone, seed `preferred`, and `CadreMachine` read `alwaysOn: boolean | null` (null until the machine self-publishes) in place of `profile`, so apps and the host UI show "always on" instead of a stored code. Internal row types (`CadrePeerRow` and similar) carry `PublishedProfile`.

## Edge cases & interactions

- **`'transaction'` and `'storage'` appear in unrelated senses** (database transactions, storage paths, `storage.type`). Rename only node-class uses; grep each hit, do not substitute blindly. Verified by build plus the full test suites.
- **Mixed-release party.** An updated machine and an old one exchange `Profile` rows. Both still write and accept the old values, so nothing changes on the wire. Verified by inspection; `control-schema-migration-mixed-releases` is the existing scenario that would catch a regression.
- **Signed record digest.** `Profile` is covered by the machine's self-signature. Values are unchanged, so no digest changes and no `CHANGED_DIGESTS` entry is needed.
- **Provider service vs node image.** The provider passes the class to the container through `CADRE_NODE_CLASS`, which an older node image does not recognise. The rule (decided): the provider service and the node image it runs ship together, from one release. Write that rule in `packages/cadre-provider/README.md` beside the container environment contract (`container-env.ts`). Do not add a mapping for the old variable.
- **cadre-host persisted state.** A state file written before the rename holds `profile`. With no compatibility layer, the state-store loader must refuse it with a message naming the field, not crash or silently default. Verified by reading the loader; no test unless the loader has none for malformed state.
- **Config-check strictness.** An old CLI config with `profile` now fails as an unknown key and a missing `nodeClass`; that is the intended message.

## Tests

None new; this is a rename. Existing suites (cadre-core, cadre-cli, cadre-host, cadre-provider, integration-tests, reference apps) are updated mechanically and must pass. The control-schema version spec must pass with no new fixture.

## TODO

- Add `node-class.ts` (`NodeClass`, `PublishedProfile`, `encodeAlwaysOn`, `decodeAlwaysOn`); export from cadre-core `index.ts`; remove `NodeProfile`.
- Rename `profile` → `nodeClass` across cadre-core, then cadre-cli (config key, env, init, status, health), cadre-provider (request, env, types), cadre-host (types, state, routes, UI), reference apps, integration harness and tests.
- Route every write and read of `CadrePeer.Profile` through `encodeAlwaysOn` / `decodeAlwaysOn`; `CadreMachine.profile` → `alwaysOn`.
- Update the `CadrePeer.Profile` schema comment (comment only).
- Docs: rename the section "Node Profiles" in `docs/architecture.md` to "Node Classes" (update links to its anchor), and update `docs/cadre/node.md`, `docs/strands.md`, `docs/cadre-consistency.md`, `docs/reference-app-rn.md`, and the cadre-core and cadre-cli READMEs.
- Add a section to `.release-notes.pending.md` (format: `docs/releasing.md`) listing every interface change: `NodeProfile` → `NodeClass` and its values, `CadreNodeConfig.profile` → `nodeClass`, `CadreMachine.profile` → `alwaysOn`, the CLI config key and `CADRE_PROFILE` → `CADRE_NODE_CLASS`, the provider request field, the cadre-host state file being refused until recreated, and the rule that the provider service and node image ship together.
- `yarn build`, `yarn lint`, all package tests.
