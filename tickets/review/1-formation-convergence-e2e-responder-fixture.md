description: Review the new headless test "second party" — an in-process cadre node that hands out a chat invitation and seeds a message — that lets an end-to-end test prove two parties really connect and sync.
prereq:
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/package.json, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/integration-tests/src/harness/test-party.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
difficulty: hard
----

# Review: headless cadre responder fixture (in-process)

## What was built

A single new module, `packages/reference-app-web/e2e/fixtures/formation-responder.ts`,
exporting `startFormationResponder()` + the `FormationResponderHandle` interface. It boots
a **real cadre-core `CadreNode` in the Playwright Node process** (the same process that runs
`global-setup`, like `globalThis.__referencePeer`) and acts as the dialable **second party**
for the live formation→convergence e2e. The browser tab is the initiator (dials out only,
no relay needed); this responder is the only dialable party, so it listens on WebSocket and
the browser dials it directly.

The module is **not yet wired into `global-setup`** — that plus the Playwright spec are the
sibling `formation-convergence-e2e-wire-and-spec` ticket. This ticket delivers the module +
its API only.

### Boot sequence (each step mirrors its named production path)

1. **`CadreNode`** — Node transports `[tcp(), webSockets()]` listening on
   `/ip4/127.0.0.1/tcp/0/ws` (ephemeral WS port), in-memory raw storage
   (`MemoryRawStorage`, copied from the integration harness), `profile: 'storage'`.
