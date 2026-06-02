description: Carry the caller's real invitation token + StrandFormationDisclosure and both parties' real cadre peer addrs end-to-end over libp2p, and make the initiator's response/database-result validation real. Port the formation transport into cadre-core (off the deprecated strand-proto) so consent gating, identity disclosure, and result validation actually function.
files: packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/canonical-json.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-solicitation.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/strand-proto/src/bootstrap.ts
----

# Strand formation: transmit real disclosure/token/cadre-addrs and validate results

The strand formation protocol is meant to gate strand creation on consent: a responder
publishes an invitation; an initiator dials in carrying that invitation's token **plus a
disclosed identity** (`StrandFormationDisclosure`); both parties validate each other before
a strand is provisioned. Today the disclosure and the real cadre peer addresses are never
carried end-to-end, the responder's `DisclosureValidator` is fed an empty token + a synthetic
`{ partyId }` bundle, and the initiator's result-validation hooks are stubbed to accept
everything. So consent gating, identity disclosure, and provisioning-result validation do not
function over the real libp2p transport.

## Reproduction (confirmed)

A unit-level repro over real libp2p (TCP) in `packages/cadre-core` proves it. Stand up a
responder `StrandSolicitationService` with a `DisclosureValidator` that *captures* what it
receives, have an initiator call `formStrand(invitation, { partyId, purpose }, node)`, then
assert the validator saw the real token + disclosure:

```
expect(receivedToken).toBe(invitation.token);              // FAILS: receivedToken === ''
expect(receivedDisclosure?.purpose).toBe(<sent purpose>);  // FAILS: gets { partyId: <sessionId> }
```

Result: `AssertionError: expected '' to be 'invite-…'`. The responder's `validateDisclosure`
hook is handed `token === ''` and a synthetic `{ partyId: <dialer sessionId> }` bundle instead
of the caller's real token and disclosure. (Run with
`yarn vitest run <spec> --reporter=verbose` from `packages/cadre-core`; ~0.5s.)

## Root cause (precise — note what already works)

- **The protocol-level `token` IS transmitted** and `validateToken` (→ `FormationUsageRecorder`)
  does receive the real token — this is why the E2E "reject reuse" test passes legitimately.
  Do **not** chase that as broken.
- **The disclosure is dropped.** `StrandFormationManager.formStrand`
  (`strand-formation-manager.ts:137-166`) converts the `OpenInvitation` to a `BootstrapLink`
  but has no way to inject the disclosure: strand-proto's `DialerSession.connectAndSend`
  (`packages/strand-proto/src/bootstrap.ts:339-344`) builds the contact message internally with
  a hardcoded `identityBundle: { partyId: this.sessionId }`. So the real
  `StrandFormationDisclosure` never reaches the wire.
- **The token is not bridged into identity validation.** `validateIdentity`
  (`strand-formation-manager.ts:203-217`) reads the token via `(identity as any)?.token ?? ''`
  — always `''`, because the token lives on the contact message's `token` field, not inside
  `identityBundle`. The strand-proto `SessionHooks.validateIdentity(identity, sessionId)`
  signature never passes the validated token alongside the identity.
- **Placeholder cadre addrs.** `ListenerSession.sendResponse` hardcodes
  `cadrePeerAddrs: ['cadre-a-1.local','cadre-a-2.local']` (`bootstrap.ts:264`) and
  `DialerSession.connectAndSend` hardcodes `['cadre-b-1.local','cadre-b-2.local']`
  (`bootstrap.ts:343`). The manager's real `cadrePeerAddrs` (from `StrandFormationManagerOptions`,
  populated by `CadreNode` via `getMultiaddrs()`) are never threaded into either message.
- **Initiator does no result validation.** `validateResponse` / `validateDatabaseResult`
  (`strand-formation-manager.ts:254-264`) unconditionally `return true`, and the hooks carry no
  per-session context (invitation/disclosure/expected strand) to validate against.

## Going-forward decision: port the transport into cadre-core

