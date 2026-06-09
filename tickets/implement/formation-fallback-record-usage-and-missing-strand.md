description: Close two responder-side strand-formation gaps — (1) enforce single-use on the responder-provisions fallback by recording a FormationUsage row (atomic create+record), and (2) make a bound invite naming a missing/unconverged host strand reject cleanly instead of throwing and dropping the result frame.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts
----

# Responder formation: record usage on the fallback + reject a missing bound strand

Two coupled gaps on `StrandFormationManager`'s responder provisioning path, both surfaced
reviewing `formstrand-protocol-thread-consent-and-provision`. They are interdependent — both
flow through `provisionAsResponder` and both hinge on what `ControlFormationUsageRecorder.resolveStrand`
reports — so they land as ONE change.

## Design (resolved)

### The single decision the plan settled

The ticket offered, for gap 1, either **(a)** record usage on the responder-provisions fallback
(restore `redeemInvitation`-style atomic create+record) or **(b)** remove the fallback entirely
in favour of provision-then-record. **We pick (a).**

Rationale (document this tradeoff in the code comments):
- Production never exercises the fallback: `reference-app-web` (`cadre-web.ts`) and
  `reference-app-rn` (`cadre-phone.ts`) **always** publish strand-bound invites (`strandId` set)
  and treat the responder-provisions placeholder as an explicit failure. The only callers of the
  unbound/`strandProvisioner` path are the cadre-core unit tests and `@serfab/integration-tests`,
  via in-memory mock provisioners + mock recorders.
- Option (b) ("remove entirely") is a far larger, multi-subsystem change: it deletes
  `StrandProvisioner` from `strand-solicitation.ts` + the manager and forces rewriting ~6 unit
  tests (`strand-solicitation.spec.ts`) and ~6 integration sites (`strand-formation-e2e`,
  `multi-party-workflows`, `rbac-signed-write`) that verify transport invariants (disclosure
  transmission, cadre-addr disclosure, result validation, concurrency) unrelated to the
  provisioning source — churn + regression risk for zero production benefit.
- Option (a) closes the single-use hole with a targeted atomic create+record reusing the
  already-tested `ControlDatabase.redeemInvitation` primitive, preserves the consent-creates-strand
  capability the schema's `Strand.Authorized` FormationUsage branch + `redeemInvitation` exist for,
  and leaves the mock transport tests untouched.
- The broader "should the responder-provisions fallback / `StrandProvisioner` exist at all?"
  dead-surface question is the same theme as backlog/plan `formation-initiatorcreates-cover-or-remove`
  (unreachable-in-production formation surface). Leave it there; do **not** expand this ticket into it.

### Gap 1 — single-use on the responder-provisions fallback (security)

`provisionAsResponder` today: when `resolveStrand` returns non-null it records usage against the
pre-existing host strand (bound path, single-use enforced); otherwise it provisions a NEW strand
via `strandProvisioner` (or a placeholder) and **never writes a `FormationUsage` row**. So a
`TotalUses: 1` **unbound** invite redeemed against a real `ControlFormationUsageRecorder` is
redeemable repeatedly — `isTokenUsed` (`countFormationUsage >= TotalUses`) always sees 0.

Fix: give the recorder an atomic create-strand-and-record capability and route the unbound path
through it when present. The atomic op is fundamentally a recorder/DB concern (it needs the invite
+ a DB transaction), so it lives on the recorder, NOT the `StrandProvisioner` (which returns a bare
`{ strandId }` and inserts nothing).

New optional method on `FormationUsageRecorder` (strand-solicitation.ts):

```ts
/**
 * Provision a NEW strand for an UNBOUND invite and record consent against it
 * ATOMICALLY (single FormationUsage row → single-use enforced on the next redemption).
 * Optional: a recorder that only supports provision-then-record omits it, and the
 * manager falls back to its StrandProvisioner. Mirrors the create-strand-by-consent
 * path the schema's Strand.Authorized FormationUsage branch authorizes.
 */
provisionAndRecord?(
  token: string,
  initiatorKey: string,
  sAppId: string
): Promise<{ strandId: string; memberPrivateKey: string | null }>;
```

`ControlFormationUsageRecorder.provisionAndRecord` (control-formation-recorder.ts): mint a fresh,
globally-unique strand id (use `randomBytes` from `@optimystic/quereus-plugin-crypto` —
already the cross-platform random source in `control-database.ts:generateStampId` — NOT
`crypto.randomUUID`/`Date.now`/`Math.random`), then call
`controlDatabase.redeemInvitation({ token, strandId, type: 'o', peerId: initiatorKey })`. That one
transaction inserts the consent-authorized `Strand` + the `FormationUsage` row together (both
deferred CHECKs see both rows at commit). Returns `{ strandId, memberPrivateKey: null }` (an
unbound responder-provisioned strand is open; no membership key). `sAppId` is accepted for
parity/future use even though `redeemInvitation` does not currently thread it into the strand row —
document that.

