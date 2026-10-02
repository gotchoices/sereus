description: Every node now answers join requests from the moment it starts, checking tokens against its party's own records, so an always-on machine can answer for an offline phone. No node-built responder accepts every token any more.
architecture: docs/architecture.md#who-answers-formation
files: packages/cadre-core/src/cadre-node.ts (start() installDefaultFormationResponder; initializeStrandSolicitation, swapFormationResponder; cleanup(); admitInboundControlConnection doc), packages/cadre-core/src/strand-solicitation.ts (adoptMintedInvitations), packages/cadre-core/src/strand-formation-manager.ts (CadrePeerAddrsSource), packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-formation-membership.spec.ts, packages/cadre-core/test/publish-formation-invite.spec.ts, packages/cadre-core/test/joined-strand-store.spec.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/integration-tests/src/scenarios/*, docs/architecture.md, docs/api.md, docs/cadre-host.md, .release-notes.pending.md
----
# Every node answers formation from start

Part of gotchoices/sereus#25 (inviter side: cadre-cli and cadre-host never installed the formation responder).

## What landed

- `CadreNode.start()` installs the strand-formation responder after the control database and the strand-wake/strand-addr services are up, before the node reports running. A failed install is logged and start continues; `createOpenInvitation` / `formStrand` install it lazily when it is missing.
- `initializeStrandSolicitation(options)` defaults the usage recorder to `ControlFormationUsageRecorder` over the node's own control database, so no responder built by `CadreNode` accepts every token. Only a directly constructed `StrandSolicitationService` (transport unit tests) does.
- `initializeStrandSolicitation` now replaces the installed responder instead of colliding on the protocol handler. Handler moves are queued (`solicitationSwaps` → `swapFormationResponder`), the registered service is tracked separately (`registeredSolicitation`), a failed swap restores the previous handler, and `cleanup()` drains the queue before unregistering. The replacement adopts the previous service's in-memory minted tokens so the connection gate stays open for invitations already handed out.
- The responder's own cadre addresses are read per formation (`CadrePeerAddrsSource = string[] | (() => string[])`), because a relay-only node has no address when start installs the responder.
- Reference apps (RN `initializeFormationResponder`, web `ensureSolicitation`), the web e2e fixture and the integration scenarios no longer wire the responder by hand. Scenarios that relied on accept-all tokens now pass a mock recorder and register the minted token.
- Docs: architecture.md "Who answers formation" plus the connection-gate paragraph; api.md; cadre-host.md "Strand formation on a hosted node"; release note.

## Review findings

Read the diff of `ticket(implement): formation-responder-installed-at-start` before the handoff.

**Checked, no defect found**

- *Swap correctness.* Walked overlapping `initializeStrandSolicitation` calls (A then B queued; A fails/B succeeds; A succeeds/B fails) and the restore paths: unregister failure leaves the old handler in its manager's `registeredNodes`, so the restore is a no-op; a register failure after a successful unregister re-registers the old one; a failed restore leaves `registeredSolicitation` pointing at a service whose manager no longer lists the node, so the next swap's unregister returns early and the new register proceeds. Exactly one handler ends registered in every case except the logged double-failure the handoff already names.
- *Gate behaviour with the default recorder.* `ControlFormationUsageRecorder.isTokenUsed` reports an unknown token as not used, so a minted-but-unpublished token still holds the gate open until expiry, as before for the reference apps (which already wired this recorder). Every node now runs check 6 of the admission gate; the per-connection control read is parked as the implementer's `NOTE:` in the `admitInboundControlConnection` doc — agreed it is a tripwire, not a ticket.
- *Callers relying on accept-all.* Grepped every `createOpenInvitation` / `initializeStrandSolicitation` caller in `packages/`. cadre-cli, cadre-host and the Quereus plugin never mint; the reference apps already used the DB recorder; every remaining scenario either publishes its token or now passes a mock recorder.
- *Lifecycle.* Install runs after `controlDatabase.initialize()`; a failed start's `cleanup()` and a stop both unregister and null both fields; a restart installs one fresh service.
- *Type safety / errors.* No `any`; the swap queue swallows only to order (the caller's own `await swap` still rejects); the start install logs rather than swallowing silently.
- *`cadrePeerAddrs` union.* Kept as is: one option with a function form reads simpler than a parallel `resolveCadrePeerAddrs`, and the initiator side benefits too (its contact message now carries live addresses rather than a snapshot from the first lazy init).
- *Tests.* The new "replaces the responder installed at start" test pins the replace contract (no duplicate-handler error, the custom recorder answers) over a real wire; kept. The changed stubs in the formation-membership / joined-strand / publish-invite specs are correct for the start-installed service; nothing to cut. No new tests added: no defect found that one would reproduce.
- *Source hygiene.* `cadre-node.ts` is 8,472 lines (`wc -l`); already tracked by `backlog/debt-cadre-node-single-file-size`, not re-filed.

**Found and fixed inline**

- `tickets/backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it.md` said the outstanding-invitation carve-out is unreachable on a lent node because it never calls `initializeStrandSolicitation`. No longer true; reworded to say every node runs that check since this ticket, keeping the ticket's actual point (it is the wrong instrument for a relay hop).

**Docs** — read architecture.md (Strand Formation, connection gate), api.md, cadre-host.md, the release note, both reference-app READMEs, and the doc comments in `strand-formation-manager.ts` / `control-formation-recorder.ts` / `membership-connection-gater.ts`; all describe the new behaviour. The RN README's description of the responder using `ControlFormationUsageRecorder` is still accurate.

**Major / tickets filed** — none: no finding cleared the filing bar.

**Tripwires** — none new beyond the implementer's admission-gate `NOTE:` above.

## Validation (review pass)

- `yarn eslint` on the touched cadre-core, reference-app sources and specs: clean.
- `yarn workspace @serfab/cadre-core test`: 147 files, 2347 passed, 1 skipped.
- Integration, previously unrun because of the stale-build guard (guard green this run): `strand-membership-closed-strand-e2e` and `strand-party-removal-via-formation-e2e` — 2 files, 11 tests passed.
- `reference-app-web` unit: 4 files, 67 passed. `reference-app-rn` unit: 22 files, 302 passed.
- Still not run: the opt-in measurement scenarios (`relay-round-trip-measure`, `strand-reattach-first-sync-measure`; only edit was dropping a default-recorder call) and the web Playwright e2e tier (fixture edited). `yarn typecheck` red is the cross-repo `@libp2p/interface` version split already triaged by the runner (`.pre-existing-known.md`), not re-reported.
