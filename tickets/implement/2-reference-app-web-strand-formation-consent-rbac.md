----
description: Exercise the consent/invitation strand-formation flow, closed-strand membership, and authority/consent gating ("RBAC") in the browser reference, plus cross-node/cross-party convergence
prereq: reference-app-web-cadre-node-and-strand
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/README.md, packages/reference-app-web/e2e/global-setup.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/integration-tests/src/scenarios, docs/architecture.md
----

# Phase 2 — consent/invitation formation, closed strands, and RBAC in the browser

Phase 1 (`reference-app-web-cadre-node-and-strand`) brings up a `CadreNode`,
the control network, and an **open** strand created directly via `addStrand`
with a signed sApp schema. That covers `CadreNode` + control network + schema
signature, but it does **not** exercise the parts of the ticket that say "form
or join a `StrandInstance` through the consent/invitation flow … and exercise
role-based permissions." This phase closes that gap.

Phase 2 goes **beyond** the RN reference's current coverage — RN also stops at
direct open-strand creation and does not drive the invitation/`formStrand`
protocol. So this is genuinely new reference surface; treat the cadre-core
formation API (`createOpenInvitation`/`formStrand`) and the `CadreControl`
constraint model as the contract, and make the browser the first reference that
drives them end-to-end.

## What "RBAC" means here (scope it honestly)

There is no app-level role engine in cadre-core today. "Role-based permissions"
in this system is the **authorization model enforced by the `CadreControl`
schema constraints** plus **strand membership** (`control-database.ts:19-115`):

- `AuthorityKey` / `ValidationKey` rows gate who may make control changes —
  inserts are signable only by genesis or an existing authority.
- `CadrePeer` insert/delete requires an authority signature; multiaddr update is
  self-sign or authority-sign.
- `Strand` inserts are authorized either by an authority **or** by a valid
  `FormationUsage` row (indirect consent via a consumed `FormationInvite`).
- Closed strands (`Type: 'c'`) require a member private key
  (`StrandRow.MemberPrivateKey`); open strands (`Type: 'o'`) do not.

So "exercise RBAC" = **demonstrate these gates working and failing**: an
unauthorized control write is rejected; a strand join via a valid invitation
token succeeds and is recorded in `FormationUsage`; an invalid/expired token is
rejected; a closed strand requires the member key. Do **not** invent a parallel
role system — surface the gates the schema already enforces. If, during
implementation, a richer app-level RBAC notion is wanted, park it as a new
`backlog/` ticket rather than growing this one.

## Topology: two parties in a browser-only demo