2. **Authority genesis** — `authorityKeyFromLibp2p(privateKey)` → `ensureAuthorityKey` →
   `initializeSeedBootstrap` (mirrors `cadre-web.ts` `runAuthorityGenesis`, but **fail-loud**:
   a responder with no authority can't sign the invite/host strand, so there is nothing to test).
3. **Consent wiring** — `initializeStrandSolicitation({ formationUsageRecorder: new
   ControlFormationUsageRecorder(controlDb) })` (registers `/sereus/formation/1.0.0`).
4. **Host closed strand** — `publishStrand(strandId, 'c', memberKey)` + `addStrand({ …,
   sAppConfig: getChatSAppConfig(), mode: 'networked' })`. It **imports** the shared signed
   `getChatSAppConfig`/`CHAT_SAPP_ID` from `../../src/lib/chat-strand.js` (does NOT re-declare
   the schema) so the SAppConfig signature is byte-identical to the browser's — the guard
   against the silent "schema drift → no convergence" failure.
5. **Invitations** — a valid `createOpenInvitation`+`publishFormationInvite` bound to the host
   strand, PLUS a second **already-expired** one (`createOpenInvitation(…, -60_000)` → past
   expiry; still a well-formed, decodable `FormationInvite` row, so the negative test hits the
   expiry branch, not a decode error).
6. **Seed-on-connect** — see "Seeding contract" below.

### API (consumed by the wire ticket)

Matches the ticket's interface, with **one documented addition**: `seedMessage(): Promise<{id;content}>`.

```ts
export interface FormationResponderHandle {
  encoded: string;            // base64url OpenInvitation (valid)
  expiredEncoded: string;     // already-expired invitation (negative test)
  strandId: string;           // host closed strand id
  controlMultiaddrs: string[];// responder CONTROL node /ws addrs (also embedded in `encoded`)
  strandMultiaddrs: string[]; // responder STRAND node /ws addrs (browser dials these for cohort)
  seededMessage: { id: string; content: string }; // content fixed at boot; id filled lazily
  seedMessage(): Promise<{ id: string; content: string }>; // explicit, idempotent seed
  readStrandMessages(): Promise<Array<{ id; memberId; content }>>;
  readFormationUsage(): Promise<Array<{ token; useNumber; strandId: string | null }>>;
  stop(): Promise<void>;
}
export async function startFormationResponder(opts?: { expirationMs?: number }): Promise<FormationResponderHandle>;
```

### Seeding contract (important for the wire ticket)

Quorum ordering is load-bearing: a 2-member cohort commit needs a super-majority of 2 (both
members), so the seed write only succeeds **after** the browser is a connected cohort member.

- **Deterministic path (use this):** the wire spec should poll the browser's
  `__cadre.getStrandConnectionCount(strandId)` until ≥ 1, **then** `await handle.seedMessage()`
  and read `seed.id`. `seedMessage()` is single-flight (writes at most one message) and does
  NOT cache a rejection — a premature attempt before the cohort is ready is retried by the
  next call.
- **Backstop:** a `connection:open` listener on the strand node also calls the same idempotent
  `ensureSeeded()`. It's best-effort only (covers a spec that forgets to call `seedMessage()`);
  do not rely on it for timing.
- `seededMessage.content` is known from boot; `seededMessage.id` is `''` until a seed lands.
  Read the id only after awaiting `seedMessage()` (or after confirming convergence).

## Validation performed

All green:

- **e2e typecheck** — `cd packages/reference-app-web && npx tsc --noEmit -p tsconfig.e2e.json`
  (this is what actually typechecks the fixture; note the package `build` script's `tsc`
  step uses `tsconfig.json`, which includes only `src/`, so `build` does **not** cover `e2e/`
  despite the ticket's wording — the e2e tsconfig is the real gate and it passes).
- **build** — `yarn workspace @serfab/reference-app-web build` (tsc src + `vite build`) passes.
  The vite warnings (`node:crypto`/`node:http2` externalized in cadre-core push-notifier;
  db-p2p dynamic-import chunking; >500 kB chunk) are pre-existing and unrelated to this change.
- **lint** — `npx eslint packages/reference-app-web/e2e/fixtures/formation-responder.ts` clean.
- **Smoke (TEMPORARY, then deleted):** a vitest spec under `integration-tests` (which has
  vitest + node env + the libp2p/cadre deps) drove the fixture in two cases — both passed:
  1. *Isolation:* boot → non-empty `encoded`/`expiredEncoded` (distinct), `/ws`
     control+strand addrs (distinct sets), `seededMessage.content` set / `id` empty,
     `readFormationUsage()` empty, `readStrandMessages()` empty → `stop()`.
  2. *Full convergence:* a second in-process `CadreNode` (transaction profile) decoded the
     invite, `formStrand` **rejected** the expired one and **redeemed** the valid one
     (returned `strandId === handle.strandId` + a `memberPrivateKey`), the responder recorded
     exactly one `FormationUsage` row, the initiator `addStrand`(closed)+dialed
     `strandMultiaddrs[0]` → cohort connected → `handle.seedMessage()` → the seed id
     **converged** to the initiator's strand DB (~264 ms).

  The smoke was **deleted** (it created an undesirable permanent cross-package import:
  `integration-tests` → `reference-app-web` e2e fixture + src). To re-run, recreate
  `packages/integration-tests/src/scenarios/formation-responder-smoke.spec.ts` importing
  `startFormationResponder` from `../../../reference-app-web/e2e/fixtures/formation-responder.js`
  and run `cd packages/integration-tests && npx vitest run src/scenarios/formation-responder-smoke.spec.ts`
  (requires `@serfab/cadre-core` + `@serfab/quereus-plugin-sereus` built — see below).

## Things the reviewer should scrutinize / known gaps

- **NOT yet browser-validated.** The only end-to-end proof so far is in-process node↔node
  (the deleted smoke). The real browser-initiator path is the wire ticket's Playwright spec;
  treat that as the true acceptance gate. Schema-drift, transport-brand, and relay-free
  dialability assumptions are validated only as far as a Node initiator exercises them.
- **`tcp()` is effectively inert here.** The node listens only on `/ws`, and it dials nobody,
  so the TCP transport never gets a `/tcp` listen addr and does no work. It's included to
  follow the ticket literally and match the harness; `webSockets()` alone would be functionally
  equivalent and would drop the new dependency. Reviewer's call whether to simplify.
- **New dependency:** `@libp2p/tcp@^11.0.10` added to `reference-app-web` **devDependencies**
  (already in the lockfile via cadre-core; `yarn install` synced it — `package.json` + `yarn.lock`
  are the only non-fixture diffs). If `tcp()` is dropped per the point above, drop this too.
- **Build state:** the working tree was clean (no `dist/`), so `@serfab/quereus-plugin-sereus`
  then `@serfab/cadre-core` were built to satisfy `vite build` + the smoke. `dist/` is
  gitignored, so those artifacts are not part of the diff.
- **`seededMessage` mutates in place.** It's returned by reference and its `id` is filled on
  seed. Consumers reading the same handle object see the update; a consumer that copies
  `{...seededMessage}` early will see a stale empty id. Documented in the JSDoc.
- **`seedMessage()` timeout** is 20 s (a never-connecting cohort fails loudly rather than
  hanging Playwright). Confirm that's comfortably inside the wire spec's own timeout budget.
- **Profile is `storage`** (matches the integration responder) → `enableRelay` defaults true
  and ring-zulu is on. Harmless for a directly-dialed responder, but flag if the reviewer
  expects a leaner transaction-profile responder.

## Suggested review use-cases

- Confirm `getChatSAppConfig()` is the imported shared config on BOTH the fixture and the
  browser (grep that no schema string is re-declared in the fixture).
- Confirm control vs strand addr sets are never conflated (`controlMultiaddrs` from
  `node.getMultiaddrs()`; `strandMultiaddrs` from `getStrand(strandId).libp2pNode`).
- Confirm `stop()` removes the connection listener and stops the node (no dangling handles
  for `global-teardown`).
- Confirm the expired invite is well-formed (decodes) and rejected on the expiry branch.