Manager routing — `provisionAsResponder` unbound branch precedence:
1. `recorder.provisionAndRecord` present → use it (real DB recorder → single-use enforced). Approve
   with the returned strand (+ key, which is null for open).
2. else `strandProvisioner` present → existing behaviour (returns `{ strandId }`, no inline usage
   write — leave the mock/legacy contract untouched; those tests record usage explicitly via
   `recordFormationComplete`). Approve with that strand, no key.
3. else → existing structural placeholder. Approve. (No recorder ⇒ no single-use semantics exist.)

### Gap 2 — bound invite naming a missing/unconverged strand (robustness)

`resolveStrand` returns `{ strandId, memberPrivateKey: null }` whenever `invite.strandId` is truthy
**even if `queryStrand` found no row**. The manager then calls `recordUsage`, whose deferred
`FormationUsage.StrandExists` CHECK fails at commit → the insert throws → `runSession` propagates →
`handleStream` catches/logs and closes the stream **without writing a result frame** → the initiator
sees a read error/timeout instead of a clean `approved: false`. Reachable for real: a responder node
that has not yet converged on the host `Strand` row.

Fix `resolveStrand` to report three cases via a discriminated union (replacing the
`{ strandId, memberPrivateKey } | null` shape):

```ts
export type ResolvedHostStrand =
  | { kind: 'unbound' }                                                  // invite has no StrandId → responder-provisions path
  | { kind: 'bound'; strandId: string; memberPrivateKey: string | null } // StrandId set AND strand row present
  | { kind: 'missing'; strandId: string };                              // StrandId set but strand row absent/unconverged
```

`ControlFormationUsageRecorder.resolveStrand`: invite null/`!invite.strandId` → `unbound`; else
`queryStrand(invite.strandId)` → present → `bound` (with `MemberPrivateKey ?? null`), absent →
`missing`.

Manager (`provisionAsResponder`) maps `missing` to a CLEAN rejection — NOT a fresh strand (the
initiator expects THIS host strand) and NOT a throw. Semantics: **retryable** — the responder hasn't
converged yet; the initiator/user may retry after convergence. No server-side await/retry (it would
hold the session past the step timeout); a clean `approved: false` with a distinct, retry-suggesting
reason (e.g. `'Host strand not yet available on this responder'`) is the resolved behaviour. The
rejection writes NO usage row, so a later retry is not blocked.

### Plumbing the rejection through the protocol

`provisionAsResponder` cannot reject today — its return type is `FormationProvisionResult` and the
listener only rejects BEFORE provisioning (on `validateToken`/`validateDisclosure`). Add a rejection
channel:

```ts
// strand-formation-protocol.ts — co-located with FormationProvisionResult
export type ResponderProvisionOutcome =
  | { approved: true; result: FormationProvisionResult }
  | { approved: false; reason: string };
```

- `FormationListenerOptions.provisionStrand` returns `Promise<ResponderProvisionOutcome>`.
- `runSession` (`responderCreates` branch): call `provisionStrand`; on `approved:false` write
  `{ approved:false, reason }` and return — disclosing NEITHER `partyId` NOR `cadrePeerAddrs` (a
  rejection still leaks no identity, same rule as the token/disclosure rejections). On `approved:true`
  write `{ approved:true, partyId, cadrePeerAddrs, provisionResult: outcome.result }`.
- `provisionAsResponder` returns `ResponderProvisionOutcome`: `bound` → record usage, approve;
  `missing` → reject; `unbound` → approve per the precedence above.

Defense-in-depth (prevents the whole "stream closed without a result frame" class): wrap the known
failure modes in `provisionAsResponder` so they become `{ approved:false, reason }` (LOG before
rejecting — AGENTS.md: don't eat exceptions silently; a logged conversion of an internal error into
a protocol-level rejection is deliberate, not control-flow-by-exception). Specifically catch the
concurrent-redemption collision: two redemptions of the same unbound `TotalUses:1` invite both read
`nextUseNumber → 1` and collide on the `(Token, UseNumber)` PK — the loser's `redeemInvitation`
throws and must surface as a reject (`'Formation conflict, retry'`), not a dropped frame.
Additionally, harden `runSession`/`handleStream` so that if the `provisionStrand` hook throws
unexpectedly, a best-effort `{ approved:false, reason:'Internal formation error' }` frame is written
before the stream closes (so a future hook bug can never reproduce the silent-drop symptom).

## Edge cases & interactions

- **Unbound + real recorder, single-use:** `TotalUses:1` unbound invite through `provisionAndRecord`
  twice → first writes Strand+Usage; second `validateToken → isTokenUsed` (`count 1 >= 1`) rejects
  with `'Invalid token'`, writes no second row. (Primary security regression test.)
- **Unbound + real recorder, multi-use:** `TotalUses:2` → two successful provisions, two distinct
  strand ids, two usage rows (`UseNumber` 1,2); third rejected.
- **Bound + present (unchanged):** existing consent spec `(b,c,d)` must still pass — `bound` →
  record usage, return host strand + `memberPrivateKey`.
