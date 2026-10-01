description: Every node now answers join requests from the moment it starts, checking tokens against its party's own records, so an always-on machine can answer for an offline phone. Review the change, which also stops any node-built responder from accepting every token.
architecture: docs/architecture.md#who-answers-formation
files: packages/cadre-core/src/cadre-node.ts (start() ~1279 installDefaultFormationResponder; initializeStrandSolicitation ~8007, installDefaultFormationResponder, swapFormationResponder; cleanup() ~4675; admitInboundControlConnection doc ~2005), packages/cadre-core/src/strand-solicitation.ts (adoptMintedInvitations), packages/cadre-core/src/strand-formation-manager.ts (CadrePeerAddrsSource, currentCadrePeerAddrs), packages/cadre-core/src/control-formation-recorder.ts (docs only), packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-formation-membership.spec.ts, packages/cadre-core/test/publish-formation-invite.spec.ts, packages/cadre-core/test/joined-strand-store.spec.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/integration-tests/src/scenarios/*, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, docs/architecture.md, docs/api.md, docs/cadre-host.md, .release-notes.pending.md
----
# Every node answers formation from start — review

Part of gotchoices/sereus#25 (inviter side, reason 2: cadre-cli and cadre-host never installed the formation responder).

## What changed

- **Install at start.** `CadreNode.start()` calls `installDefaultFormationResponder()` right after the strand-wake and strand-addr services, i.e. after the control database is initialized and before `_running` flips. Failure is logged and start continues; `createOpenInvitation` / `formStrand` still install it lazily when the field is null.
- **Default recorder in core.** `initializeStrandSolicitation(options)` uses `new ControlFormationUsageRecorder(controlDatabase)` when `options.formationUsageRecorder` is absent. Nothing built by `CadreNode` accepts every token any more; only a directly constructed `StrandSolicitationService` (the transport unit tests) does.
- **Replacement instead of collision.** `initializeStrandSolicitation` now replaces the installed service. The field `strandSolicitationService` is still set synchronously (so a concurrent lazy caller reuses it). Handler moves go through a queue (`solicitationSwaps`) into `swapFormationResponder`, which unregisters the *registered* service (`registeredSolicitation`, tracked separately from the field) and registers the new one. On failure it re-registers the previous one, points the field back at it if no later call replaced it, and rethrows. `cleanup()` awaits the queue, unregisters `registeredSolicitation`, and nulls both fields.
- **Minted tokens carried over.** The new service takes over the old one's in-memory mint registry (`adoptMintedInvitations`), so the connection gate stays open for invitations already handed out.
- **Live cadre addresses (not in the ticket; found while implementing).** The service used to snapshot `getMultiaddrs()` at construction. Installed during start, a relay-only node (phones, the blind-relay scenarios) has no address yet, and a joiner's default validator rejects a result with an empty `cadrePeerAddrs`. `cadrePeerAddrs` on `StrandSolicitationServiceOptions` / `StrandFormationManagerOptions` now accepts `string[] | (() => string[])` (`CadrePeerAddrsSource`, exported); `CadreNode` passes a function, read per formation. Arrays still work for the unit tests.
- **Reference apps.** RN `initializeFormationResponder` and web `ensureSolicitation` / `wireSolicitation` / `solicitationReady` are deleted. The web e2e fixture no longer wires the responder.
- **Integration scenarios.** Calls that passed only the default recorder (or nothing) are dropped. Calls that passed only a `strandProvisioner` and relied on accept-all tokens (rbac-signed-write, strand-formation-e2e Phase 2 ×3, strand-membership-closed-strand-e2e) now also pass `createMockUsageRecorder()` and add the minted token to `knownTokens` — the pattern `multi-party-workflows` already used. Without that the default recorder refuses their unpublished tokens.
- **Docs.** architecture.md new subsection "Who answers formation" under Strand Formation, plus the connection-gate paragraph; api.md (initializeStrandSolicitation is optional and replaces); cadre-host.md "Strand formation on a hosted node"; release note.

## Inspection results the ticket asked for

- **Per-stream gate.** `authorizeInboundControlStream` has no stranger carve-outs (shared baseline, empty set, authorized member only), so a stranger admitted by the connection gate can open only seed and formation streams.
- **Donated nodes.** `FormationUsage.Authorized` needs a matching `FormationInvite` (plus approval when `ValidationUrl` is set) and the joiner's consent; the `Strand` consent branch of `AuthorizedInsert` carries no signature. Neither needs an owner key.
- **Start ordering.** The responder registers after `controlDatabase.initialize()`; a failed start's `cleanup()` unregisters it.
- **Restart.** `cleanup()` nulls both fields; the next `start()` installs one fresh service on the new control node.
- **Replacement race.** Swaps are serialized and each unregisters whatever is actually registered, so overlapping explicit/lazy calls end with the last caller's service registered and exactly one handler.

## Tests

- Added: `cadre-node-formation-membership.spec.ts` → "replaces the responder installed at start, and the replacement answers formation". On a started node, replaces the responder with a custom recorder + provisioner, then a bare libp2p joiner forms against an **unpublished** token. Passing proves no duplicate-handler error and that the custom recorder answered (the default one would refuse the token as unknown).
- Changed: `publish-formation-invite.spec.ts` gate test now replaces the responder with a recorder that cannot list invitations, so its "true came from the in-memory mint registry" claim still holds; the expired-invite test just uses the start-installed service. `cadre-node-formation-membership.spec.ts` and `joined-strand-store.spec.ts` stub the start-installed service instead of initializing one.
- No test for the start-time install itself (wiring); the integration scenarios that dropped their hand wiring cover it.

## Validation run

- `yarn lint` on all touched files: clean.
- `yarn workspace @serfab/cadre-core test`: 147 files, 2347 passed, 1 skipped.
- Integration (cadre-core dist rebuilt): strand-formation-e2e (22), strand-formation-concurrent-redemption (3), strand-formation-cross-party-seed (2), blind-relay-phone-to-phone-e2e (3), strand-relay-only-restart-reconverges (2, plus the `RESTART_TWO_PROCESS=1` case that uses the edited `.mjs` fixture), rbac-signed-write, membership-connection-gater (3), multi-party-workflows (5), strand-always-on-replica-hosts-cross-party-join, strand-chat-participants-converge (3): all pass.

## Known gaps — please cover

- **Not run: `strand-membership-closed-strand-e2e`, `strand-party-removal-via-formation-e2e`, and the reference-app-web / reference-app-rn unit suites.** The stale-build guard began refusing every suite that loads `@optimystic/db-p2p` partway through this run, because `../optimystic` has uncommitted edits to `packages/db-p2p/src/libp2p-node-base.ts`. Per `tickets/rules/sibling-repos.md` I did not build it. Run these once the sibling's build is fresh.
- **Not run:** the opt-in measurement scenarios (`relay-round-trip-measure`, `strand-reattach-first-sync-measure`), whose only edit was dropping the default-recorder call, and the web Playwright e2e tier (`formation-responder.ts` fixture edited).
- **`yarn typecheck` is red for an environment reason**, written up in `tickets/.pre-existing-error.md`: `../optimystic` commit `4d31f936` put `@libp2p/interface` 3.3.0 in `packages/db-p2p/node_modules` while this repo resolves 3.1.0. Every error is that cross-repo type identity, none at a changed line. The new spec's `noise()` line adds one more of the same (36 vs 35 in cadre-core).
- **`cadrePeerAddrs` union type.** A reviewer may prefer a separate `resolveCadrePeerAddrs` option (like `resolveStrandAddrs`) over the `string[] | (() => string[])` union. I chose the union to keep one option.
- **Restore failure.** If re-registering the previous service fails (the stray-handler caveat noted at `swapFormationResponder`), the field points at an unregistered service and nothing answers until the next `initializeStrandSolicitation`; it is logged, not retried.
- **Tripwire parked:** `NOTE:` in the `admitInboundControlConnection` doc — check 6 now does a control read for each stranger connection on every node, relay-enabled storage nodes included; cache it if that read ever shows.
