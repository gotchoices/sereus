----
description: Strand formation disclosure/identity validation is non-functional over libp2p — the caller's disclosure/invitation token is never transmitted, so consent gating and result validation accept anything.
files: packages/cadre-core/src/strand-formation-manager.ts, packages/strand-proto/src/bootstrap.ts
----
The strand formation protocol is meant to gate strand creation on consent: a responder publishes an invitation, an initiator dials in carrying that invitation's token plus a disclosed identity (`StrandFormationDisclosure`), and both parties validate each other before a strand is provisioned. In the current implementation the disclosure and the real invitation token are never actually carried end-to-end across the libp2p transport, and the result-validation hooks are stubbed to accept everything. As a result, the consent gating, identity disclosure, and provisioning-result validation that the formation design promises do not function over the real transport.

## How it diverges

**The caller's disclosure / invitation token is never transmitted.** `StrandFormationManager.formStrand` (packages/cadre-core/src/strand-formation-manager.ts:139-166) converts the `OpenInvitation` into a `BootstrapLink` carrying the real `token` and `responderPeerAddrs`, then calls `sessionManager.initiateBootstrap`. But strand-proto's `DialerSession.connectAndSend` constructs its own contact message internally with `identityBundle: { partyId: this.sessionId }` (packages/strand-proto/src/bootstrap.ts:339-344) — a synthetic identity bundle that contains neither the caller's real `StrandFormationDisclosure` nor any token under `identityBundle`. On the responder side, the `validateIdentity` hook (strand-formation-manager.ts:203-217) therefore receives only the synthetic identity and reads the token via `(identity as any)?.token ?? ''`, which is always empty. Consequently `DisclosureValidator` / `FormationUsageRecorder` cannot gate on the real invitation token or the real disclosed identity. The inline comments in `formStrand` ("We need to extend this to pass the disclosure - for now we use partyId") and in `validateIdentity` ("For now, use a placeholder - this will be refined") confirm the wiring is unfinished.

**The initiator performs no validation of the responder's result.** The `validateResponse` and `validateDatabaseResult` hooks unconditionally return `true` ("Accept all responses for now" / "Accept all database results for now", strand-formation-manager.ts:254-264). The initiator therefore accepts whatever `strandId`, provisioning result, and DB connection info the responder returns, with no check that it matches the invited/disclosed identity or the expected strand.

**Placeholder cadre peer addresses are exchanged instead of real ones.** strand-proto's session messages embed literal placeholder cadre peer addresses — the responder's `ProvisioningResultMessage` sends `cadrePeerAddrs: ['cadre-a-1.local', 'cadre-a-2.local']` (packages/strand-proto/src/bootstrap.ts:264) and the dialer's contact message sends `cadrePeerAddrs: ['cadre-b-1.local', 'cadre-b-2.local']` (bootstrap.ts:343). These are hardcoded stubs, not the parties' actual cadre peer addresses, so the formation protocol exchanges no usable cadre connectivity info even when it completes.

## Expected behavior

The formation protocol must carry real consent and connectivity data end-to-end over the real libp2p transport:

- The initiator's contact message must transmit the caller's real invitation `token` and the caller's `StrandFormationDisclosure` (disclosed identity), so the responder's `validateIdentity` / `DisclosureValidator` and `FormationUsageRecorder` can gate formation on the actual token and disclosed identity rather than on a synthetic `{ partyId }` bundle and an always-empty token.
- Both the contact message (initiator → responder) and the provisioning/result messages (responder → initiator) must carry each party's real cadre peer addresses, not literal `cadre-*.local` placeholders, so the strand has usable cadre connectivity info after formation.
- The initiator must validate the responder's response and database result against the actual disclosed / invited identity and the expected strand — `validateResponse` and `validateDatabaseResult` must perform real checks rather than unconditionally returning `true`, so a responder cannot return an arbitrary `strandId` / connection info and have it accepted.

## Use case

Open-invitation strand formation between two cadre parties over real libp2p (as exercised by the formation E2E scenarios, e.g. packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts): a responder issues a single-use, time-bounded invitation; an initiator forms the strand by presenting that invitation's token plus its disclosed identity; consent gating must actually reject a wrong/used token or a disclosed identity that the `DisclosureValidator` rejects, and the initiator must reject a responder that returns a result inconsistent with the invitation. This currently passes only because the validators are fed empty/synthetic inputs or are stubbed, not because real disclosure is being transmitted and validated.

## Key references

- packages/cadre-core/src/strand-formation-manager.ts — `formStrand` (lines 139-166), `createSessionHooks` with `validateIdentity` (203-217), `validateResponse` / `validateDatabaseResult` stubs (254-264).
- packages/strand-proto/src/bootstrap.ts — `DialerSession.connectAndSend` contact message (339-344), `ListenerSession.sendResponse` (258-271) including placeholder `cadrePeerAddrs` (264, 343).
- Note: strand-proto is marked deprecated in AGENTS.md; the fix should account for where the formation transport actually lives going forward rather than only patching deprecated code.
