description: A headless in-process "second party" for the browser end-to-end test — a real cadre node that hands out a chat invitation and seeds a message so the test can prove two parties connect and sync. Reviewed and accepted with one cleanup.
prereq:
files: packages/reference-app-web/e2e/fixtures/formation-responder.ts, packages/reference-app-web/package.json, yarn.lock, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/chat-dml.ts, packages/reference-app-web/src/lib/cadre-web.ts
----

# Complete: headless cadre responder fixture (in-process)

## What shipped

`packages/reference-app-web/e2e/fixtures/formation-responder.ts` — `startFormationResponder()`
+ `FormationResponderHandle`. Boots a real cadre-core `CadreNode` in the Playwright Node
process as the dialable second party for the live formation→convergence e2e: authority
genesis → formation responder wiring (`ControlFormationUsageRecorder`) → host closed chat
strand (shared signed `getChatSAppConfig`, `mode:'networked'`) → a valid + an already-expired
`OpenInvitation` → idempotent single-flight seed-on-connect.

The module is intentionally **not yet wired** into `global-setup`; that + the Playwright spec
are the sibling `formation-convergence-e2e-wire-and-spec` ticket. This ticket delivered the
module and its API only, and that scope split is sound.

## Review findings

### Verified correct (no change needed)

- **API surface** — every `CadreNode` call (`getControlDatabase`, `ensureAuthorityKey`,
  `initializeSeedBootstrap`, `initializeStrandSolicitation`, `publishStrand`, `addStrand`,
  `getStrand`, `createOpenInvitation`, `publishFormationInvite`, `encodeInvitation`,
  `getMultiaddrs`) exists with matching signatures (`cadre-node.ts`).
- **Schema-drift guard** — fixture imports the shared `getChatSAppConfig` / `CHAT_SAPP_ID`
  from `src/lib/chat-strand.ts`; it does NOT re-declare the schema, so the SAppConfig
  signature is byte-identical to the browser's. Host strand bring-up
  (`publishStrand 'c'` + `addStrand … mode:'networked'`) matches `cadre-web.ts`
  `createClosedChatStrand` exactly.
- **Expired invite is well-formed** — `createOpenInvitation(sAppId, -60_000)` resolves to
  `new Date(Date.now() - 60_000)` (`strand-solicitation.ts:380`), a decodable
  `OpenInvitation` with a past expiry, so the negative test hits the expiry branch, not a
  decode error. `publishFormationInvite` accepts a past `expiresAtMs` (no insert-time
  validation), so the row is real.
- **Solicitation ordering** — `initializeStrandSolicitation({ recorder })` runs *before*
  `createOpenInvitation`, so the lazy-init in `createOpenInvitation` never silently creates
  a recorder-less service. Matches `cadre-web.ts` `ensureSolicitation`-first ordering.
- **Seed single-flight** — `ensureSeeded` writes at most once, does not cache a rejection
  (resets `seedPromise` to `null` on throw so a premature pre-cohort call is retried), and
  `seedWithTimeout` attaches a rejection handler to the inner promise so a post-timeout
  settle produces no unhandled rejection. Logic is correct.
- **Resource cleanup** — `stop()` removes the `connection:open` listener then stops the node;
  the bring-up `catch` stops the node on partial-boot failure. No dangling handles for
  `global-teardown`. `connection:open` is a real libp2p event (also used in
  `src/lib/diagnostics.svelte.ts`).
- **Dependency direction** — nothing in `src/` imports the fixture (fixture → `src`, never
  the reverse); confirmed by grep.
- **Type safety** — no `any`; the `as`-casts on Quereus row reads match the established
  `cadre-web.ts` pattern.

### Fixed in this pass (minor)

- **Dropped the inert `tcp()` transport + `@libp2p/tcp` devDependency.** The implementer
  flagged it: the responder listens only on `/ws` and dials nobody, so TCP did no work (even
  the implementer's deleted node↔node smoke dialed the `/ws` addr). The responder's only
  client is the browser, whose own stack carries no TCP (see `cadre-web.ts` + the
  README "Transports" note). `responderTransports()` is now `[webSockets()]`, the
  `@libp2p/tcp` devDependency and its single `yarn.lock` line were removed, and the
  doc comments that said "Node transports / TCP + WebSocket" were corrected. Re-validated
  green (below). This reverts the only non-fixture diffs the implement commit introduced,
  leaving the responder's transport story aligned with the browser's.

### Known gaps — deferred to the wire ticket (not defects)

- **No automated test exercises the fixture in this ticket.** The implementer's smoke was
  deleted because it created a permanent cross-package import
  (`integration-tests` → `reference-app-web` e2e fixture). That deletion was the right call:
  `reference-app-web` has no node-env unit runner (only Playwright), so there is no clean
  in-package home for a unit test, and re-adding the integration-tests smoke would reintroduce
  exactly that unwanted edge. The fixture's true acceptance gate is the
  `formation-convergence-e2e-wire-and-spec` Playwright spec — which **must** cover: cohort
  connect → `seedMessage()` → seed id converges to the browser strand; the valid invite
  redeems and the expired invite is rejected on the expiry branch; control vs strand addr
  sets stay distinct; `stop()` leaves no dangling handles.
- **`seedMessage()` 20 s timeout** must sit comfortably inside the wire spec's own timeout
  budget (a never-connecting cohort fails loud rather than hanging Playwright). The wire
  ticket owns confirming this.
- **Browser-path assumptions** (transport-brand, relay-free dialability, schema parity) are
  proven only as far as a Node initiator exercised them in the deleted smoke; the
  browser-initiator run is the wire ticket's responsibility.

These are all correctly the downstream ticket's scope; none blocks acceptance of the module.

## Validation (all green, post-fix)

- e2e typecheck — `npx tsc --noEmit -p tsconfig.e2e.json` (the real gate for `e2e/`; the
  package `build`'s `tsc` covers only `src/`).
- lint — `npx eslint e2e/fixtures/formation-responder.ts`.
- build — `yarn workspace @serfab/reference-app-web build` (tsc src + vite build). The vite
  warnings (`node:crypto`/`node:http2` externalized in cadre-core push-notifier; db-p2p
  dynamic-import chunking; >500 kB chunk) are pre-existing and unrelated.
- lockfile — `yarn install --immutable` passes, confirming `package.json` ↔ `yarn.lock`
  consistency after the dependency removal.

## End
