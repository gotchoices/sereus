description: The setting that says what kind of machine a node is was renamed from "transaction / storage" to "device / server", across the code, the config files and the docs. Review the rename.
architecture: docs/cadre/node.md#node-classes
files: packages/cadre-core/src/node-class.ts (new), packages/cadre-core/src/{types,cadre-node,control-database,control-cohort,strand-cohort,machine-removal,peer-record,cadre-invite-protocol,seed-bootstrap,relay-server,arachnode-stub,strand-instance-manager,control-schema,index}.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/provider/{client,rent-node}.ts, schemas/control.qsql, packages/cadre-cli/src/{config,commands,server}, packages/cadre-cli/{docker,example.cadre.yaml,README.md}, packages/cadre-provider/src/{types.ts,server/create-request-validation.ts,service}, packages/cadre-provider/README.md, packages/cadre-host/src/{hosted,orchestrator,server/routes/status.ts}, packages/cadre-host/ui/src, packages/integration-tests/src/{harness,scenarios}, packages/reference-app-rn/src/machines.ts, packages/reference-app-web/src/lib/machines.svelte.ts, packages/config-check/src/{checkers,env}.ts, docs/, .release-notes.pending.md
----

# Review: `NodeClass` ('device' | 'server') replaced `NodeProfile` ('transaction' | 'storage')

## What landed

`NodeProfile` is gone. A new module `packages/cadre-core/src/node-class.ts` owns both vocabularies and is the only place they meet:

```ts
export type NodeClass = 'device' | 'server';
export type PublishedProfile = 'transaction' | 'storage';
export function encodeAlwaysOn(alwaysOn: boolean): PublishedProfile;
export function decodeAlwaysOn(stored: PublishedProfile | null): boolean | null;
export function isPublishedProfile(value: unknown): value is PublishedProfile;
```

`CadreNodeConfig.profile` is `nodeClass`; the same rename ran through `StrandInstanceManager`'s start options, `resolveRelayServer`, `createArachnodeStub`, the provider client (`RentedContainer.nodeClass`, `CreateContainerBody.nodeClass`), `RentNodeOptions.nodeClass`, the cadre-cli config key and `CADRE_PROFILE` → `CADRE_NODE_CLASS`, the provider HTTP create request and its container environment, and cadre-host's hosted-node, orchestrator and persisted-state types. `CadreMachine.profile` became `alwaysOn: boolean | null`, so apps and the host UI show "always on" rather than a stored code.

The replicated `CadrePeer.Profile` column, its two values and the schema's `KnownProfile` check are untouched — only the column's comment changed, in both copies (`control-schema.ts` and `schemas/control.qsql`). Every write of the column goes through `encodeAlwaysOn`, every read through `decodeAlwaysOn`, and `isPublishedProfile` replaced the one inline literal comparison (the invitation-redemption record check).

280 files, +921/−825. No new tests: the ticket is a rename, and the existing suites were updated mechanically.

## What a reviewer should actually check

**The stored column did not move.** The whole compatibility argument rests on this. `grep -rn "'transaction'\|'storage'" packages/*/src` should find those literals only in `packages/cadre-core/src/node-class.ts` and in SQL text (`control-schema.ts`, `schemas/control.qsql`). Tests legitimately still write `profile: 'storage'` when they build a `PeerAddressRecord`, a `CadrePeerRow`, or call `signPeerRecord` / `insertCadrePeer` — those are the stored form.

**The signed digest is unchanged.** `peerRecordSignedPayload` still coalesces the same two codes, so no signature or digest moved and `CHANGED_DIGESTS` needed no entry. `control-schema-versions.spec.ts` passes with no new fixture, as the ticket predicted (it hashes the declaration with comments stripped), and `control-schema-drift.spec.ts` passes, which does compare comments — so the two schema copies are still byte-aligned.

**Where the decode happens.** Three readers: the control-cohort backbone (`controlCohortSiblingsOf`), seed and invitation-reply `preferred` (`projectSeedPeers`), and `CadreMachine.alwaysOn` (`describeMachines`). Worth confirming none of them lost the "null until it self-publishes" distinction — `decodeAlwaysOn(null)` is `null`, not `false`, and the backbone test is `alwaysOn === true`.

**One design choice beyond the ticket's letter, worth a look.** The ticket said the control-cohort backbone reads `alwaysOn: boolean | null`. Putting an optional `alwaysOn?` on the existing `CohortPeerRow` would have left `CadrePeerRow[]` structurally assignable, so a caller that forgot to decode would compile and silently get no backbone at all — a dial-policy regression with no failing test. Instead `CohortPeerRow` went back to addressing only (`peerId`, `multiaddr`) and `control-cohort.ts` gained `ControlCohortSibling`, which requires `alwaysOn`, plus `controlCohortSiblingsOf(rows)` as the single mapping. `CadreNode.listMembers()` now declares `Promise<CadrePeerRow[]>`, which is what it has always returned. If you disagree with the extra type, the alternative is the optional field and the silent-undefined risk.

