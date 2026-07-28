description: The phone app used to switch off the protection that refuses connections from unknown devices, because it turned on the "meeting new people" exception permanently at startup. That exception now only applies while the device actually has a live invitation waiting to be used.
files:
  - packages/cadre-core/src/control-database.ts (hasOutstandingFormationInvite, parseNullableStoredDatetimeMs)
  - packages/cadre-core/src/control-formation-recorder.ts (hasOutstandingInvitation delegate)
  - packages/cadre-core/src/strand-solicitation.ts (mint registry, hasOutstandingInvitation, registerMintedInvitation)
  - packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection check 7; publishFormationInvite registration)
  - packages/cadre-core/src/membership-connection-gater.ts (module doc — stranger allowlist)
  - packages/cadre-core/test/membership-connection-gater.spec.ts
  - packages/cadre-core/test/strand-solicitation.spec.ts
  - packages/cadre-core/test/control-formation-invite.spec.ts
  - packages/cadre-core/test/publish-formation-invite.spec.ts
  - packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts
  - packages/reference-app-web/e2e/fixtures/formation-responder.ts
  - docs/architecture.md, docs/STATUS.md
difficulty: medium
----

# Complete: narrowed strand-formation exemption in the control-network connection gate

## What shipped

The control node's inbound connection gate (`CadreNode.admitInboundControlConnection`)
used to admit any inbound peer whenever a strand-formation responder object
existed. That object is created once and cleared only by `stop()`, and
`reference-app-rn` creates it during node bring-up — so the gate denied nobody on
the primary client.

The exemption is now keyed on **expectation** of a stranger rather than
**capability** to serve one: a not-yet-authorized peer is admitted on formation
grounds only while at least one unexpired, not-fully-consumed open invitation is
outstanding.

Four pieces:

1. `ControlDatabase.hasOutstandingFormationInvite(nowMs?)` — scans
   `FormationInvite`, skips rows at or past their expiry (a null `ExpiresAt`
   never expires), returns true on the first unexpired row that is either
   unlimited-use (`TotalUses` null) or has fewer recorded usages than
   `TotalUses`. An unlimited-use row anywhere in the scan short-circuits the
   usage reads.
2. `FormationUsageRecorder.hasOutstandingInvitation?()` — new optional member;
   `ControlFormationUsageRecorder` implements it as a one-line delegate to (1).
   Recorders that cannot enumerate invitations simply omit it.
3. `StrandSolicitationService.hasOutstandingInvitation()` — answers from an
   in-memory map of tokens this process minted or published (populated by
   `createOpenInvitation` and by the new public `registerMintedInvitation`),
   pruning entries that expired or that the recorder reports consumed; falls back
   to (2) when that map is dry; `false` otherwise.
4. The gate — the old "a responder exists ⇒ admit" check is gone. The invitation
   check is now the LAST check in the chain, after the authorized-member reads,
   wrapped in its own try/catch that admits on throw.
   `CadreNode.publishFormationInvite` registers the published token with the
   service so a token minted elsewhere still opens the window immediately.

