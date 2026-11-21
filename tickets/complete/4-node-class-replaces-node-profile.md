description: The setting that says what kind of machine a node is was renamed from "transaction / storage" to "device / server", across the code, the config files and the docs. Reviewed and landed.
architecture: docs/cadre/node.md#node-classes
files: packages/cadre-core/src/node-class.ts (new), packages/cadre-core/src/{types,cadre-node,control-database,control-cohort,strand-cohort,machine-removal,peer-record,cadre-invite-protocol,seed-bootstrap,relay-server,arachnode-stub,strand-instance-manager,control-schema,index}.ts, packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/provider/{client,rent-node}.ts, schemas/control.qsql, packages/cadre-cli/src/{config,commands,server}, packages/cadre-cli/{docker,example.cadre.yaml,README.md}, packages/cadre-provider/src/{types.ts,server/create-request-validation.ts,service}, packages/cadre-provider/README.md, packages/cadre-host/src/{hosted,orchestrator,server/routes/status.ts}, packages/cadre-host/ui/src, packages/integration-tests/src/{harness,scenarios}, packages/reference-app-rn/src/machines.ts, packages/reference-app-web/src/lib/machines.svelte.ts, packages/config-check/src/{checkers,env}.ts, docs/, .release-notes.pending.md
----

# `NodeClass` ('device' | 'server') replaced `NodeProfile` ('transaction' | 'storage')

Implemented in `ticket(implement): node-class-replaces-node-profile`; reviewed here.

## What landed

`NodeProfile` is gone. A new module, `packages/cadre-core/src/node-class.ts`, owns both vocabularies and is the only place they meet:

```ts
export type NodeClass = 'device' | 'server';
export type PublishedProfile = 'transaction' | 'storage';
export function encodeAlwaysOn(alwaysOn: boolean): PublishedProfile;
export function decodeAlwaysOn(stored: PublishedProfile | null): boolean | null;
export function isPublishedProfile(value: unknown): value is PublishedProfile;
```

- **The rename**, through `CadreNodeConfig.nodeClass`, `StrandInstanceManager`'s start options, `resolveRelayServer`, `createArachnodeStub`, the provider client (`RentedContainer.nodeClass`, `CreateContainerBody.nodeClass`), `RentNodeOptions.nodeClass`, the cadre-cli config key and `CADRE_PROFILE` → `CADRE_NODE_CLASS`, the provider's HTTP create request and the container environment it writes, and cadre-host's hosted-node, orchestrator and persisted-state types.
- **`CadreMachine.profile` became `alwaysOn: boolean | null`**, so the reference apps and the cadre-host UI show "always on" instead of a stored code.
- **The replicated column did not move.** `CadrePeer.Profile`, its two values and the schema's `KnownProfile` check are untouched; only the column's comment changed, in both copies (`control-schema.ts` and `schemas/control.qsql`). Every write of the column goes through `encodeAlwaysOn` (one writer, `CadreNode.publishedProfile()`), every read through `decodeAlwaysOn` (three readers: `controlCohortSiblingsOf`, `projectSeedPeers`, `describeMemberRow`), and `isPublishedProfile` replaced the one inline literal comparison in the invitation-redemption record check.
- **`CohortPeerRow` went back to addressing only**, and `control-cohort.ts` gained `ControlCohortSibling` (which requires `alwaysOn`) plus `controlCohortSiblingsOf(rows)` as the single mapping; `CadreNode.listMembers()` now declares `Promise<CadrePeerRow[]>`, which is what it always returned.
- **`NodeClass` is declared three times**: cadre-core is canonical, `packages/cadre-provider/src/types.ts` restates it because that package has no cadre-core dependency, and `packages/cadre-host/ui/src/lib/state.svelte.ts` restates it because that file already hand-mirrors server types. Each carries a comment saying so.
- **cadre-host refuses a state file written before the rename.** `StateStore.load` was split so the refusal is not swallowed by the existing "treat a corrupt file as empty" catch: `assertNodeClass` throws by name when any handle carries `profile`, telling the operator to stop the listed processes and delete the file.
- **One Docker label was renamed**, `sereus.profile` → `sereus.node-class`, which the ticket did not ask for.

280 files, +921/−825 in the implement commit.

