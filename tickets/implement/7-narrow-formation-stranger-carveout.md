----
description: The protection that stops unknown devices from connecting is switched off on the phone app, because that app permanently enables the "meeting new people" exception at startup. Make that exception apply only while the device actually has a live invitation waiting to be redeemed.
prereq: membership-connection-gater
files:
  - packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection; createOpenInvitation; publishFormationInvite; formStrand)
  - packages/cadre-core/src/strand-solicitation.ts (StrandSolicitationService, FormationUsageRecorder seam)
  - packages/cadre-core/src/control-formation-recorder.ts (ControlFormationUsageRecorder)
  - packages/cadre-core/src/control-database.ts (queryFormationInvite / countFormationUsage neighbours)
  - packages/cadre-core/src/membership-connection-gater.ts (module doc — the stranger allowlist lives here)
  - packages/cadre-core/test/membership-connection-gater.spec.ts (decision-matrix tests)
  - packages/cadre-core/test/control-formation-invite.spec.ts (control-DB formation query coverage)
  - docs/architecture.md (§ Control-network inbound connection gate)
  - docs/STATUS.md (step-6 landing note, "capability to serve one" paragraph)
difficulty: medium
----

# Narrow the strand-formation exemption in the control-network connection gate

## What is wrong today

`CadreNode.admitInboundControlConnection` (`cadre-node.ts:799`) is the policy
behind the control node's libp2p connection gater. It admits an inbound peer on
seven grounds; check 4 is:

```ts
if (this.strandSolicitationService) {
  return true;
}
```

That field is set by `initializeStrandSolicitation()` and cleared only by
`stop()`. `reference-app-rn` calls `initializeFormationResponder` unconditionally
at node bring-up (`cadre-phone.ts:228`), so on the phone the field is non-null
from the first second and the gate denies nobody, ever. `reference-app-web`
(`ensureSolicitation`) is lazy but equally permanent once used. `formStrand` —
the *initiator* side, which dials out and needs no inbound stranger admission —
lazily initializes the service too, opening the exemption for a node that never
invited anyone.

Nothing is *unsafe*: the per-stream gates and the read-time voucher predicate
still hold. But the connection-layer defense that shipped in step 6 buys nothing
on the primary client.

## The rule we want

> Admit a not-yet-authorized inbound peer on formation grounds only while this
> node has at least one **unexpired, not-fully-consumed open invitation
> outstanding**.

*Capability to serve a stranger* stops being the trigger; *expectation of a
stranger* becomes it. Consequences, all intended:

- Registering the responder eagerly at startup becomes safe. `reference-app-rn`
  needs no change — its unconditional `initializeFormationResponder` becomes
  correct rather than gate-defeating.
- `formStrand` needs no special case. An initiator never mints an invitation, so
  its lazily-created service reports "nothing outstanding" and the gate stays
  armed. Do **not** add a `registerResponder: false` flag — that is a separate
  concern and out of scope here.
- A stranger that dials with a real token while the node has no outstanding
  invitation is refused at the connection layer. That is the point.

## Design

### Two sources of "outstanding", one predicate

`StrandSolicitationService` gains one public predicate the gate calls:

```ts
/**
 * Does this node currently expect a stranger — i.e. is at least one open
 * invitation unexpired and not yet fully consumed? Sole input to the
 * control-network connection gate's formation exemption (check 4).
 */
async hasOutstandingInvitation(): Promise<boolean>
```

It answers from two places, in this order:

**1. The local mint registry (in-memory).** A `Map<string, number>` of
token → expiry epoch-ms, populated by `createOpenInvitation` (and by
`CadreNode.publishFormationInvite`, see below). Resolution:

- Drop entries whose expiry has passed.
- For each surviving token:
  - **no `formationUsageRecorder` configured** → return `true`. The node
    explicitly minted an unexpired invitation; it has no consumption oracle, so
    the invitation is outstanding by construction.
  - **recorder configured** → `await recorder.isTokenUsed(token)`. `false` →
    return `true`. `true` → delete the entry (consumption is permanent; the
    registry never needs to reconsider it) and continue.

**2. The recorder seam (durable).** If the registry yielded nothing, and the
recorder implements the new optional method, return its answer:

```ts
export interface FormationUsageRecorder {
  // …existing members unchanged…

  /**
   * Is ANY invitation this recorder knows about unexpired and not fully
   * consumed? Optional: a recorder that cannot enumerate invitations omits it,
   * and only locally-minted invitations hold the connection gate's formation
   * exemption open. Distinct from the per-token {@link isTokenValid} /
   * {@link isTokenUsed} pair — the connection gate has no token to ask about.
   */
  hasOutstandingInvitation?(): Promise<boolean>;
}
```