Strand formation is between **two parties** (responder holds the
`FormationInvite`; initiator calls `formStrand` with the token + disclosure).
In a browser-only reference this requires two distinct cadres. Decide and
document the demo topology (the implementer's call — both are viable):

- **Two browser tabs, two parties**: tab A is party A (responder), tab B is
  party B (initiator). The `OpenInvitation` is moved out-of-band by
  copy/paste (use `encodeInvitation`/`decodeInvitation` —
  `cadre-node.ts:1019-1038`). Each tab needs to be dialable through a relay, so
  set `listenAddrs: ['/p2p-circuit','/webrtc']` and reserve a relay slot (same
  circuit-relay plumbing the old distributed Optimystic mode used). Requires a
  service-peer relay fixture, like Phase-1's removed Tier-2 setup.
- **Browser (initiator) ↔ node (responder)**: a `cadre-cli`/integration-test
  node holds the invite and the browser tab forms against it. Simpler to script
  in e2e (the node side is headless and deterministic) and reuses the
  reference-peer-style fixture pattern in `e2e/global-setup.ts`.

Recommended: build the **browser↔node** path first (deterministic, e2e-able),
then layer the two-tab path on top if time allows. Document whichever ships.

## Formation flow (API contract)

Responder side:
```typescript
node.initializeStrandSolicitation();                         // cadre-node.ts:939-953
const invitation = await node.createOpenInvitation(sAppId, expirationMs);  // :969-988
const encoded = node.encodeInvitation(invitation);           // copy/paste out-of-band
```
Initiator side:
```typescript
node.initializeStrandSolicitation();
const invitation = node.decodeInvitation(encoded);
const result = await node.formStrand(invitation, { partyId, purpose });  // :997-1014
// result: { memberKey, invitePrivateKey, strandId }
await node.addStrand({
  strandRow: { Id: result.strandId, MemberPrivateKey: result.invitePrivateKey, Type: 'c' },
  sAppConfig,                                                 // same signed chat schema
});
```
> Heads-up: cadre-core's invitation/consent wiring is itself being hardened by
> `formationinvite-fix-curve-and-wire-consent` (also in `implement/`). It is not
> listed as a `prereq:` here only because it is unnumbered and this ticket is
> sequence-2 (the runner rejects an unnumbered prereq under a numbered
> dependent). Design as if its fixes have landed; if `createOpenInvitation` /
> `formStrand` behave differently than this ticket assumes, defer to the
> shipped cadre-core API.

The responder validates the token against `FormationInvite`, validates the
`StrandFormationDisclosure`, records `FormationUsage`, provisions the strand
(`responderCreates`), and only then reveals its identity + cadre addresses
(disclosure timing — `docs/architecture.md` "Strand Formation"). Both sides end
with a `Strand` row → both participate. Read
`strand-formation-manager.ts` / `strand-formation-protocol.ts` for the exact
wire steps before wiring the UI.

## Cross-node / cross-party convergence (re-establish Tier-2)

Phase 1 disabled the old membership-free two-tab Optimystic convergence test.
Re-establish convergence on the cadre path: once two parties share a closed
strand (via formation), a message written in one converges to the other through
the strand cohort. Update `e2e/global-setup.ts` and the Tier-2 specs to spawn
the responder (node fixture or second tab + relay), drive `formStrand`, then
assert a chat message replicates across the cohort with bounded waits — the
cadre analogue of the message-convergence test the README documents.

## UI

- **Home / network panel**: replace the repurposed/disabled Phase-1 bootstrap
  input with a formation panel — "Create invitation" (responder, shows the
  encoded invitation to copy) and "Join via invitation" (initiator, paste +
  `formStrand`). Show the resulting strand id and membership type.
- **Diagnostics**: add control-network authorization state — `AuthorityKey` /
  `ValidationKey` presence, `FormationInvite` / `FormationUsage` rows, and per
  strand the membership type (open vs closed) and member-key presence — so the
  RBAC/consent gates are observable.

## Docs

Update `README.md` and `docs/architecture.md`: the browser reference now drives
the full consent/invitation formation path and demonstrates the `CadreControl`
authorization gates; remove the Phase-1 "forthcoming" caveats for these items.

## Key tests (TDD intent — expected outputs)

- **Happy-path formation (e2e Tier 2)**: responder creates invitation →
  initiator `formStrand` with the token → both reach an `active` closed strand
  with the same `strandId` → a message written by one replicates to the other.
  Expected: `FormationUsage` row recorded on the responder; both
  `StrandInstance.status === 'active'`; replicated `App.Message` row within the
  bounded wait.
- **Invalid/expired token rejected**: `formStrand` with a bad or expired token
  fails; no `FormationUsage` row; no strand provisioned, no identity disclosed.
- **Authority gate**: a control write attempted without authority signature is
  rejected by the `CadreControl` constraints (assert the failure surfaces; this
  is the "RBAC" demonstration). A new `backlog/` ticket may be filed if a
  cleaner UI affordance for showing the rejection is wanted.
- **Closed-strand membership**: joining a `Type: 'c'` strand without the member
  key fails; with `result.invitePrivateKey` it succeeds.
- **Build/typecheck**: `yarn workspace @serfab/reference-app-web typecheck` +
  `build` pass (stream with `tee`).

## TODO

### Formation wiring
- [ ] Add formation lifecycle to `cadre-web.ts`: `initializeStrandSolicitation`, `createOpenInvitation`/`encodeInvitation` (responder), `decodeInvitation`/`formStrand` + closed-strand `addStrand` (initiator). Set `listenAddrs`/relay reservation for the dialable side.
- [ ] Decide + implement the demo topology (browser↔node first; optional two-tab+relay). Document the choice in the README.
- [ ] Formation UI on Home: create-invitation and join-via-invitation panels with copy/paste encoded invitations; show resulting strand id + membership type.

### RBAC / consent observability
- [ ] Diagnostics: control-network authorization state (`AuthorityKey`/`ValidationKey`/`FormationInvite`/`FormationUsage`) and per-strand membership type + member-key presence.
- [ ] Surface authority-gate rejection and invalid-token rejection in the UI/error log.

### Convergence + tests + docs
- [ ] Re-establish Tier-2 convergence on the cadre path: update `e2e/global-setup.ts` fixture (responder node or second tab + relay), drive `formStrand`, assert cross-cohort message replication with bounded waits.
- [ ] Add the happy-path formation, invalid-token, authority-gate, and closed-strand-membership tests above.
- [ ] Update `README.md` + `docs/architecture.md`; remove Phase-1 "forthcoming" caveats for formation/RBAC.
- [ ] Run `typecheck` + `build` (stream with `tee`); run e2e where a Chromium/fixture is available, else document CI handling. Flag any out-of-diff failures via `tickets/.pre-existing-error.md`.
