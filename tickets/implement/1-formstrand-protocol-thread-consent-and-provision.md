description: Make a pure libp2p formStrand() round-trip record consent and return the host's real closed strand — thread the invite token+sAppId to the responder, bind the invite to its host strand, write the FormationUsage consent row on the wire, and deliver the strand id + membership key through the protocol result.
prereq:
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts
effort: xhigh
----

## Goal

A single `formStrand(invitation, disclosure)` call over libp2p, against a host that
minted + published a closed-strand invite, must:

1. thread the invitation **token** (and `sAppId`) to the responder's recorder,
2. write **exactly one** `FormationUsage` consent row for the redeemed token against
   the host's **pre-existing** strand,
3. return a `FormStrandResult` whose `strandId` is the host's **actual** strand, with
   the strand's **membership key** delivered through the protocol (not out of band),
4. enforce single-use / `TotalUses` and expiry via the wired
   `ControlFormationUsageRecorder`.

This closes the three gaps in the source fix ticket and subsumes the backlog item
`formation-provision-sappid-not-threaded` (same call site — delete that backlog ticket
when this lands, since threading the token gives the responder `sAppId` for free).

## Decision: provision-then-record (host owns the strand)

**Picked model — provision-then-record.** The host pre-creates the closed strand
(authority-signed `insertStrand` via `publishStrand`, see RN `createClosedChatStrand`)
and then mints a `FormationInvite`. The strand therefore already exists when an invitee
dials. The responder does **not** provision a new strand; it resolves the host strand
the invite names, records a `FormationUsage` against it (record-only), and returns that
strand + its membership key.

Why this and not consent-creates-strand:
- The schema already fits it: `FormationUsage.StrandExists` (`schemas/control.qsql:138`)
  requires the strand to pre-exist, and `ControlDatabase.recordFormationUsage`
  (`control-database.ts:691`) is the record-only path that does **not** insert a Strand.
- It matches the live host flow (strand minted authority-signed up front).
- It avoids the latent double-`insert into Strand` PK-collision flagged in the
  `formationinvite-fix-curve-and-wire-consent` review (the recorder's current
  `recordUsage → redeemInvitation` would re-insert the host strand).

`redeemInvitation` (the consent-creates-strand path) stays on `ControlDatabase` for any
future open-formation responder-provisions flow, but is no longer the recorder's
default.

## Design

### a) Bind the invite to its host strand (schema)

`FormationInvite` has no strand id today (`schemas/control.qsql:84-110`,
`queryFormationInvite` at `control-database.ts:749`), so the responder cannot map
token → host strand. The harness (`TestOpenInvitation.strandId`) and the RN envelope
(`ClosedStrandInvite.strandId`) both paper over this. Fix it at the source:

- Add a nullable `StrandId text` column to `FormationInvite` (both schema copies:
  `schemas/control.qsql` **and** the embedded dup in
  `packages/cadre-core/src/control-schema.ts` — they are guarded byte-identical by the
  `control-schema-drift` test, so edit both).
- Include `StrandId` in the `AuthorizedAddOrRemove` signed payload, appended **after**
  `ValidationUrl` and before `StampId` (use the same
  `digest(coalesce(new.StrandId, old.StrandId), '') ... 'sha256','utf8','hex'` /
  `coalesce(..., '')` shape as the other nullable bound fields — see the `ValidationUrl`
  term at `control.qsql:100`). Keep the field order contiguous and document the new
  canonical order in the comment.
- Plumb `strandId` through `ControlDatabase.insertFormationInvite`
  (`control-database.ts:537`): add an optional `strandId` to its `options`, build it into
  the `buildAuthorizationMessage([...])` array in the **same position** as the schema
  verify (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, **StrandId**, StampId), and
  add it to the `insert ... values`. Mirror the existing `expiresAtField`/`totalUsesField`
  `'' when absent` handling so the signed bytes match the deferred CHECK.
- Return `strandId` from `queryFormationInvite` (add `strandId: string | null` to its
  result shape; select the new column).

Semantics: `StrandId` non-null ⇒ provision-then-record against that strand;
`StrandId` null ⇒ legacy responder-provisions path is still available (do not regress it).