Otherwise `false`.

This split is what makes each of the ticket's open questions answerable:

| case | answer | why |
|---|---|---|
| service with **no recorder**, never minted | `false` — gate armed | this is exactly the eager-`initializeStrandSolicitation` case the ticket exists to close |
| service with no recorder, minted an unexpired invitation | `true` | an invitation really is outstanding; the handler's blind token acceptance is a different (already-documented) problem |
| invitation minted **before a restart** | `true` iff a durable `FormationInvite` row exists and is unexpired/unconsumed | source 1 dies with the process (like `enrollmentWindowUntil`); source 2 survives. A minted-but-never-published token does *not* survive — same "re-mint after restart" story as the enrollment window |
| invitation **replicated in** from a sibling node of the same cadre | `true` via source 2 | covers "or was configured to honor" |

### Durable side: `ControlDatabase.hasOutstandingFormationInvite`

Add next to `queryFormationInvite` / `countFormationUsage`
(`control-database.ts:869-915`):

```ts
/**
 * Is any `FormationInvite` row still redeemable — unexpired AND with usage
 * below its `TotalUses`? A null `ExpiresAt` never expires and a null
 * `TotalUses` is unlimited, matching {@link ControlFormationUsageRecorder}'s
 * per-token semantics.
 */
async hasOutstandingFormationInvite(nowMs?: number): Promise<boolean>
```

Implementation shape — scan invites, short-circuit on the first redeemable one,
and only pay `countFormationUsage` for invites that are unexpired *and* have a
finite `TotalUses`:

```sql
select Token, ExpiresAt, TotalUses from CadreControl.FormationInvite
```

Parse `ExpiresAt` with the existing `parseStoredDatetimeMs` and apply the same
NaN→null guard `queryFormationInvite` uses. Do **not** try to push the expiry
comparison into SQL — nothing else in `control-database.ts` compares a stored
datetime with an inequality, and inventing one here is unverified surface.

Add at the call site:

```ts
// NOTE: scans every FormationInvite row (expired ones included) on the
// stranger path of an inbound connection. Cadre-scale invite counts make that
// free today; if a long-lived cadre accumulates thousands of expired invites
// and inbound upgrades slow down, add an expiry-ordered index or prune.
```

`ControlFormationUsageRecorder.hasOutstandingInvitation()` is a one-line
delegate to it.

### Gate side: `admitInboundControlConnection`

Replace check 4 and **move it to the end of the chain**, after the
authorized-member reads. The checks are OR'd, so ordering is semantically free —
but ordering decides who pays for the DB reads:

```
1. node not fully up                     (in-memory)
2. no/empty trusted-owner anchor         (in-memory)
3. enrollment window open                (in-memory)
4. peer is configured bootstrap/relay    (in-memory, was check 5)
5. authorized-member set empty           (1 DB read, was check 6)
6. peer IS an authorized member          (same read, was check 7)
7. an open invitation is outstanding     (≤2 more DB reads — strangers only)
   ↓ else DENY
```

Members and infrastructure peers now cost exactly what they cost today. Only a
peer that is *already* on the deny path pays for the invitation lookup.

Check 7 catches its own errors and admits (fail-open, consistent with the module
doctrine — the outer `createMembershipConnectionGater` catch would admit anyway,
but a local catch logs the actual cause):

```ts
try {
  if (await this.strandSolicitationService?.hasOutstandingInvitation()) {
    return true;
  }
} catch (error) {
  log('formation outstanding-invitation check threw for %s — admitting (fail-open): %o', remotePeerId, error);
  return true;
}
```

The whole decision still runs under `ADMISSION_DECISION_TIMEOUT_MS` (2 s), which
admits on expiry — so the extra reads cannot wedge an inbound upgrade.

### Gate vs. the responder's own token check

They must not contradict each other confusingly. They do not, because the gate
is strictly **coarser**: it asks "is *any* invitation outstanding", the handler
asks "is *this* token valid and unused". Resulting orders:

- **Admitted, then rejected in-protocol** — peer holds a bogus/spent token while
  some other invitation is outstanding. Correct and clear: a protocol-level
  error, not a silent connection drop.