Admission order (all OR'd; ordering decides who pays, not the verdict):
`1 not running · 2 empty anchor · 3 enrollment window · 4 bootstrap peer ·
5 empty authorized set · 6 IS a member · 7 invitation outstanding · else DENY`.

`formStrand`, `stop()`, `reference-app-rn` and `reference-app-web` needed no
changes — all three behave correctly without special-casing, which was the point.

## Review findings

### Checked

Read the implement-stage diff (`d41f2e9`) before the handoff summary. Went over
the admission chain's ordering and every fail-open path; the DB scan's semantics
against `ControlFormationUsageRecorder.isTokenValid` / `isTokenUsed`; the mint
registry's lifecycle, pruning and re-entrancy; every caller of
`initializeStrandSolicitation`, `createOpenInvitation` and
`publishFormationInvite` across cadre-core, reference-app-rn, reference-app-web
(including its Playwright fixture) and integration-tests; and `docs/`
(`architecture.md`, `STATUS.md`, `cadre-host.md`) plus both reference-app READMEs
for stale "responder registered ⇒ admit" claims — architecture.md and STATUS.md
were already updated correctly, nothing else asserts the old rule.

Ran: root `yarn lint` (clean), root `yarn build` (clean), `integration-tests`
`yarn typecheck` (clean), `cadre-core` `yarn test` (**54 files, 753 passed, 1
skipped** — 751 before this pass, +2 new), and
`membership-connection-gater.integration.ts` (**3/3 pass**, including the case
added below).

### Found and fixed in this pass (minor)

- **Duplicated expiry parse.** The nullable-`ExpiresAt` parse plus its NaN→null
  guard was copy-pasted between `queryFormationInvite` and the new
  `hasOutstandingFormationInvite` — the exact pair whose agreement the design
  depends on. Extracted `parseNullableStoredDatetimeMs` in `control-database.ts`
  and pointed both at it, so the guard cannot drift.
- **`docs/STATUS.md` named a method that does not exist** (`initializeFormationResponder`).
  Corrected to `initializeStrandSolicitation`.
- **The `publishFormationInvite` → registry wiring had no test.** That call is
  what opens the gate for the RN and web flows, which mint and publish
  separately, and nothing exercised it. Added two cases to
  `publish-formation-invite.spec.ts`: publishing with the service wired and NO
  recorder flips `hasOutstandingInvitation` false→true (so the `true` can only
  have come from the in-memory registry), and publishing an already-expired
  invitation leaves it false.
- **No wire-level coverage of the narrowed rule** — flagged by the implementer as
  a known gap and worth closing rather than filing. Added a third case to
  `membership-connection-gater.integration.ts`: an established receiver that
  registers the formation responder and mints nothing refuses a real outsider
  dial (no surviving connection on either side), and the same outsider's next
  dial succeeds once `createOpenInvitation` runs. Passes in 633 ms.

### Filed as new tickets (major)

None. Nothing found in this pass needed work larger than the fixes above.

### Tripwires parked (conditional — knowledge, not queued work)

- The mint registry is pruned only while `hasOutstandingInvitation` runs, so a
  node that mints steadily and never receives an inbound stranger retains every
  entry for the process's life — `NOTE:` at the `mintedInvitations` field in
  `strand-solicitation.ts`, with what to do if a host ever mints at scale.
- The web e2e fixture's deliberately-expired invitation only reaches the
  protocol-level expiry rejection because the valid invitation published
  alongside it holds the gate open; a future fixture publishing ONLY an expired
  invitation would be denied at the connection layer and the failure would read
  as a transport error — `NOTE:` at that site in
  `reference-app-web/e2e/fixtures/formation-responder.ts`.
- The implementer's existing `NOTE:` in `control-database.ts` about the
  `FormationInvite` full-table scan on the stranger admission path was reviewed
  and left as written.

### Considered and deliberately not filed

- **A never-expiring invitation (`ExpiresAt` null) holds the exemption open
  indefinitely.** Agreed with the implementer's call: unlike "a responder object
  exists", this is an explicit, owner-signed, single-purpose statement,
  `CadreNode.createOpenInvitation` defaults to 24 h, and both reference apps pass
  an expiry. Opt-in, not a trap.
- **Minting without publishing opens the gate for the mint's full lifetime even
  though that token can never be redeemed** (the durable row is what makes it
  valid). That is the intended reading — minting IS the statement "I expect a
  stranger" — and both reference apps publish immediately after minting.
- **The durable scan is cadre-wide**, so an invitation replicated in from a
  sibling node disarms this node's gate too. Intended and documented; the
  formation handler's per-token check is the finer gate.
- **Deny-path cost.** Check 7 now costs a table scan (plus up to one usage read
  per unexpired metered invitation) on exactly the path an unknown dialer
  controls. Not a regression — before this change that path admitted everyone
  with no reads at all — and the gater's 2 s admission deadline caps per-connection
  latency. Covered by the existing scan `NOTE:`.
- **Concurrency stress test.** `hasOutstandingInvitation`'s only mutations are
  deletions of expired/consumed entries, both monotonic, and `Map` iteration
  tolerates deletion mid-iterate; concurrent callers cannot disagree in a way
  that changes a verdict. A racing-admissions test would pin nothing.

### Not run

- The Playwright browser e2e (`reference-app-web`) — outside the agent's runnable
  envelope. The fixture was read and needs no change: it mints via
  `createOpenInvitation` and then `publishFormationInvite` before the browser
  dials, so it hits the registry path. Worth a run by anyone with the environment.
- The rest of the integration suite beyond the gater scenario. The implementer
  ran it (`strand-formation-e2e`, `rbac-signed-write`, `multi-party-workflows`,
  `strand-membership-closed-strand-e2e`) and every failure observed was an
  already-tracked optimystic convergence failure listed in
  `tickets/.pre-existing-known.md`; this pass touched no code those scenarios
  reach differently, so it was not re-run. No `.pre-existing-error.md` written.