**`NodeClass` is declared three times.** cadre-core is canonical; `packages/cadre-provider/src/types.ts` restates it because that package has no cadre-core dependency (verified in its `package.json`); `packages/cadre-host/ui/src/lib/state.svelte.ts` restates it as that file already hand-mirrors server types. Each carries a comment saying so. Judge whether the provider one should instead be inlined as a literal union.

**A Docker label was renamed.** `docker-orchestrator.ts` now writes `sereus.node-class` where it wrote `sereus.profile`. Nothing reads or filters on it — only `sereus.container-id` is filtered (confirmed by grep) — so this is cosmetic, but it is a change the ticket did not ask for, and already-running containers keep the old label.

**cadre-host refuses an old state file.** `StateStore.load` was split so the refusal is not swallowed by the existing "treat a corrupt file as empty" catch: `assertNodeClass` throws by name when any handle carries `profile`, telling the operator to stop the listed processes and delete the file. A handle with *neither* field still loads with `nodeClass: undefined`; that gap pre-dates this ticket (the old code had it with `profile`) and was left alone.

## Validation that ran

| Gate | Result |
|---|---|
| `yarn build` | pass |
| `yarn lint` (ESLint + `check:docs`, 66 files) | pass |
| `yarn typecheck` (all workspaces + the three coverage gates) | pass |
| `yarn check:svelte` | pass |
| `@serfab/cadre-core` tests | 198 files, 2654 passed, 1 skipped |
| `@serfab/cadre-cli` tests | 25 files, 295 passed, 1 skipped |
| `@serfab/cadre-host` tests | 53 of 54 files pass; one pre-existing failure, below |
| `@serfab/cadre-provider`, `@serfab/quereus-plugin-sereus`, `@serfab/config-check`, reference apps | pass (840 tests across them) |
| root script suites (`dep-ranges`, `check-docs`, both typecheck-coverage gates, stale-build-guard wiring) | pass |

Four integration scenarios were run to exercise the renamed harness and the behaviour derived from the node class: `basic-connectivity`, `control-cohort-auto-convergence` (the decoded backbone against real published rows), `strand-always-on-replica-survives-phone-loss` (`hostUnclaimedStrands` defaulting from `nodeClass === 'server'`) and `relay-only-control-addr` (the relay-server default). 13 tests, all passed.

## Known gaps — read these before reviewing

- **The full integration suite was not run.** 60-plus scenarios standing up real networks is well past the ten-minute agent budget, so only the four above ran. `yarn typecheck` covers the harness threading across all 52 touched scenarios, but their runtime behaviour is unverified by this pass.

- **One cadre-host test fails under full-suite load, and it is not this ticket's.** `orchestrator.test.ts` → "grandchild stays alive and keeps logging after spawner process exits" fails with `result.status === null`, which is its own `spawnSync({ timeout: 15000 })` expiring. It passes alone and passes with its whole file alone; it failed twice of two full-suite runs. The helper it spawns imports the built `dist/orchestrator/host-process-orchestrator.js`, and a cold import of that one module measures 8.2 s on an idle machine against the case's 15 s total budget. Written up in `tickets/.pre-existing-error.md` with the measurement; nothing was skipped or loosened.

- **A pre-existing contradiction the rename made visible.** `webrtc-ice-failure-falls-back-to-relay.integration.ts:236` has a helper named `phone` that now reads `nodeClass: 'server' as const`, directly under a comment saying "a phone relays for nobody". It was `profile: 'storage'` before, and the value mapping was preserved rather than changed, because `'device'` would also flip `fretProfile` to `edge` and turn `hostUnclaimedStrands` off — a behaviour change this ticket has no mandate for. If the scenario means a device, that is a one-line follow-up and wants its own validation.

- **`isPublishedProfile` was added beyond the API the ticket listed**, so that the two stored literals live in exactly one file; without it `cadre-invite-protocol.ts` would still compare them inline. It is exported from cadre-core's `index.ts` alongside `encodeAlwaysOn` / `decodeAlwaysOn`, which no embedder strictly needs either. Trim the public surface if you would rather it stayed internal.

- **`hostUnclaimedStrands`, the relay-server default and `fretProfile` still derive from the class by `=== 'server'` comparisons** in `cadre-node.ts`, `strand-instance-manager.ts` and `relay-server.ts`. That is what `node-roles-in-cadre-core` will replace with separately settable roles; the publish side is already down to a single method, `CadreNode.publishedProfile()`, for that ticket to repoint at `roles.alwaysOn`.
