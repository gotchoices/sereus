description: The phone app used to switch off the protection that refuses connections from unknown devices, because it turned on the "meeting new people" exception permanently at startup. That exception now only applies while the device actually has a live invitation waiting to be used.
files:
  - packages/cadre-core/src/control-database.ts (hasOutstandingFormationInvite)
  - packages/cadre-core/src/control-formation-recorder.ts (hasOutstandingInvitation delegate)
  - packages/cadre-core/src/strand-solicitation.ts (mint registry, hasOutstandingInvitation, registerMintedInvitation, FormationUsageRecorder.hasOutstandingInvitation?)
  - packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection reorder + check 7; publishFormationInvite registration)
  - packages/cadre-core/src/membership-connection-gater.ts (module doc — stranger allowlist)
  - packages/cadre-core/test/membership-connection-gater.spec.ts
  - packages/cadre-core/test/strand-solicitation.spec.ts
  - packages/cadre-core/test/control-formation-invite.spec.ts
  - docs/architecture.md (§ Control-network inbound connection gate bullet)
  - docs/STATUS.md (step-6 review paragraph)
difficulty: medium
----

# Review: narrowed strand-formation exemption in the control-network connection gate

## What changed

The control node's inbound connection gate (`CadreNode.admitInboundControlConnection`)
used to admit ANY inbound peer whenever `strandSolicitationService` was non-null.
That field is set once and cleared only by `stop()`, and `reference-app-rn`
registers the formation responder at node bring-up — so the gate denied nobody on
the primary client.

The exemption is now keyed on **expectation** of a stranger rather than
**capability** to serve one: a not-yet-authorized peer is admitted on formation
grounds only while at least one unexpired, not-fully-consumed open invitation is
outstanding.

Four moving parts:

1. **`ControlDatabase.hasOutstandingFormationInvite(nowMs?)`** — scans
   `FormationInvite`, skips rows where `expiresAtMs <= nowMs` (null `ExpiresAt`
   never expires), returns true on the first unexpired row that is either
   unlimited (`TotalUses` null) or has `countFormationUsage < TotalUses`. Expiry
   parsing goes through the existing `parseStoredDatetimeMs` + NaN→null guard, not
   SQL. Only unexpired, use-metered invites pay a usage read.
2. **`FormationUsageRecorder.hasOutstandingInvitation?()`** — new OPTIONAL member;
   `ControlFormationUsageRecorder` implements it as a one-line delegate to (1).
   Recorders that cannot enumerate invites simply omit it.
3. **`StrandSolicitationService.hasOutstandingInvitation()`** — answers from an
   in-memory `Map<token, expiryMs>` first (populated by `createOpenInvitation` and
   by the new public `registerMintedInvitation`), pruning entries that expired or
   that the recorder reports consumed; falls back to (2) when the registry is dry;
   `false` otherwise.
4. **The gate** — check 4 (`if (this.strandSolicitationService) return true`) is
   gone. The invitation check is now check **7**, at the END of the chain after the
   authorized-member reads, wrapped in its own try/catch that admits on throw.
   `CadreNode.publishFormationInvite` registers the published token with the
   service (using `options.expiresAtMs ?? Number.POSITIVE_INFINITY`) so a token
   minted elsewhere still opens the window immediately.