`strand-proto` is **deprecated** (`AGENTS.md`, `packages/strand-proto/README.md`). Fixing all
of the above by extending `strand-proto/src/bootstrap.ts` would mean (a) widening
`BootstrapLink`/`InboundContactMessage`/`SessionHooks` and the dialer/listener message
construction, then (b) deepening investment in a package we are retiring. The blast radius of
strand-proto inside the monorepo is tiny — it is consumed **only** by
`packages/cadre-core/src/strand-formation-manager.ts` (and type re-exports). `StrandSolicitationService`
and `CadreNode.formStrand` sit on top of `StrandFormationManager` and do not import strand-proto
directly.

**Therefore:** implement the formation transport natively in `cadre-core`, mirroring the
existing non-deprecated `seed-bootstrap.ts` protocol service (libp2p `node.handle`/`dialProtocol`,
length-prefixed JSON frames, a dedicated protocol id, small single-purpose session methods), and
rewrite `StrandFormationManager` to drive it directly from the cadre-core interfaces. Then drop
the `@serfab/strand-proto` dependency from `packages/cadre-core/package.json`. Keep the public
surface (`StrandSolicitationService`, `CadreNode.createOpenInvitation/formStrand/encodeInvitation`,
the `StrandFormationManager*` exports in `index.ts`) stable so callers and the E2E scenarios are
unaffected except where they now assert real behavior.

> Tradeoff documented: the alternative (patch `strand-proto/bootstrap.ts` in place) is fewer
> lines but invests in deprecated code and still requires the same signature widening. We choose
> the native port per the ticket's "account for where the formation transport actually lives
> going forward" directive and the repo's "don't worry about backwards compatibility yet" stance.
> If the implementer finds the port materially larger than expected, the minimal acceptable
> fallback is to patch strand-proto to (1) carry `identityBundle`=disclosure + real `cadrePeerAddrs`
> both directions, (2) pass the validated token into `validateIdentity`, and (3) give the dialer's
> response/db hooks the invitation context — but document why the port was deferred.

## Related work (no hard prereq)

`formationinvite-fix-curve-and-wire-consent` (implement/) also edits
`strand-solicitation.ts` and `strand-formation-manager.ts`, but at an orthogonal layer — it
fixes the `FormationInvite` ed25519 curve bug and wires the **control-DB** `FormationInvite` /
`FormationUsage` consent records. This ticket is purely the **libp2p transport** (carrying the
disclosure/token/cadre-addrs and validating results). The two are functionally independent and
land in either order; just reconcile edits to the two shared files if both are in flight.

## Target design (native cadre-core formation protocol)

New module `packages/cadre-core/src/strand-formation-protocol.ts` (pattern: `seed-bootstrap.ts`).

**Protocol id:** `/sereus/formation/1.0.0` (new, parallel to `/sereus/seed/1.0.0`). The old
`/sereus/bootstrap/1.0.0` lives in deprecated strand-proto; backward compat is not a concern.

**Wire messages** (length-prefixed JSON; reuse the framing approach in `seed-bootstrap.ts`):

```ts
// Initiator → Responder
interface FormationContactMessage {
  token: string;                          // real invitation token
  partyId: string;                        // initiator's member key (peer id)
  disclosure: StrandFormationDisclosure;  // the REAL disclosure, carried verbatim
  cadrePeerAddrs: string[];               // initiator's real multiaddrs
}

// Responder → Initiator (after token + disclosure validation)
interface FormationResultMessage {
  approved: boolean;
  reason?: string;                        // present iff approved === false
  partyId?: string;                       // responder's real partyId (disclosed only after validation)
  cadrePeerAddrs?: string[];              // responder's real multiaddrs (omitted on rejection)
  provisionResult?: {                     // present for responderCreates mode
    strand: { strandId: string; createdBy: 'initiator' | 'responder' };
    dbConnectionInfo: { endpoint: string; credentialsRef: string };
  };
}

// initiatorCreates mode only (NEW stream) — Initiator → Responder
interface FormationDatabaseMessage {
  strand: { strandId: string; createdBy: 'initiator' | 'responder' };
  dbConnectionInfo: { endpoint: string; credentialsRef: string };
}
```