## Review findings

Read the implement diff in full before the handoff, then every touched cadre-core module and the reader and writer on each side of the stored column, the provider's create path and its container store, cadre-host's state store and the CLI startup that calls it, and the docs and READMEs the rename touched.

**Checked and found right:**

- **The stored codes are contained.** Outside tests, `'transaction'` and `'storage'` appear only in `node-class.ts` and in SQL text (`control-schema.ts`, `schemas/control.qsql`). No `NodeProfile`/`nodeProfile` identifier is left in the tree; `CADRE_PROFILE` is gone from the Dockerfile ENV, compose file, entrypoint, `env.example`, the cadre-cli env table, the provider's env builder and the integration harness's orchestrator, and `CADRE_NODE_CLASS` is consistent across all of them.
- **Each of the four conversions is value-for-value what it replaced**: `encodeAlwaysOn(nodeClass === 'server')` for `config.profile`; `decodeAlwaysOn(profile) === true` for `profile === 'storage'` in `projectSeedPeers`; `peer.alwaysOn === true` for `peer.profile === 'storage'` in the backbone test; and `decodeAlwaysOn(row.profile)` under the same `selfPublished` guard in `describeMemberRow`, where a self-published row with a null column still reports null rather than false.
- **The signed digest did not move**, as the handoff predicted: `peerRecordSignedPayload` coalesces the same two codes, and cadre-core's 198 spec files pass with no new fixture, including `control-schema-versions.spec.ts` (comments stripped) and `control-schema-drift.spec.ts` (comments compared, so the two schema copies are still byte-aligned).
- **Dropping `profile` from `CohortPeerRow` is pure cleanup**: `deriveCohortMembers` never read it, only declared it.
- **The provider's restated `NodeClass` has an incidental compile-time guard.** cadre-provider genuinely has no cadre-core dependency, and cadre-host assigns `OrchestratorCreateRequest.nodeClass` (the provider's union) into a parameter typed with cadre-core's `NodeClass`, so the two unions cannot diverge without a type error. The cadre-host UI copy has no such check, which is true of every field in that hand-mirrored file and predates this ticket.
- **The Docker label is cosmetic.** Only `sereus.container-id` is filtered on; nothing reads or filters the renamed label.
- **The cadre-host refusal is outside the corrupt-file catch**, and its message does reach an operator: it propagates out of `program.parseAsync()`, so Node prints the instruction (with a stack trace, because the CLI installs no top-level handler — that convention predates this ticket and applies to every command).

**Minor, fixed in this pass:**

- `cadre-node.ts` — a NOTE about a *performance* profile was caught by the rename: "If that read ever shows in a phone's profile" became "in a phone's node class", which means nothing. Restored as "shows up in a phone's CPU profile".
- `cadre-node.ts` — `isCurrentSelfRecord`'s doc line read "signed less than half a heartbeat ago, with this always-on claim"; now "with this node's own always-on claim".
- `packages/cadre-provider/README.md` and `.release-notes.pending.md` both claimed a mismatched provider/image pair fails loudly ("containers start without a node class", "a node whose configuration is refused"). It does not. The old image's Dockerfile sets `ENV CADRE_PROFILE=storage`, its entrypoint writes `profile: ${CADRE_PROFILE:-storage}`, and cadre-cli reads only the variables in its own env table, so an unknown `CADRE_NODE_CLASS` is ignored: the container comes up as an always-on node and a `nodeClass: "device"` request is lost with no error anywhere. The new image under an older provider defaults the same way. Both texts now say that. (The harness's own env model in `provider-process-orchestrator.ts` — image ENV at layer 2, the provider's values at layer 4 — is the same layering, which is how this was confirmed.)

**Major:** none. Nothing in the diff changes what a node does or what crosses the wire, and the one real design choice beyond the ticket's letter (the required `alwaysOn` on a new type instead of an optional field on `CohortPeerRow`) is the safer of the two — see below.

**Tripwire (recorded at the site, indexed here):**

