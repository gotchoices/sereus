description: Review the two responder-side strand-formation fixes — single-use enforcement on the responder-provisions (unbound-invite) fallback via an atomic provisionAndRecord, and a clean protocol rejection (instead of a thrown insert + dropped frame) when a bound invite names a missing/unconverged host strand. Plumbed through a new ResponderProvisionOutcome rejection channel with a best-effort internal-error backstop.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
----

# Review: responder formation — record usage on the fallback + reject a missing bound strand

Implements the plan ticket of the same name. Two coupled responder-provisioning gaps on
`StrandFormationManager`, both flowing through `provisionAsResponder`, landed as one change.
Picked **option (a)** for gap 1 (record usage on the fallback) over (b) (remove the fallback),
exactly as the plan resolved.

## What changed (by file)

- **`strand-formation-protocol.ts`**
  - New exported `ResponderProvisionOutcome = { approved:true; result } | { approved:false; reason }`.
  - `FormationListenerOptions.provisionStrand` now returns `Promise<ResponderProvisionOutcome>`.
  - `runSession` rewritten: the `responderCreates` branch writes a **non-disclosing** rejection
    frame on `approved:false` (no `partyId`/`cadrePeerAddrs`), and `getResponderIdentity()` is now
    read only on the approval path. A `try/catch` wraps the whole session: if an unexpected error
    escapes **before any frame is written**, a best-effort `{ approved:false, reason:'Internal
    formation error' }` frame is sent before close (then re-thrown so `handleStream` still logs).
    A `wroteFrame` flag prevents a second frame after the `initiatorCreates` approval.

- **`strand-solicitation.ts`**
  - `resolveStrand?` return type replaced with the exported discriminated union
    `ResolvedHostStrand = { kind:'unbound' } | { kind:'bound'; strandId; memberPrivateKey } |
    { kind:'missing'; strandId }` (was `{ strandId, memberPrivateKey } | null`, which conflated
    bound-present with bound-missing).
  - New optional `provisionAndRecord?(token, initiatorKey, sAppId)` on `FormationUsageRecorder`.

- **`control-formation-recorder.ts`**
  - `resolveStrand` now distinguishes `bound` (strand row present) from `missing` (invite has a
    `StrandId` but no `Strand` row) via `queryStrand`; no invite / no `StrandId` → `unbound`.
  - New `provisionAndRecord`: mints a fresh strand id `strand-${randomBytes(128,'hex')}` (the same
    cross-platform CSPRNG `control-database`'s `generateStampId` uses — **not** `randomUUID`/`Date.now`/
    `Math.random`) and delegates to `ControlDatabase.redeemInvitation({ token, strandId, type:'o',
    peerId })`, whose single transaction inserts the consent-authorized `Strand` + the `FormationUsage`
    row together. Returns `{ strandId, memberPrivateKey:null }` (open strand). `sAppId` accepted but
    not threaded into the strand row (documented).
  - Class doc updated to describe both bound (record-only) and unbound (atomic create+record) shapes.

- **`strand-formation-manager.ts`**
  - `provisionAsResponder` returns `ResponderProvisionOutcome`, routing on `ResolvedHostStrand.kind`:
    `bound` → `recordUsage` + approve (with membership key); `missing` → clean reject
    (`'Host strand not yet available on this responder'`, **no usage row, no disclosure**);
    `unbound` → `provisionUnbound`. A `try/catch` around the switch maps known provisioning/redeem
    failures (incl. the concurrent `(Token,UseNumber)` PK collision) to a logged
    `{ approved:false, reason:'Formation conflict, retry' }`.
  - New `provisionUnbound` with the precedence: `provisionAndRecord` → `strandProvisioner` →
    structural placeholder. Tradeoff (a vs b) documented inline at the fallback.
  - New tiny `approve()` wrapper. `index.ts` re-exports `ResolvedHostStrand` + `ResponderProvisionOutcome`.