### b) Read a single strand's membership key (DB)

Add `ControlDatabase.queryStrand(strandId): Promise<StrandRow | null>` (a single-row
sibling of `queryStrands` at `control-database.ts:252` — `select Id, MemberPrivateKey,
Type from Strand where Id = ?`). The responder uses it to read the host strand's
`MemberPrivateKey` to deliver to the invitee.

### c) Recorder: resolve + record-only (consent path)

`ControlFormationUsageRecorder` (`control-formation-recorder.ts`):
- Change `recordUsage` to call `controlDatabase.recordFormationUsage({ token, strandId,
  peerId: initiatorKey })` (record-only) instead of `redeemInvitation` — this is the
  provision-then-record commitment and removes the double-insert hazard.
- Add a strand-resolution method to the `FormationUsageRecorder` interface
  (`strand-solicitation.ts:40`) and implement it on `ControlFormationUsageRecorder`:
  `resolveStrand(token): Promise<{ strandId: string; memberPrivateKey: string | null } | null>`
  — `queryFormationInvite(token).strandId` then `queryStrand(strandId)` for the key.
  Returns null when the invite carries no strand binding (legacy/open path).
  Keeping resolution on the recorder interface keeps `StrandFormationManager`
  DB-agnostic and unit-testable with an in-memory fake.

### d) Protocol: carry the membership key + real host strand

`strand-formation-protocol.ts`:
- Add `memberPrivateKey?: string` to `FormationProvisionResult` (and therefore it rides
  in `FormationResultMessage.provisionResult`). It is disclosed **only after** token +
  disclosure validation, exactly like the responder identity/cadre — extend the
  disclosure-timing doc comment to say the strand membership key is gated the same way.
- Thread the **token** into the listener's provisioning hook. Change
  `FormationListenerOptions.provisionStrand` to
  `provisionStrand(token: string, initiatorPartyId: string, disclosure): Promise<FormationProvisionResult>`
  and pass `contact.token` at the call site in `runSession` (`strand-formation-protocol.ts:317`).
- `isValidResponderCreatesResult` (`strand-formation-protocol.ts:199`) currently requires
  `provision.strand.createdBy === 'responder'`. A host strand returned via
  provision-then-record was created by the host authority earlier, not in-session — keep
  returning `createdBy: 'responder'` (the responder party IS the host returning its own
  strand) so the structural validator still passes, OR widen the validator to accept a
  host-owned strand. Pick the former to minimize churn; document the meaning of
  `createdBy: 'responder'` as "the responder party vouches/returns this strand."

### e) Manager: thread token, record consent, return real strand+key

`strand-formation-manager.ts`:
- `provisionAsResponder` becomes `provisionAsResponder(token, initiatorPartyId, disclosure)`.
  New flow when a recorder is wired and `resolveStrand(token)` returns a binding:
  1. `const resolved = await recorder.resolveStrand(token)`,
  2. record consent: `await recorder.recordUsage(token, initiatorPartyId, resolved.strandId)`
     (this writes the single `FormationUsage` row — the on-wire consent record),
  3. return `{ strand: { strandId: resolved.strandId, createdBy: 'responder' },
     memberPrivateKey: resolved.memberPrivateKey ?? undefined,
     dbConnectionInfo: { endpoint: 'local', credentialsRef: '' } }`.
  Fall back to the existing `strandProvisioner` path (now passed the real `sAppId` from
  `queryFormationInvite`, not `''`) when there is no strand binding — this is where the
  `formation-provision-sappid-not-threaded` fix lands.
- `formStrand` (initiator side): surface the delivered membership key. Add
  `memberPrivateKey?: string` to `FormStrandResult` (`types.ts:405`) and set it from
  `provision.strand` / `provision.memberPrivateKey`. Keep `invitePrivateKey` as the
  initiator's generated signing key (its documented purpose) — do **not** overload it.
- `StrandSolicitationService.formStrand` (`strand-solicitation.ts:225`) must forward the
  new `memberPrivateKey` field through its own `FormStrandResult` return (it currently
  rebuilds the result from `memberKey`/`invitePrivateKey`/`strandId` at line 252).