Preserve strand-proto's two modes (`responderCreates` 2-message / `initiatorCreates` 3-message)
and the cadre-disclosure timing rule (responder discloses its cadre **only after** token +
identity validation; rejection discloses no responder cadre — see `docs/strand-proto.md`
"Security & Privacy"). The E2E scenarios exercise only `responderCreates`; `initiatorCreates`
may be retained structurally with a minimal/structural db-result validator.

**Responder side** (listener), driven by `StrandFormationManager`'s cadre-core deps:
- `FormationUsageRecorder.isTokenValid(token)` + `isTokenUsed(token)` gate the token (unchanged
  semantics; now wired through the native session).
- `DisclosureValidator.validateDisclosure(msg.token, msg.disclosure)` — now receives the **real**
  token and the **real** disclosure.
- `StrandProvisioner.provisionStrand(sAppId, initiatorKey, responderKey)` provisions; the
  response carries the responder's real `partyId` + `cadrePeerAddrs`.

**Initiator side** (dialer): build `FormationContactMessage` from the manager's inputs —
`token` from the invitation, `partyId` = the member key generated in
`StrandSolicitationService.formStrand` (already threaded as `disclosure.partyId`), `disclosure`
= the real disclosure, `cadrePeerAddrs` = the manager's real addrs. Then validate the response:

Add a cadre-core interface (symmetric to `DisclosureValidator`) so the initiator can perform a
real, app-pluggable check, with a built-in structural default:

```ts
// strand-solicitation.ts
export interface FormationResponseValidator {
  /** Validate the responder's result against the invitation/disclosure used to form the strand. */
  validateResponse(ctx: {
    invitation: OpenInvitation;
    disclosure: StrandFormationDisclosure;
    response: FormationResultMessage;       // responder identity + cadre + provisionResult
  }): Promise<boolean>;
  /** initiatorCreates mode: validate the strand/db result the responder echoes back. */
  validateDatabaseResult?(ctx: {
    invitation: OpenInvitation;
    expected: FormationDatabaseMessage;     // what the initiator provisioned
    received: unknown;
  }): Promise<boolean>;
}
```

The default `validateResponse` MUST reject when: not approved; `partyId` missing/empty;
`cadrePeerAddrs` missing/empty (and not the literal `cadre-*.local` placeholders);
`provisionResult` missing for `responderCreates`; `provisionResult.strand.strandId` missing; or
`provisionResult.strand.createdBy !== 'responder'` for `responderCreates`. The key behavioral
change: a responder that returns an arbitrary/empty `strandId` or omits its disclosed identity
must be **rejected**, not silently accepted. Thread the per-session invitation + disclosure into
this check (the manager owns one dialer session per `formStrand` call, so context is local — no
hook-signature gymnastics needed once the transport lives in cadre-core).

Wire `FormationResponseValidator` through `StrandSolicitationServiceOptions` →
`StrandFormationManagerOptions` (optional; default to the built-in structural validator).

## Validation / acceptance

- Promote the confirmed reproduction into a permanent test in
  `packages/cadre-core/test/strand-solicitation.spec.ts`: the responder's `validateDisclosure`
  receives `token === invitation.token` and the real `disclosure` (with `purpose`); the
  responder's `cadrePeerAddrs` reaching the initiator are the responder's real multiaddrs (not
  `cadre-*.local`); and a malicious/stub responder result (empty `strandId` or missing disclosed
  identity) is **rejected** by the initiator.
- Existing E2E scenarios in `strand-formation-e2e.integration.ts` must still pass. Test #3
  ("disclosure validation") currently leans on the synthetic `{ partyId: sessionId }` bundle and
  the comment "The identity bundle sent over the protocol contains { partyId: sessionId }" —
  update it to assert against the **real** disclosed `partyId`/`purpose` now that the disclosure
  is transmitted (e.g. an allowlist validator keyed on the real `disclosure.partyId`).
- `yarn build` and `yarn test` green in `packages/cadre-core`. Run the formation E2E in
  `packages/integration-tests` (`yarn vitest run src/scenarios/strand-formation-e2e.integration.ts`);
  stream output with `2>&1 | tee` per the long-validation rule.