- `webrtc-ice-failure-falls-back-to-relay.integration.ts`: the helper named `phone` carries `nodeClass: 'server'` directly under a comment saying a phone relays for nobody. It was `profile: 'storage'` before and the value was rightly preserved, since `'device'` would also flip `fretProfile` to `edge` and switch `hostUnclaimedStrands` off. A `NOTE:` at the site now says why the class disagrees with the name, that the ICE-fallback assertion does not reach the class, and to re-run the scenario and check the fallback timings if anyone makes it a device. Re-run: 2 tests pass.

**Considered and declined (no change):**

- **Trimming cadre-core's public exports**, which the handoff invited: nothing outside `cadre-core/src` uses any of the five symbols, but `signPeerRecord` and `peerRecordSignedPayload` are already public and take a `PublishedProfile | null`, so a public caller needs `encodeAlwaysOn` to produce that value and `isPublishedProfile` to judge an untrusted one. The surface matches the API that was already exported. Kept whole.
- **`ControlCohortSibling` over an optional `alwaysOn?` on `CohortPeerRow`.** The required field is right: with an optional one, `CadrePeerRow[]` stays structurally assignable, so a caller that forgot to decode would compile and silently select no backbone — a dial-policy regression with no failing test.
- **A lint rule pinning the two stored codes to `node-class.ts`.** There is no defect to point at, the invariant is already stated at the site in that module's header comment, and allowlisting the SQL text plus the tests that legitimately write the stored form would cost more than the one-line grep.
- **The provider's own container records.** A provider upgraded in place reads `containers.json` records carrying `profile`, with no equivalent to cadre-host's refusal, so such a record reports no `nodeClass` over the API. Nothing re-provisions from a stored record (`provisionContainer` reads the live request, not the record), and this repository keeps no backwards compatibility outside the control store.

**Tests:** none cut, none added. The implementer added none and renamed the existing suites mechanically, which is the right call for a rename. The one behaviour-bearing seam — decoding the column into a backbone decision — is covered on the policy side by `control-cohort.spec.ts` and on the decode side by the `control-cohort-auto-convergence` scenario against real published rows (re-run here, passes). `encodeAlwaysOn` and `decodeAlwaysOn` are total two-branch functions over a two-value union the type system already closes; a test for either would restate the implementation.

## Validation that ran

| Gate | Result |
|---|---|
| `yarn build` | pass |
| `yarn lint` (ESLint + `check:docs`, 66 files) | pass |
| `yarn typecheck` (all workspaces + the three coverage gates) | pass |
| `yarn check:svelte` | pass (285 + 1405 files, 0 errors) |
| `@serfab/cadre-core` tests | 198 files, 2654 passed, 1 skipped |
| `@serfab/cadre-host` tests | 54 files, 444 passed, 6 skipped |
| `@serfab/cadre-cli` tests | 25 files, 295 passed, 1 skipped |
| `@serfab/cadre-provider` tests | 32 files, 234 passed |
| `@serfab/quereus-plugin-sereus`, `@serfab/cadre-rn`, reference apps (ns/rn/web) | pass |
| `yarn test:dep-ranges`, `yarn test:check-docs` | pass |
| Integration: `control-cohort-auto-convergence`, `webrtc-ice-failure-falls-back-to-relay` | 3 tests, pass |

The cadre-host orchestrator failure the implement pass reported under full-suite load is gone: `tess: triage pre-existing test failure` sized the helper's `spawnSync` budget off the measured cold-import cost and names an exhausted budget as its own failure, and `tickets/.pre-existing-error.md` is deleted. The full file passes in the 54-file run.

## Known gaps

- **The full integration suite has not been run by either pass.** 60-plus scenarios standing up real networks is well past the ten-minute agent budget, so the implement pass ran four and this review re-ran two. `yarn typecheck` covers the renamed harness threading across all 52 touched scenarios, but their runtime behaviour is unverified.
- **A cadre-host handle carrying *neither* `profile` nor `nodeClass`** still loads with `nodeClass: undefined`. That gap predates the rename (the old code had it with `profile`) and was left alone.
- **`hostUnclaimedStrands`, the relay-server default and `fretProfile` still derive from the class** by `=== 'server'` comparisons in `cadre-node.ts`, `strand-instance-manager.ts` and `relay-server.ts`. `node-roles-in-cadre-core` replaces those with separately settable roles; the publish side is already down to the single `CadreNode.publishedProfile()` for that ticket to repoint at `roles.alwaysOn`.