### f) Single-use / expiry

No new logic — `validateToken` already gates via `isTokenValid` (expiry) and
`isTokenUsed` (`countFormationUsage` vs `TotalUses`). Confirm the recorded
`FormationUsage` row increments the count the next `isTokenUsed` sees (it does:
`recordFormationUsage` inserts the row `validateToken` later counts).

### Security note (document inline)

The host strand `MemberPrivateKey` is a read-gating secret. It is sent on the wire only
**after** the token and disclosure validate (same gate as the responder cadre
disclosure), and only to the party that presented a valid single-use token. A rejected
or already-used token discloses neither identity nor key.

## Test (cadre-core, unit, agent-runnable)

Extend `packages/cadre-core/test/strand-formation-protocol.spec.ts` (or a sibling spec)
to drive the `FormationListener` responder with a **real** `ControlFormationUsageRecorder`
over an in-memory control DB (follow `control-formation-invite.spec.ts` for control-DB
setup) plus a pre-existing closed strand + bound invite, and assert a responder session:

- (a) validates the token (rejects an unknown/expired/used token without disclosing the
  membership key),
- (b) writes **exactly one** `FormationUsage` row (`countFormationUsage(token) === 1`)
  keyed to the host strand,
- (c) returns the host's real `strandId` **and** its `memberPrivateKey` in the
  `FormationResultMessage.provisionResult`,
- (d) a second use against a `TotalUses: 1` invite is rejected (single-use), and the
  second attempt writes no additional `FormationUsage` row.

The libp2p two-node leg stays in `integration-tests` (not agent-runnable) — assert the
DB effects + result message against the in-memory control DB only, the way the source
ticket specifies.

## Validation

- `yarn workspace @serfab/cadre-core test` (must stay green incl. the new assertions and
  the `control-schema-drift` guard — both schema copies edited identically).
- `yarn workspace @serfab/cadre-core typecheck` / lint on every changed file (no new
  warnings; honor the `_`-prefix-unused, braces-in-case, `void` micro-task, no-`any`
  house rules).
- Do **not** run the multi-node `@serfab/integration-tests` suite (needs real networks;
  not agent-runnable) — note it for CI/human.

## TODO

- [ ] Schema: add nullable `StrandId` to `FormationInvite` in BOTH `schemas/control.qsql`
      and `packages/cadre-core/src/control-schema.ts`; append it to the
      `AuthorizedAddOrRemove` signed payload (after `ValidationUrl`, before `StampId`);
      update the canonical-order comment.
- [ ] `insertFormationInvite`: accept optional `strandId`, sign it in the correct payload
      position, persist it.
- [ ] `queryFormationInvite`: select + return `strandId`.
- [ ] Add `queryStrand(strandId)` to `ControlDatabase`.
- [ ] `ControlFormationUsageRecorder`: switch `recordUsage` to `recordFormationUsage`
      (record-only); add `resolveStrand(token)`; add `resolveStrand` to the
      `FormationUsageRecorder` interface.
- [ ] Protocol: add `memberPrivateKey?` to `FormationProvisionResult`; thread `token`
      into `FormationListenerOptions.provisionStrand` + its `runSession` call site;
      reconcile `isValidResponderCreatesResult` with the host-returned strand; update the
      disclosure-timing doc comment.
- [ ] Manager: rewrite `provisionAsResponder(token, …)` for provision-then-record
      (resolve strand → record usage → return real strand + key); thread the real
      `sAppId` into the fallback `strandProvisioner` call (closes
      `formation-provision-sappid-not-threaded`); set `memberPrivateKey` on the result.
- [ ] Types: add `memberPrivateKey?: string` to `FormStrandResult`; forward it through
      `StrandFormationManager.formStrand` and `StrandSolicitationService.formStrand`.
- [ ] Test: extend the formation spec with the real-recorder consent/round-trip
      assertions (a)–(d) above.
- [ ] Delete `tickets/backlog/formation-provision-sappid-not-threaded.md` (subsumed).
- [ ] Run cadre-core test + typecheck + lint; leave the integration suite for CI.
