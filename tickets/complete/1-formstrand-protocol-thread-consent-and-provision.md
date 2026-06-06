description: Provision-then-record consent wiring — a pure libp2p formStrand() threads the invite token to the responder, binds the invite to its host strand (FormationInvite.StrandId column + signed payload), writes exactly one FormationUsage consent row against the host's pre-existing strand, and delivers the host strand id + membership key back through the protocol result.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, docs/architecture.md, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts
----

## What landed

Implements the **provision-then-record** formation model: the host pre-creates a closed strand
(authority-signed) and mints a `FormationInvite` **bound to that strand** via a new nullable
`FormationInvite.StrandId` column folded into the row-bound `AuthorizedAddOrRemove` signed
payload. When an invitee dials, the responder resolves the host strand the invite names, records
a single `FormationUsage` consent row against it (record-only — no new `Strand` insert), and
returns that strand id + its `MemberPrivateKey` over the protocol. Single-use / expiry stay
enforced by the existing `validateToken` gate plus the DB-level `FormationUsage` constraints.

See the implement commit (`ticket(implement): formstrand-protocol-thread-consent-and-provision`)
for the full change-by-file breakdown. The canonical `FormationInvite` signed field order is now
`Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId`.

## Review findings

Adversarial pass over the implement diff (read first, before the handoff), scrutinised for
SPP/DRY/modularity, type safety, error handling, resource cleanup, security, and the crypto
schema edit. Verified against a re-run of the suite, typecheck, and lint.

### Verification (all green)
- `yarn workspace @serfab/cadre-core test` → **327 passed / 0 failed** (incl. `control-schema-drift`,
  which proves `schemas/control.qsql` and the embedded `CONTROL_SCHEMA` byte-match).
- `yarn workspace @serfab/cadre-core typecheck` → clean (exit 0).
- `eslint` on all changed files → **0 errors**, 5 warnings, all pre-existing (`cadre-node.ts`
  88/228 `any`, `control-database.ts` 182/185 `any`, 229 `cause`) — none on lines this ticket
  touched. Confirmed against the diff.

### Crypto / schema (security-critical) — checked, correct
- The `StrandId` digest term is inserted in the same position on the **single** `verify(...)`
  expression that uses `coalesce(new.F, old.F)` per field — so insert and delete are covered by
  one expression; there is no separate delete branch to drift. Placement (after `ValidationUrl`,
  before `StampId`) matches `insertFormationInvite`'s `buildAuthorizationMessage([...])` field
  order.
- `buildAuthorizationMessage` digests each field to raw sha256 **bytes** and concatenates; the
  schema concatenates the per-field **hex** digests and `verify(..., 'hex')` decodes that back to
  the same bytes. Bound (non-null `StrandId`) and unbound (null → signs `''`) both match: the
  unbound case is exercised by `control-authorization-binding.spec.ts` (raw inserts omit the
  column → null → `''`), the bound case by the new consent + invite specs.

### Disclosure-timing / key-leak — checked, correct
- `runSession` calls `provisionStrand` (the only place the membership key is produced) **only
  after** `validateToken` and `validateDisclosure` pass. `provisionAsResponder` calls
  `recordUsage` **before** returning the key, so a failed consent insert never discloses it.
  Rejection (unknown/expired/used token) writes a result frame with no `provisionResult`, hence
  no key — asserted for unknown tokens and for an **expired bound** invite in
  `strand-formation-consent.spec.ts` (a) (provisionResult undefined + 0 usage rows).

### Docs — were stale, fixed inline (minor)
- `docs/architecture.md` still described the recorder as "redeems them by inserting the `Strand`
  + `FormationUsage` rows atomically" — the exact behavior this ticket removed. Rewrote the
  `ControlFormationUsageRecorder` paragraph for provision-then-record (bound `StrandId`,
  record-only consent, membership-key delivery, unbound legacy fallback), extended the
  disclosure-timing sentence to cover the membership key, and updated the formation sequence
  diagram (strand pre-created + bound invite; response carries the membership key). No other doc
  referenced the old redeem behavior (cadre-host.md "redeem" is the unrelated trust-circle flow).

### Major findings — filed, not fixed here
Filed `tickets/backlog/formation-fallback-record-usage-and-missing-strand.md`:
1. **Single-use not enforced on the responder-provisions fallback.** The unbound path in
   `provisionAsResponder` provisions a strand but never calls `recordUsage`, so `isTokenUsed`
   (count vs `TotalUses`) always sees 0 — a `TotalUses:1` **unbound** invite can be redeemed
   repeatedly. Pre-existing (the manager never recorded usage before this ticket) but now stands
   out beside the correct bound path; security-relevant, so escalated rather than patched blind
   (the right fix — restore atomic create+record vs. retire the legacy path — needs a design call
   shared with backlog `formation-initiatorcreates-cover-or-remove`).
2. **Bound invite naming an unconverged/missing strand throws ungracefully.** `resolveStrand`
   returns non-null whenever the invite has a `StrandId` (it never checks strand existence), so a
   responder that has not converged on the host strand row calls `recordUsage`, the
   `StrandExists` deferred CHECK fails, the insert throws, and the stream closes with no result
   frame (initiator times out instead of a clean rejection). Reachable in the distributed control
   network.

### Known gaps carried forward (not regressions)
- **No agent-runnable two-node libp2p leg.** Consent is asserted via an in-memory stream + DB
  effects only; the real round-trip lives in `@serfab/integration-tests` (not agent-runnable).
- **RN consumers not switched** to the protocol-delivered key — that is ticket 2
  (`formstrand-rn-drop-out-of-band-envelope`, in implement), by design.
- **ValidationUrl + bound strand** is unsupported: `recordFormationUsage` passes null
  validation key/sig, so an invite with both a `ValidationUrl` and a `StrandId` would fail the
  `FormationUsage.Authorized` webhook branch. Pre-existing (the webhook flow was never wired into
  the recorder); noted for whoever wires disclosure webhooks.
- **Concurrency** of same-token redemptions relies on the `(Token, UseNumber)` PK collision; not
  unit-tested (single-use proven sequentially).
- **`initiatorCreates` mode** untouched — backlog `formation-initiatorcreates-cover-or-remove`.