- After dropping `@serfab/strand-proto` from cadre-core, confirm nothing else in cadre-core
  imports it (grep) and the type re-exports in `index.ts` still resolve (now from the native
  module).

## Key references

- `packages/cadre-core/src/strand-formation-manager.ts` — current bridge; `formStrand`
  (137-166), `createSessionHooks` `validateIdentity` (203-217), `validateResponse` /
  `validateDatabaseResult` stubs (254-264). Rewrite to drive the native protocol.
- `packages/cadre-core/src/strand-solicitation.ts` — `StrandSolicitationService`; member-key
  generation + `disclosure.partyId` threading (170-213); add `FormationResponseValidator` option.
- `packages/cadre-core/src/seed-bootstrap.ts` — **the pattern to mirror**: protocol id constant,
  `node.handle`/`dialProtocol`, length-prefixed frame helpers, `canonicalJson`, small session
  methods, debug logging.
- `packages/cadre-core/src/canonical-json.ts` — canonical JSON helper (reuse for stable framing).
- `packages/strand-proto/src/bootstrap.ts` — reference state machine (listener/dialer, modes,
  disclosure timing, timeouts) to port; the placeholder addrs (264, 343) and internal contact
  construction (339-344) are the defects.
- `docs/strand-proto.md` — protocol flows, message shapes, disclosure-timing security rules.
- `docs/architecture.md` "Strand Formation" (444-461) — update prose: formation transport now
  native in cadre-core, not via `strand-proto`. Also update the dependency mention (613, 788) and
  `packages/cadre-core/README.md:245`.

## TODO

### Phase 1 — Native transport
- Add `packages/cadre-core/src/strand-formation-protocol.ts`: protocol id `/sereus/formation/1.0.0`,
  `FormationContactMessage` / `FormationResultMessage` / `FormationDatabaseMessage`, listener +
  dialer session logic (both modes), length-prefixed framing + canonical JSON (reuse
  `seed-bootstrap.ts` helpers; refactor shared framing into a small util if it keeps things DRY),
  per-session timeouts, and small single-purpose methods. Avoid `any`; prefix unused args with `_`.
- Carry the **real** disclosure + token in the contact message; carry **real** `cadrePeerAddrs`
  both directions; remove all `cadre-*.local` placeholders.
- Enforce disclosure timing: validate token + disclosure before disclosing responder cadre /
  provisioning; on rejection, send `approved: false` + `reason` with no responder cadre.

### Phase 2 — Manager rewrite + validation
- Rewrite `StrandFormationManager` to use the native protocol instead of `@serfab/strand-proto`;
  keep its public constructor/options/method shapes. Pass the real disclosure into the dialer and
  the real `cadrePeerAddrs` into both sides.
- Bridge `DisclosureValidator.validateDisclosure(realToken, realDisclosure)` on the responder.
- Add `FormationResponseValidator` (interface in `strand-solicitation.ts`) + a built-in structural
  default; thread it through `StrandSolicitationServiceOptions` → `StrandFormationManagerOptions`;
  implement real `validateResponse` / `validateDatabaseResult` using per-session invitation +
  disclosure context (reject empty/placeholder/mismatched results).
- Remove `@serfab/strand-proto` from `packages/cadre-core/package.json`; update `index.ts`
  re-exports to come from the native module; grep-confirm no remaining cadre-core imports.

### Phase 3 — Tests + docs
- Add the permanent repro-derived tests to `strand-solicitation.spec.ts` (real token+disclosure
  received; real responder cadre addrs received; stub/malicious responder result rejected).
- Update E2E test #3 in `strand-formation-e2e.integration.ts` to assert real disclosed identity
  instead of the synthetic-bundle workaround.
- `yarn build` + `yarn test` in `packages/cadre-core`; run the formation E2E (stream with `tee`).
- Update `docs/architecture.md` (Strand Formation section + dependency mentions) and
  `packages/cadre-core/README.md` to reflect the native cadre-core formation transport.