## Validation performed (all green)

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — **350 passed (28 files)**.
- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn lint` (whole repo, the enforced gate) — clean.
- `yarn workspace @serfab/integration-tests typecheck` — clean (Phase 4 leg compiles).

### Key test cases added (cadre-core, agent-run)

- `strand-formation-consent.spec.ts` (real `ControlFormationUsageRecorder` + in-memory control DB):
  - **(e) unbound single-use** — first redemption mints a fresh strand (`createdBy:'responder'`,
    no `memberPrivateKey`), `countFormationUsage===1`, a `Strand` row exists; second redemption →
    `approved:false, reason:'Invalid token'`, count stays 1. **This is the security regression** —
    the old fallback wrote no usage row, so a `TotalUses:1` unbound invite was infinitely redeemable.
  - **(f) unbound multi-use** — `TotalUses:2` → two distinct strand ids, `UseNumber` {1,2}; third rejected.
  - **(g) bound + missing strand** — a result frame **is** written (no hang), `approved:false`,
    `reason:'Host strand not yet available on this responder'`, `partyId`/`cadrePeerAddrs` undefined,
    `countFormationUsage===0`. (Drives the exact path that previously threw the deferred `StrandExists`
    CHECK and closed the stream with no frame.)
  - Existing (a)/(b,c,d) cases stay green.
- `strand-formation-protocol.spec.ts` — post-validation `approved:false` reply discloses no identity;
  a provisionStrand **throw** is converted to the non-disclosing `'Internal formation error'` frame.
- `control-formation-invite.spec.ts` — `resolveStrand` reclassified to bound/unbound/missing; new
  `provisionAndRecord` direct unit test (mints open strand + one usage row, single-use).

## Reviewer focus / known gaps (treat tests as a floor)

- **Integration leg is DEFERRED — NOT run here.** `strand-formation-e2e.integration.ts` Phase 4
  ("Responder consent enforcement (real recorder)") was written + **typechecked only**; it needs a
  real two-node libp2p run by a human/CI. It asserts (i) the second redemption of an unbound
  single-use invite is rejected and (ii) a bound-but-unconverged strand throws
  `Formation rejected: Host strand not yet available…` rather than a dial read-error/timeout.
  Scrutinize: the authority signing-key derivation (`authorityPrivateKey.slice(4,36)` → base64url,
  copied from `enrollment-e2e`); control-DB read-after-write consistency for the freshly-inserted
  invite on the same node; and that the initiator's default `isValidResponderCreatesResult` accepts
  the responder-provisioned **open** strand over the wire.
- **Broad catch reason.** `provisionAsResponder`'s catch maps *every* caught error to
  `'Formation conflict, retry'`. The dominant real case is the concurrent PK collision, but a transient
  non-conflict DB error would also be labeled "retry". The `runSession` `'Internal formation error'`
  frame is the backstop for throws *outside* provisionStrand. Consider whether finer classification is
  warranted, or whether the broad label is acceptable (the plan accepted it).
- **Concurrent collision is reasoned, not race-tested.** The single-use enforcement is tested
  sequentially; the actual two-redemptions-collide-on-`(Token,UseNumber)` race is argued from the
  schema's `Monotonic`/PK constraints, not driven by a deterministic concurrent test (hard to make
  deterministic in-process). Worth a sceptical read of that path.
- **`sAppId` is plumbed but unused** by `redeemInvitation` (accepted for parity/future use; documented
  in `provisionAndRecord`).
- **Out of scope (do not expand here):** the "should the responder-provisions fallback / `StrandProvisioner`
  exist at all?" dead-surface question remains in backlog/plan `formation-initiatorcreates-cover-or-remove`.
  Production (`cadre-web.ts`/`cadre-phone.ts`) always publishes strand-bound invites, so the fallback is
  exercised only by cadre-core unit tests + `@serfab/integration-tests`.