- **Bound + missing strand row:** clean `approved:false`, distinct reason, NO usage row, NO identity
  disclosed, NO throw. (Primary robustness regression test — drives the exact path that previously
  dropped the frame.)
- **Bound, strand present but OPEN (`MemberPrivateKey` null):** `bound` with `memberPrivateKey:null`
  → approve with no key (legitimate open strand) — distinct from `missing`.
- **Concurrent redemption of one unbound single-use invite:** PK collision on `(Token,UseNumber)`;
  loser maps to a clean reject, winner approves; never two usage rows for `TotalUses:1`.
- **No recorder / mock recorder (no `resolveStrand`, no `provisionAndRecord`):** treated as
  `unbound` → `strandProvisioner` (or placeholder); NO inline `recordUsage` added — preserves the
  existing mock transport tests and the explicit-`recordFormationComplete` integration contract.
- **Rejection-frame disclosure invariant:** every `approved:false` path (missing strand, conflict,
  internal error) writes neither `partyId` nor `cadrePeerAddrs`.
- **Initiator side:** `dialFormation` already throws `Formation rejected: <reason>` on
  `approved:false`; the new reasons surface there. `isValidResponderCreatesResult` is unchanged and
  still accepts an open responder-provisioned strand (no `memberPrivateKey` required).
- **`initiatorCreates` mode:** untouched — it never calls `provisionStrand` on the responder side.

## Key tests (expected outputs)

In `packages/cadre-core/test/strand-formation-consent.spec.ts` (real `ControlFormationUsageRecorder`
+ in-memory control DB + the existing MockStream/captureHandler harness):

- **(unbound single-use)** Insert an UNBOUND `FormationInvite` (`totalUses:1`, no `strandId`). Drive
  the responder twice with the same token. First: `approved:true`, `provisionResult.strand.strandId`
  is a freshly-minted id, `createdBy:'responder'`, `memberPrivateKey` undefined/absent (open),
  `countFormationUsage(token) === 1`, and a `Strand` row now exists for that id. Second:
  `approved:false`, `reason:'Invalid token'`, `provisionResult` undefined, `countFormationUsage`
  still `1`.
- **(unbound multi-use)** `totalUses:2` → two approvals with distinct strand ids, `UseNumber` 1 then
  2; third rejected.
- **(bound + missing strand)** Insert a `FormationInvite` with `strandId` pointing at an id that was
  NEVER inserted as a `Strand`. Drive the responder once: a result frame IS written (no hang),
  `approved:false`, reason matches the missing-strand reason, `partyId`/`cadrePeerAddrs` undefined,
  `countFormationUsage(token) === 0`. (This test fails today: the insert throws and no frame is
  written.)
- Keep existing `(a)`/`(b,c,d)` cases green.

In `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` (real two-node
libp2p — **NOT agent-runnable**, write it for human/CI): a two-node leg asserting (i) an unbound
single-use invite redeemed twice rejects the second redemption, and (ii) a bound-but-unconverged
strand yields a clean `approved:false` rather than a dial read-error/timeout. Note the deferral in
the ticket handoff (do not attempt to run the integration suite inside the agent run).

## TODO

- [ ] strand-solicitation.ts: replace `resolveStrand?`'s return type with the exported
  `ResolvedHostStrand` union; add the optional `provisionAndRecord?` method to `FormationUsageRecorder`.
- [ ] control-formation-recorder.ts: rewrite `resolveStrand` to return `unbound`/`bound`/`missing`
  (distinguish via `queryStrand`); implement `provisionAndRecord` using `randomBytes` + the existing
  `ControlDatabase.redeemInvitation`. Update the class doc comment.
- [ ] strand-formation-protocol.ts: add the exported `ResponderProvisionOutcome` type; change
  `FormationListenerOptions.provisionStrand` to return it; update `runSession`'s `responderCreates`
  branch to write a non-disclosing rejection frame on `approved:false`; add the best-effort
  rejection-frame-on-unexpected-throw hardening in `runSession`/`handleStream`.
- [ ] strand-formation-manager.ts: rewrite `provisionAsResponder` to return `ResponderProvisionOutcome`,
  route on the `ResolvedHostStrand` kind (bound → recordUsage+approve; missing → reject; unbound →
  `provisionAndRecord` ?? `strandProvisioner` ?? placeholder), and map known provisioning/redeem
  failures (incl. the concurrent PK collision) to logged clean rejections. Document the (a)-vs-(b)
  tradeoff at the fallback.
- [ ] control-database.ts: confirm `redeemInvitation` covers the create+record need as-is (it does —
  no change expected); only touch if a strand-id helper is extracted.
- [ ] Add the consent-spec tests above; ensure existing consent + solicitation transport tests stay
  green (mock recorders/provisioners must keep working unchanged).
- [ ] Add the two-node integration coverage (deferred run); flag the deferral in the review handoff.
- [ ] `yarn workspace @serfab/cadre-core test` (stream output via `2>&1 | tee`), `yarn lint`, and a
  cadre-core typecheck. If a failure is clearly pre-existing / outside this diff, follow the
  `.pre-existing-error.md` flow rather than chasing it here.
