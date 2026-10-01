description: Only phones and web pages that wire it up by hand can answer a join request today, so an always-on machine of the inviting party can never answer for an offline phone. Make every node answer join requests from the moment it starts, checking tokens against the party's own records.
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/cadre-node.ts (initializeStrandSolicitation ~7981, createOpenInvitation ~8037, formStrand ~8065, start(), stop() ~4662, admitInboundControlConnection ~2045), packages/cadre-core/src/strand-solicitation.ts (StrandSolicitationServiceOptions), packages/cadre-core/src/control-formation-recorder.ts, packages/reference-app-rn/src/cadre-phone.ts (initializeFormationResponder ~386), packages/reference-app-web/src/lib/cadre-web.ts (wireSolicitation ~529), packages/reference-app-web/e2e/fixtures/formation-responder.ts (~209), packages/integration-tests/src/scenarios (callers of initializeStrandSolicitation), docs/architecture.md (Strand Formation), docs/api.md, docs/cadre-host.md
----
# Every node answers formation from start

Part of gotchoices/sereus#25 (split from the plan ticket `durable-pending-join`). Inviter side, reason 2 of the issue's three ("cadre-cli and cadre-host never install the formation responder").

## Today

- `CadreNode.initializeStrandSolicitation(options)` registers the `/sereus/formation/1.0.0` handler. Only embedders call it: the React Native app (`initializeFormationResponder`), the web app (`wireSolicitation`), the web e2e fixture and integration scenarios. All of them pass `formationUsageRecorder: new ControlFormationUsageRecorder(controlDb)`.
- `createOpenInvitation` and `formStrand` call it lazily with **no options**, which installs a responder **with no recorder**. Such a responder accepts every token (`validateToken`: "No recorder configured — accept all tokens") and provisions a placeholder strand. Any embedder that skips the explicit call gets that responder.
- cadre-cli and cadre-host never call it, so an always-on machine has no handler. Its connection gate also refuses the stranger, because `admitInboundControlConnection` consults `strandSolicitationService?.hasOutstandingInvitation()` and that is `undefined` there.

## Change

- **The default recorder lives in core.** In `initializeStrandSolicitation`, when `options.formationUsageRecorder` is absent, use `new ControlFormationUsageRecorder(this.controlDatabase)`. The no-recorder responder is then unreachable from `CadreNode`. It remains available only by constructing `StrandSolicitationService` directly, which the mock transport tests do.
- **`start()` installs the responder.** Call it after the control database and control node are up, at the point where the seed-bootstrap service is installed (same failure posture: log and continue, the node still starts; a later `createOpenInvitation`/`formStrand` installs it lazily as today). No config switch. Every node of a party already holds the replicated `FormationInvite`/`FormationUsage` tables, so every node can check a token.
- **A later explicit call replaces the installed service.** Embedders and tests that pass their own recorder, approver or formation config call `initializeStrandSolicitation` after `start()`. That call must unregister the previous service's handler from the control node before registering the new one, and on failure restore the previous one (registered again). Today two services on one node would collide on the protocol id. Keep the existing "set before await so a concurrent lazy call reuses it" ordering.
- **Reference apps drop their wiring.** `cadre-phone.ts` `initializeFormationResponder` and `cadre-web.ts` `wireSolicitation` (and the `solicitationReady` promise if nothing else needs it) are deleted. The web e2e fixture and integration scenarios that only pass the default recorder drop the call. Keep the calls that pass something else (a fake approver, a custom provisioner, deadlines).

## What this does not cover

- The invitation still lists only the minting machine's addresses. A joiner learns of the always-on sibling only through `invitation-names-every-party-machine`.
- A sibling that does not run the closed host strand answers `MEMBERSHIP_INVITE_UNAVAILABLE_REASON` (retryable), as `issueStrandMembershipInvite` does today for a not-yet-live runtime. Reason 3 of the issue (a live runtime and `StrandPartyKey` on the responder) is already met on a storage-profile node that hosts the party's strands (`hostUnclaimedStrands`).

## Edge cases & interactions

- **Connection gate on always-on nodes.** Once installed, every node admits a stranger's control connection while any party invitation is outstanding (`hasOutstandingFormationInvite`, one control read per stranger connection). That is the same posture phones have today and is what lets a joiner reach the sibling. Confirm by inspection that the per-stream gate still refuses the stranger's control-DB protocol streams (`authorizeInboundControlStream` has no stranger carve-outs), so the only thing a stranger can open is the formation protocol.
- **Donated nodes (cadre-host donation, cadre-provider containers).** They hold no owner key. The responder writes only `FormationUsage` (joiner-consent-signed) and, for an unbound invite, a consent-seated `Strand` row. Neither needs an owner key. Verify by reading `ControlFormationUsageRecorder.recordUsage`/`provisionAndRecord` and the matching `Authorized` constraints in `schemas/control.qsql`.
- **Outside approval (`ValidationUrl`).** The recorder calls the invite's HTTP hook from whichever machine answers, so an always-on sibling obtains the same approval the phone would. No change.
- **Start ordering.** The responder must not be registered before the control database can answer `queryFormationInvite`. A stranger arriving during start-up must see the gate's existing "node not fully up" behaviour, not a responder that throws on a closed database.
- **`stop()`** already unregisters and nulls the service. Confirm that a restart (`stop()` then `start()`) registers exactly once.
- **Replacement race.** An explicit `initializeStrandSolicitation` concurrent with a lazy one from `formStrand`: the last writer wins and exactly one handler is registered. Verify by inspection; the existing "set before await" comment covers the lazy side.

## Tests

- No new unit test for the start-time install: it is wiring. The integration scenarios that stop wiring the recorder by hand cover it, and they fail if tokens are no longer checked (the concurrent-redemption scenario depends on single-use enforcement).
- One test for the replacement: on a started node, call `initializeStrandSolicitation` with a custom recorder, then form against it. The custom recorder is consulted, and no duplicate-handler error is thrown. Put it beside the existing `cadre-node-formation-membership.spec.ts` setup if it already starts a node; otherwise in the cheapest spec that does.

## TODO

- Default the recorder in `initializeStrandSolicitation`; make re-initialization unregister then register (with restore on failure).
- Install the responder in `start()` (log-and-continue on failure).
- Remove the reference apps' and fixtures' default-only wiring; keep calls that customize.
- Docs: `docs/architecture.md` Strand Formation (every node answers; the default recorder), `docs/api.md` (`initializeStrandSolicitation` is optional and replaces the default), `docs/cadre-host.md` (a hosted node answers formation for its party). Add a release-note bullet in `.release-notes.pending.md`: embedders no longer need to wire the responder, and a lazily installed responder now checks tokens.
- `yarn lint`, `yarn typecheck`, `yarn workspace @serfab/cadre-core test`; run the formation integration scenarios touched (`strand-formation-e2e`, `strand-formation-concurrent-redemption`, `strand-formation-cross-party-seed`).
