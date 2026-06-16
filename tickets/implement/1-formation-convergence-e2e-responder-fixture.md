description: Build a small headless test "second party" — a Node-based cadre node that hands out a chat invitation and shares its messages — so an end-to-end test can prove two parties really connect and sync.
prereq:
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/cadre-core/src/control-formation-recorder.ts
difficulty: hard
----

# Headless cadre responder fixture (in-process)

A new fixture module that boots a **real cadre-core `CadreNode` in the Playwright
Node process** (the same process that runs `global-setup`, like the existing
`globalThis.__referencePeer` handle) and acts as the dialable **second party** for
the live formation→convergence e2e. The browser tab is the *initiator* (it only
dials out and needs no relay); this responder is the *only* party that must be
dialable, so it listens on WebSocket and the browser dials it directly.

**Run in-process, do not spawn a child.** cadre-core runs fine in Node (the
integration tests boot `CadreNode` under vitest). An in-process node avoids the
TS-loader/child-process problems the optimystic `reference-peer.ts` fixture has,
and a long-lived handle survives the whole run via `globalThis` exactly like
`__referencePeer`. `global-setup` wiring + teardown is the sibling
`formation-convergence-e2e-wire-and-spec` ticket; this ticket delivers the module
and its API.

## Responsibilities

Model the Node node config (transports + storage) on
`packages/integration-tests/src/harness/test-party.ts` (`createTestNode` /
`createLibp2pNode`) and the responder wiring on
`strand-formation-e2e.integration.ts` Phase 2 (the `responderService` helper
~`:773`). Concretely, `startFormationResponder()` must:

1. **Boot a `CadreNode`** with Node transports — `tcp()` + `webSockets()` listening
   on `/ip4/127.0.0.1/tcp/0/ws` (an ephemeral WS port the browser can dial) — and a
   Node raw-storage provider (memory storage is fine; copy the harness's provider).
   Profile `'storage'` (a willing cohort holder/listener, matching the integration
   responder). No relay server is needed — the browser dials this node directly.
2. **Genesis-seed its authority**, mirroring `cadre-web.ts` `runAuthorityGenesis`:
   `authorityKeyFromLibp2p(privateKey)` → `controlDb.ensureAuthorityKey(publicKeyB64)`
   → `node.initializeSeedBootstrap(privateKeyB64)`.
3. **Create the closed host chat strand** byte-identically to the browser:
   `publishStrand(strandId, 'c', memberKey)` then
   `addStrand({ strandRow, sAppConfig: getChatSAppConfig(), mode: 'networked' })`.
   Import `getChatSAppConfig` / `CHAT_SAPP_ID` from `../../src/lib/chat-strand.js`
   — that module is framework-free (only `@serfab/cadre-core`), so a Node import is
   clean, and importing it (rather than re-declaring the schema) guarantees the
   **same signed `SAppConfig`** the browser uses, which is required for the browser
   to attach and the cohort to converge. **`mode:'networked'`** is mandatory (same
   reason as the app-hooks ticket).
4. **Wire consent + register the responder**: `initializeStrandSolicitation({
   formationUsageRecorder: new ControlFormationUsageRecorder(controlDb) })` (same as
   `cadre-web.ts` `ensureSolicitation`), which registers the `/sereus/formation/1.0.0`
   handler on the control node.
5. **Mint + publish the invitation bound to the host strand**:
   `createOpenInvitation(CHAT_SAPP_ID, expirationMs)` then
   `publishFormationInvite(token, CHAT_SAPP_ID, { strandId, expiresAtMs })`. The
   invitation embeds this node's control multiaddrs (its `/ws` addr) so a redeeming
   `formStrand` dials it. Also mint a **second, already-expired** invitation
   (`expirationMs` in the past) so the spec can exercise the invalid/expired-token
   path against a live responder.
6. **Seed convergence on cohort connect**: subscribe to the **strand-level**
   libp2p node's connection events; when a cohort peer connects, write a known seed
   message (`Member` + `Message`) into the strand. This ordering is load-bearing —
   a 2-member cohort commit needs a super-majority of 2 (both members), so the
   write only succeeds **after** the browser is a connected cohort member. (If an
   event subscription proves awkward, expose an explicit `seedMessage()` method the
   test calls after it confirms the connection; document whichever is used.)
7. **Observe browser→responder writes** (for the optional reverse-direction
   assertion): expose `readStrandMessages(): Promise<...>` so the test (or the
   wire ticket) can confirm a message the browser wrote converged back.
8. **Expose its FormationUsage state**: `readFormationUsage(): Promise<count/rows>`
   over the control DB, so the spec can assert a `FormationUsage` row was recorded
   on the responder after redemption (the browser cannot see the responder's
   control DB).

## API (consumed by `global-setup` in the wire ticket)

```ts
export interface FormationResponderHandle {
  encoded: string;                 // base64url OpenInvitation (valid)
  expiredEncoded: string;          // an already-expired invitation, for the negative test
  strandId: string;                // the host closed strand id
  controlMultiaddrs: string[];     // responder control-node /ws addrs (also embedded in `encoded`)
  strandMultiaddrs: string[];      // responder strand-node /ws addrs (the browser dials these for cohort connectivity)
  seededMessage: { id: string; content: string };  // the message the responder seeds on connect
  readStrandMessages(): Promise<Array<{ id: string; memberId: string; content: string }>>;
  readFormationUsage(): Promise<Array<{ token: string; useNumber: number; strandId: string | null }>>;
  stop(): Promise<void>;
}

export async function startFormationResponder(opts?: {
  expirationMs?: number;
}): Promise<FormationResponderHandle>;
```

`seededMessage` may be filled lazily (once a peer connects); if so, document that
the test must wait for the cohort connection before asserting it, and provide a
way to await/read the seeded id.

## Edge cases & interactions

- **sApp config drift = no convergence.** The responder MUST use the same signed `getChatSAppConfig()` as the browser (import it; do not re-declare the schema). A whitespace difference breaks the signature → `SchemaVerificationError` on the browser's attach, or a silent schema mismatch. Importing the shared module is the guard.
- **Quorum ordering.** Seeding before the browser connects either fails the commit (no super-majority) or lands only locally and never replicates. Seed strictly after a strand-cohort peer connects.
- **Ephemeral WS port.** Listen on `tcp/0/ws` and read back the bound multiaddr from `getMultiaddrs()`; do not hard-code a port (parallel runs / port clashes).
- **Two libp2p nodes, two addr sets.** The control node addr (formation dial, embedded in the invitation) and the strand node addr (cohort dial, returned as `strandMultiaddrs`) are different. Return both; do not conflate them.
- **Clean shutdown.** `stop()` must `node.stop()` and release storage so `global-teardown` leaves no dangling listeners/handles between runs.
- **Genesis idempotency / authority error.** If genesis fails, fail `startFormationResponder` loudly (unlike the browser's fail-soft path) — a responder with no authority cannot sign the invite or the host Strand row, so there is nothing to test.
- **Expired-invite minting.** The expired invitation must be a *well-formed* token that is simply past expiry (so the negative test exercises the expiry branch of redemption, not a decode error — the malformed-decode case is already covered by the solo `formation-rbac` spec).

## TODO

- [ ] Create `packages/reference-app-web/e2e/fixtures/formation-responder.ts` implementing `startFormationResponder` + `FormationResponderHandle`.
- [ ] Reuse the Node transports + memory storage provider from `integration-tests/src/harness/test-party.ts` (`createTestNode`/`createLibp2pNode`); import `getChatSAppConfig`/`CHAT_SAPP_ID` from `../../src/lib/chat-strand.js`.
- [ ] Implement genesis seeding, closed-strand creation (`mode:'networked'`), solicitation + `ControlFormationUsageRecorder`, valid + expired invitation minting, and seed-on-connect.
- [ ] Implement `readStrandMessages`, `readFormationUsage`, and `stop`.
- [ ] Add a tiny standalone Node smoke check (a temporary script or a `*.spec` under vitest, not Playwright) that calls `startFormationResponder()`, asserts a non-empty `encoded`, `strandMultiaddrs`, and a `FormationUsage`-capable control DB, then `stop()`s — to validate the fixture in isolation without the browser. Stream output with `2>&1 | tee`.
- [ ] `yarn workspace @serfab/reference-app-web build` (typecheck includes `e2e/`) and `yarn lint` on the new file — both green.