New admission order (all OR'd; ordering decides who pays, not the verdict):
`1 not running · 2 empty anchor · 3 enrollment window · 4 bootstrap peer ·
5 empty authorized set · 6 IS a member · 7 invitation outstanding · else DENY`.

No changes to `formStrand`, `stop()`, `reference-app-rn`, or `reference-app-web` —
all three now behave correctly without special-casing, which was the point.

## Use cases to test / validate

**Should ADMIT (regressions if they break):**
- A cadre host that minted an invitation (QR flow in either reference app) and is
  waiting for the invitee to dial in.
- A host that published a `FormationInvite` row before a restart — the durable
  scan re-opens the exemption without a re-mint.
- Any authorized member, any configured bootstrap/relay peer, any node during an
  enrollment window, any un-enrolled/cold-start node — none of these reach check 7.
- Anything ambiguous: a throw, a torn-down DB, a slow read (the gater's 2 s
  `ADMISSION_DECISION_TIMEOUT_MS` still admits on expiry).

**Should DENY (the actual new behavior):**
- A stranger dialing a phone that registered the formation responder at bring-up
  but has no invitation outstanding.
- A stranger dialing a node whose only invitation has expired or been fully
  consumed.
- An initiator's own node (`formStrand` lazily creates a service that never minted).

**Interesting edges worth poking at:**
- Exact expiry instant: `expiresAtMs <= now` is treated as expired at BOTH layers
  (registry and DB), matching `ControlFormationUsageRecorder.isTokenValid`, so a
  token the formation handler would reject cannot hold the gate open. Tested at
  the boundary in both specs.
- Never-expiring invite (`ExpiresAt` null): holds the exemption open indefinitely.
  Accepted and documented, NOT clamped — `CadreNode.createOpenInvitation` defaults
  to 24 h and both reference apps pass an expiry, so it is opt-in. Reviewer may
  disagree; that is the one deliberate tradeoff here.
- Unlimited-uses invite (`TotalUses` null) is never "used up" — deliberately
  identical to `isTokenUsed`.
- Coarser-than-the-handler by design: an admitted peer can still be rejected
  in-protocol for a bogus/spent token. Conversely a peer holding a token whose
  invite row has not replicated to this node yet is denied at the connection layer
  — same convergence caveat as an unreplicated membership row, self-heals the same
  way, documented in the gate's doc comment.

## Verification actually run

- `yarn build` in `cadre-core` and at the repo root — clean.
- `yarn lint` at the repo root — clean.
- `yarn test` in `cadre-core` — **54 files, 751 passed, 1 skipped**. New coverage:
  - `membership-connection-gater.spec.ts`: responder registered + nothing
    outstanding → deny; outstanding → admit; member admitted without consulting the
    check (stubbed to throw, proving it is never reached); check throws → admit;
    check never settles → admit via the gater deadline; and a **mint → admit →
    lapse → deny** acceptance case driven through a real `StrandSolicitationService`
    with fake timers.
  - `strand-solicitation.spec.ts`: fresh service → false; after mint → true; after
    expiry (fake timers, exact boundary) → false; recorder says used → false AND the
    registry entry is gone (asserted by call-count, so it is never re-read);
    delegation to the recorder's optional method both ways; recorder without the
    method → false; `registerMintedInvitation` path.
  - `control-formation-invite.spec.ts`: a dedicated node/DB block for
    `hasOutstandingFormationInvite` (empty → false, unexpired → true, expiry
    boundary → false, single-use consumed → false, live invite behind expired and
    consumed ones → true, whole set dead → false, null/null → true), plus a
    recorder-delegate assertion in the existing shared-DB block.
- Integration scenarios from the ticket's *Regression watch*, run for real:
  - `membership-connection-gater.integration.ts` — 2/2 pass.
  - `strand-formation-e2e.integration.ts` — phases 1, 3, 4 all pass (including
    phase 4's real `ControlFormationUsageRecorder` consent path). The two Phase-2
    failures are the known pre-existing optimystic convergence failures already
    listed in `tickets/.pre-existing-known.md`
    (`control-db-convergence-optimystic-p2p`, blocked) — same
    `membership-not-admitted:low-confidence-downsize` / replication-timeout
    signature as before this change.
  - `rbac-signed-write.integration.ts` — passes (this is the "no recorder but
    minted" shape).
  - `strand-membership-closed-strand-e2e.integration.ts` — the single test fails
    with the identical known optimystic error; listed in `.pre-existing-known.md`.
  - `multi-party-workflows.integration.ts` — the invitation-reuse-rejection test
    passes; the other 4 are the exact 4 already listed in `.pre-existing-known.md`,
    failing with the same optimystic validator error. Notably formation itself
    succeeds in all of them (they get as far as strand data commits), so the
    narrowed gate is not what stops them.
  - No `.pre-existing-error.md` written — every failure observed is already tracked.

## Known gaps / honest flags

- **The web e2e fixture was READ, not exercised.**
  `packages/reference-app-web/e2e/fixtures/formation-responder.ts` mints via
  `createOpenInvitation` and then `publishFormationInvite` for both the valid and
  the deliberately-expired invitation BEFORE the browser dials, so it hits the
  registry path and needs no change. The Playwright suite itself was not run in
  this ticket (browser e2e is out of the agent's runnable envelope). Worth a run if
  a reviewer has the environment.
- **The already-EXPIRED invitation in that fixture is a live question.** It is
  published second, so at dial time the fixture has one live invite and one dead
  one and the gate admits on the live one. If a future test ever mints ONLY an
  expired invitation and expects the browser to reach the protocol-level expiry
  rejection, the connection layer will now deny first and the failure will look
  like a transport error rather than an expiry rejection. Not a defect today; a
  trap for whoever writes that test.
- **No wire-level integration test of the DENY side of the narrowed rule.** The
  deny path is proven at the `admitInboundControlConnection` level (unit, real
  service, fake timers) but not by a real cross-party dial that fails because no
  invitation is outstanding. `membership-connection-gater.integration.ts` would be
  the natural home for it.
- **Registry unbounded between calls.** Pruning happens only inside
  `hasOutstandingInvitation`, so a node that mints thousands of invitations and
  never receives an inbound stranger keeps every entry. Bounded by process
  lifetime and by mint rate; not worth a background sweep, but it is not
  self-pruning either.
- **Tripwire parked:** `control-database.ts` carries a `NOTE:` at the scan noting
  it reads every `FormationInvite` row (expired included) on the stranger path of
  an inbound connection, and what to do (expiry-ordered index or pruning) if a
  long-lived cadre ever makes that show up in inbound-upgrade latency.
- **`hasOutstandingFormationInvite` has no cache.** Each stranger dial costs one
  full-table scan plus up to one usage count per unexpired metered invite. Fine at
  cadre scale, and only strangers pay, but a dial-flood from an unknown peer is the
  one shape that repeats it — the 2 s admission deadline caps the damage per
  connection, not the aggregate.
- **Concurrency was reasoned about, not stress-tested.** `hasOutstandingInvitation`
  only ever deletes expired/consumed entries (both monotonic), so concurrent
  callers cannot disagree in a way that matters, and `Map` iteration tolerates
  deletion mid-iterate. There is no test that runs N concurrent admissions.

## Review findings

- Tripwire: the `FormationInvite` full-table scan on the stranger admission path —
  parked as a `NOTE:` comment at the call site in
  `packages/cadre-core/src/control-database.ts`.