- **Denied at the connection layer** — no invitation outstanding at all. The peer
  sees its connection close shortly after dialing (the deny-timing note in
  `createMembershipConnectionGater`'s doc already explains that asymmetry).
- **Denied while the handler *would* have accepted** — only when the peer holds a
  token whose `FormationInvite` row has not replicated to this node yet. Same
  convergence caveat already documented for an unreplicated membership row, and
  self-heals the same way. Say so in the doc.

### `CadreNode` wiring

- `createOpenInvitation` — unchanged externally; the token lands in the service's
  registry because the service mints it.
- `publishFormationInvite` — after a successful `insertFormationInvite`, register
  the token with the solicitation service if one exists (`options.expiresAtMs ??
  Number.POSITIVE_INFINITY`). A host may publish an invite whose token was minted
  elsewhere, and this closes the window immediately rather than waiting for the
  durable path. Keep it to a few lines; do not make it throw.
- `formStrand` — no change.
- `stop()` — no change; nulling the service discards the registry.

### Docs

- `membership-connection-gater.ts` module doc — the ONE documented home of the
  stranger allowlist. Rewrite the formation bullet: the exemption is "an
  unexpired, not-fully-consumed open invitation is outstanding", state that
  registering the responder alone no longer suspends stranger denial, and drop
  the "Narrowing it … is `tickets/plan/narrow-formation-stranger-carveout`"
  pointer.
- `cadre-node.ts` `admitInboundControlConnection` doc — renumber the checks to
  match the new order and replace the "**This exemption is far wider than it
  should be**" paragraph with the narrowed rule + the restart/replication
  caveats.
- `docs/architecture.md:322` — replace "a registered strand-formation responder
  (cross-party by design)" and the following bold sentence with the narrowed
  condition.
- `docs/STATUS.md` — update the step-6 landing note's "capability to serve one"
  paragraph to record that this landed.

## Edge cases & interactions

- **Never-expiring invitation** (`ExpiresAt` null / `expirationMs` absent) holds
  the exemption open indefinitely. Accepted: unlike "a responder object exists",
  that is an explicit, owner-signed, single-purpose statement. `CadreNode.
  createOpenInvitation` defaults to 24 h and the web app always passes an
  expiry, so it is opt-in. Document it; do not silently clamp it.
- **Unlimited-uses invitation** (`TotalUses` null) is never "used up" — matches
  `ControlFormationUsageRecorder.isTokenUsed`. Do not diverge.
- **Expiry boundary.** `queryFormationInvite` treats `expiresAtMs <= Date.now()`
  as expired. Use the *same* comparison so a token the handler rejects cannot
  still hold the gate open. Test the exact boundary.
- **Consumption mid-flight.** A single-use invite consumed by peer A while peer B
  is mid-upgrade: B may be admitted on a now-spent invite and then rejected by
  the handler. Fine — the handler is the trust decision. Do not attempt to race
  the two.
- **Registry pruning.** Expired and consumed tokens must be removed, so the map
  cannot grow without bound on a long-lived host that mints many invitations.
- **Concurrent inbound connections** each call `hasOutstandingInvitation()`
  independently; it must be re-entrant and must not mutate shared state in a way
  that makes two concurrent calls disagree (deleting a *consumed* entry is safe —
  consumption is monotonic).
- **`stop()` during a decision.** `hasOutstandingInvitation` may resolve after
  `controlDatabase` is torn down. The DB read must not throw an unhandled
  rejection; the local try/catch covers it, and check 1 (`!this._running`) short-
  circuits most of it.
- **Fail-open is preserved.** Any throw, missing DB, or slow read admits. A
  formation *deny* must only ever come from a positive "no invitation
  outstanding" answer.
- **Cohort nodes are untouched.** Strand instance nodes never get this gater.
- **`reference-app-web` `ensureSolicitation`** stays lazy and stays correct; no
  change needed. Verify by reading, don't edit.
- **`reference-app-web/e2e/fixtures/formation-responder.ts`** drives the browser
  responder — check whether it mints an invitation before the initiator dials. If
  it relies on the old always-open exemption it needs an invitation minted first,
  not a loosened gate.

## Tests

New/updated coverage, roughly TDD order:

- `packages/cadre-core/test/membership-connection-gater.spec.ts` — the decision
  matrix currently forces the exemption by assigning `{}` to the private
  `strandSolicitationService` (line ~174). Replace that with a stub exposing
  `hasOutstandingInvitation`, and add rows:
  - responder registered, **no** outstanding invitation, stranger → **deny**
  - responder registered, outstanding invitation, stranger → **admit**
  - member peer with **no** outstanding invitation → still **admit** (member
    check precedes it)
  - `hasOutstandingInvitation` throws → **admit** (fail-open)
  - `hasOutstandingInvitation` never settles → **admit** via the 2 s deadline
- `strand-solicitation` unit coverage (new spec, or extend the nearest existing
  one) for `hasOutstandingInvitation`:
  - fresh service, no recorder, nothing minted → `false`
  - after `createOpenInvitation(sApp, 60_000, [])` → `true`
  - after the mint's expiry passes (fake timers) → `false`
  - recorder reports `isTokenUsed(token) === true` → `false`, and the registry
    entry is gone
  - registry empty, recorder implements `hasOutstandingInvitation` → delegates
  - registry empty, recorder omits the method → `false`
- `packages/cadre-core/test/control-formation-invite.spec.ts` — extend for
  `hasOutstandingFormationInvite`: no rows → `false`; unexpired unconsumed →
  `true`; expired → `false`; `TotalUses:1` with one recorded usage → `false`;
  null `ExpiresAt` + null `TotalUses` → `true`; a mix where one expired invite
  precedes a live one → `true`.
- Acceptance-level: a node that mints, then lets the invitation lapse, denies
  again. Prefer driving this at the `admitInboundControlConnection` level in the
  gater spec (fake timers) over standing up a real network.

## Regression watch (run these; do not "fix" them by widening the gate)

These already dial cross-party into a gated responder. They pass today via the
old always-open exemption; under the narrowed rule they must pass because an
invitation really is outstanding:

- `packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts`
  phases 1/3/4 — phases at lines ~366, ~474, ~592 go through
  `aliceNode.initializeStrandSolicitation(...)` + `aliceNode.createOpenInvitation(...)`
  (registry path); phase 4 (~line 778) uses the real
  `ControlFormationUsageRecorder` (durable path). Phases that register on a bare
  `StrandSolicitationService` (~176/223/296) leave `CadreNode.strandSolicitationService`
  null, so the old check 4 was *already* closed for them — they are unaffected,
  which also means the harness's parties are not being denied for other reasons.
- `packages/integration-tests/src/scenarios/multi-party-workflows.integration.ts`
  (~209, ~310) — mock recorder + `createOpenInvitation` → registry path.
- `packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts`
  (~142) — `initializeStrandSolicitation({ strandProvisioner })` with **no**
  recorder, then `createOpenInvitation`. This is precisely the "no recorder but
  minted" row above; it must stay green.
- `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
  (~169) — same shape.
- `packages/cadre-core/test/strand-formation-consent.spec.ts` — in-memory
  recorder fakes; confirm the new optional method being absent changes nothing.

If one of these goes red, the fix is in the *test's* invitation lifecycle or in
the design's registry rules — never in re-widening the exemption.

## TODO

### Phase 1 — durable predicate
- Add `ControlDatabase.hasOutstandingFormationInvite(nowMs?)` beside
  `countFormationUsage`, with the scan `NOTE:` tripwire comment.
- Extend `control-formation-invite.spec.ts` with the six cases above; run it.

### Phase 2 — service predicate
- Add optional `hasOutstandingInvitation?()` to the `FormationUsageRecorder`
  interface, documented as distinct from `isTokenValid`/`isTokenUsed`.
- Implement it on `ControlFormationUsageRecorder` as a delegate.
- Add the mint registry + `hasOutstandingInvitation()` to
  `StrandSolicitationService`; record the token in `createOpenInvitation`; prune
  on expiry and on observed consumption.
- Write the strand-solicitation unit spec; run it.

### Phase 3 — gate
- Reorder `admitInboundControlConnection` to the 7-step order above and replace
  the responder-exists check with the invitation check + local fail-open catch.
- Register the token in `CadreNode.publishFormationInvite`.
- Rewrite the `admitInboundControlConnection` doc comment (renumbered checks,
  narrowed rule, restart + replication caveats).
- Update `membership-connection-gater.spec.ts` (stub service, new matrix rows,
  fail-open + timeout rows); run the cadre-core suite.

### Phase 4 — docs + verification
- Rewrite the formation bullet in the `membership-connection-gater.ts` module
  doc; drop the plan-ticket pointer.
- Update `docs/architecture.md:322` and the `docs/STATUS.md` step-6 note.
- Read `packages/reference-app-web/e2e/fixtures/formation-responder.ts` and
  confirm it mints an invitation before the initiator dials; adjust the fixture
  if not.
- `yarn build`, `yarn lint`, `yarn test` in `cadre-core`; then the formation
  integration scenarios listed under *Regression watch*, streaming output
  (`… 2>&1 | tee /tmp/formation.log`) so the runner's idle timer stays fed.
- Hand off to `review/` naming: which regression scenarios actually ran, whether
  the web e2e fixture was exercised or only read, and the never-expiring-invite
  tradeoff.
