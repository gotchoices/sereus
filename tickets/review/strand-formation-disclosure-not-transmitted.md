description: Review the native cadre-core strand-formation transport that replaces deprecated strand-proto — verify the real disclosure/token/cadre-addrs are carried end-to-end, responder identity is disclosed only after validation, and the initiator's result validation actually rejects empty/placeholder/mismatched responder results.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-solicitation.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/architecture.md, packages/cadre-core/README.md
----

# Review: native strand-formation transport (disclosure/token/cadre-addrs + result validation)

## What changed (implementation summary)

The strand-formation transport was ported off the **deprecated `@serfab/strand-proto`** into a
**native cadre-core protocol service**, mirroring `seed-bootstrap.ts` (dedicated protocol id,
length-prefixed JSON frames over libp2p streams, small single-purpose session helpers). The port
fixes the four defects from the source ticket: the disclosure was dropped, the token was never
bridged into identity validation, both parties' cadre addrs were hardcoded placeholders
(`cadre-*.local`), and the initiator's result validation was stubbed to accept everything.

New module: **`packages/cadre-core/src/strand-formation-protocol.ts`**
- Protocol id `/sereus/formation/1.0.0`.
- Wire messages `FormationContactMessage` (token + partyId + **real** `disclosure` + initiator
  `cadrePeerAddrs`), `FormationResultMessage` (approval + responder identity/cadre + provisionResult),
  `FormationDatabaseMessage`.
- `FormationListener` (responder): registers the libp2p handler; per stream runs token →
  disclosure validation → provision → result. Enforces **cadre-disclosure timing** — responder
  identity/cadre disclosed only *after* both validations pass; a rejection sends `approved:false`
  + reason and **no** responder cadre.
- `dialFormation` (initiator): dials, sends contact, validates the response, returns the
  provisionResult. (initiatorCreates: provisions locally and echoes the strand back.)
- `isValidResponderCreatesResult(response)`: the structural floor used by the default validator.
- `FrameReader`: reads exactly one length-prefixed frame at a time (formation is request/response
  on a single live stream, so it cannot read-to-EOF like seed delivery does).

Rewrote **`strand-formation-manager.ts`** to drive the native protocol (public
constructor/options/method shapes preserved). The manager now also threads the **real**
`cadrePeerAddrs` into both sides and the real disclosure into the contact.

Added to **`strand-solicitation.ts`**: `FormationResponseValidator` interface +
`createDefaultFormationResponseValidator()` (built-in structural default), wired through
`StrandSolicitationServiceOptions` → `StrandFormationManagerOptions`.

Dropped `@serfab/strand-proto` from `packages/cadre-core/package.json`; updated `index.ts`
re-exports to come from the native module; ran `yarn install` to reconcile the lockfile. Updated
`docs/architecture.md` and `packages/cadre-core/README.md`.

## How it works (use cases / behavior to validate)

- **Responder side** (`StrandSolicitationService.registerResponder(node)`): on an inbound
  formation stream, `FormationUsageRecorder.isTokenValid/isTokenUsed` gate the token, then
  `DisclosureValidator.validateDisclosure(realToken, realDisclosure)` receives the **caller's
  real token and disclosure** (previously `''` + `{ partyId: sessionId }`). Only after both pass
  does the responder disclose its real `partyId` + `cadrePeerAddrs` and provision via
  `StrandProvisioner.provisionStrand('', initiatorKey, responderKey)`.
- **Initiator side** (`formStrand(invitation, disclosure, node)`): builds the contact from the
  invitation token + the member-key (threaded as `disclosure.partyId`) + the manager's real
  `cadrePeerAddrs`, then validates the responder's result. Default validator **rejects** when:
  not approved; `partyId` missing; `cadrePeerAddrs` missing/empty or a `cadre-*.local`
  placeholder; `provisionResult` missing; `strand.strandId` empty; or `strand.createdBy !==
  'responder'`. Apps can supply a stricter `FormationResponseValidator`.

## Tests (a floor, not a ceiling — see gaps below)

Added permanent repro-derived tests in `test/strand-solicitation.spec.ts`
(`describe('StrandFormationManager transport: real disclosure + result validation')`):
- responder's `validateDisclosure` receives `token === invitation.token` and the real disclosure
  (`purpose`, and `partyId === result.memberKey`);
- responder's **real** cadre addrs reach the initiator (asserted via a capturing
  `FormationResponseValidator`; no `.local` placeholders);
- a responder returning an **empty `strandId`** is rejected;
- a responder disclosing **no cadre addresses** is rejected.

Also updated the existing **"multiple concurrent formations"** spec to give the responder real
`cadrePeerAddrs` (now required, since the initiator rejects empty/placeholder responder cadre),
and rewrote **E2E test #3** to assert the **real disclosed identity** (allowlist keyed on the real
`disclosure.purpose`; asserts the real token + member-key `partyId` arrive) instead of the old
synthetic-`{ partyId: sessionId }` workaround.

### Commands run (all green)
- `yarn workspace @serfab/cadre-core build` → exit 0.
- `yarn workspace @serfab/cadre-core test` → **156 passed** (incl. 17 in `strand-solicitation.spec.ts`).
- `yarn workspace @serfab/integration-tests exec vitest run src/scenarios/strand-formation-e2e.integration.ts`
  → **6 passed** (Phase 1 protocol + Phase 2 lifecycle/replication, incl. rewritten test #3).
- `yarn install` → exit 0 (lockfile reconciled after dropping the dep).

## Known gaps / things to scrutinize (treat my work as a starting point)

- **`initiatorCreates` mode is structural-only and unverified over the wire.** The manager always
  uses `responderCreates`; no test exercises `initiatorCreates`. I deliberately kept the db-result
  echo on the **same** stream (the deprecated strand-proto opened a *new* stream and thereby lost
  session correlation — see the comment in `strand-formation-protocol.ts`). This path is plausibly
  correct but untested; confirm the design choice or add coverage.
- **Behavioral change worth confirming across callers:** a responder configured **without**
  `cadrePeerAddrs` will now have its initiators *reject* the formation (empty cadre fails the
  structural default). `CadreNode.initializeStrandSolicitation` sets `cadrePeerAddrs =
  this.getMultiaddrs()`, so verify a control node always has non-empty dialable multiaddrs when
  acting as responder (NAT'd/relay-only responders could regress here). The
  `inviteAddressResolver` substitution used by seed invites is **not** applied to formation cadre
  addrs — consider whether it should be.
- **Registration is not awaited:** `FormationListener.register` calls `void node.handle(...)`
  (mirrors `seed-bootstrap.ts`). Tests pass because `createOpenInvitation` awaits before dialing,
  but tight-timing callers could race the handler registration.
- **`sAppId` is still `''`** into `StrandProvisioner.provisionStrand` (unchanged from before — the
  invitation's `sAppId` is not threaded to the responder). The related implement ticket
  `formationinvite-fix-curve-and-wire-consent` wires the control-DB consent records (orthogonal
  layer, same two shared files); reconcile if both land.
- **Wire framing uses plain `JSON.stringify`** (not `canonicalJson`), matching seed-bootstrap's
  wire path — nothing is signed at the transport layer, and arbitrary app `identityBundle`/
  `metadata` serialize more leniently this way. Confirm that's acceptable (the ticket mentioned
  canonicalJson as an option).
- **`strand-proto` package remains in the monorepo** (deprecated, still listed in the root `pub`
  script and documented by `docs/strand-proto.md`); only cadre-core's dependency was removed.
- **`FrameReader` reallocates on each chunk append** (fine for small formation messages; not
  hardened for adversarial many-tiny-chunk inputs the way a streaming parser would be).

## Suggested review focus

1. Disclosure-timing correctness on every rejection path in `FormationListener.runSession`
   (token-invalid, disclosure-invalid, max-concurrent) — confirm **no** responder cadre leaks.
2. The default `FormationResponseValidator` rejection matrix vs. the ticket's required matrix.
3. Stream lifecycle / close ordering between `dialFormation` and `FormationListener` (no
   truncated reads, no leaked streams under the concurrent path).
4. The `initiatorCreates` same-stream design decision.
