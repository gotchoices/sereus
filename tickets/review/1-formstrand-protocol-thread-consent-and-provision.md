description: Review the provision-then-record consent wiring — a pure libp2p formStrand() now threads the invite token+sAppId to the responder, binds the invite to its host strand (new FormationInvite.StrandId column + signed payload), writes exactly one FormationUsage consent row against the host's pre-existing strand, and delivers the host strand id + membership key back through the protocol result.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts
----

## What landed

Implements the **provision-then-record** model: the host pre-creates a closed strand
(authority-signed) and mints a `FormationInvite` **bound to that strand**. When an invitee
dials, the responder resolves the host strand the invite names, records a single
`FormationUsage` consent row against it (record-only — no new strand insert), and returns
that strand id + its membership key over the protocol. Single-use / expiry are enforced by
the existing `validateToken` gate.

### Changes by file

- **Schema (`schemas/control.qsql` + embedded dup `control-schema.ts`)** — added nullable
  `StrandId text` column to `FormationInvite` (between `ValidationUrl` and `StampId`) and
  appended its digest term to the `AuthorizedAddOrRemove` signed payload, in the same
  nullable-`coalesce(...,'')` shape as `ValidationUrl`. **Both copies edited identically**
  (the `control-schema-drift` guard passes). Canonical field order is now
  `Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId`.
- **`control-database.ts`** — `insertFormationInvite` takes optional `strandId`, signs it
  in the new payload position (`'' ` when absent), and persists it. `queryFormationInvite`
  selects + returns `strandId: string | null`. New `queryStrand(strandId): Promise<StrandRow | null>`
  (single-row sibling of `queryStrands`) reads the host strand's `MemberPrivateKey`.
- **`control-formation-recorder.ts`** — `recordUsage` now calls `recordFormationUsage`
  (record-only) instead of `redeemInvitation` (removes the latent double-`insert into Strand`
  PK-collision the prior review flagged). New `resolveStrand(token)` →
  `{ strandId, memberPrivateKey } | null` (invite `StrandId` → `queryStrand`).
- **`strand-solicitation.ts`** — added **optional** `resolveStrand?` to the
  `FormationUsageRecorder` interface (optional so existing in-memory mock recorders and the
  integration-tests mocks still satisfy it). `StrandSolicitationService.formStrand` forwards
  the new `memberPrivateKey`.
- **`strand-formation-protocol.ts`** — `FormationProvisionResult` gains `memberPrivateKey?`;
  `FormationListenerOptions.provisionStrand` now takes `(token, initiatorPartyId, disclosure)`
  and `runSession` passes `contact.token`; disclosure-timing doc comment extended to cover
  the membership key; `isValidResponderCreatesResult` doc clarifies `createdBy:'responder'`
  means "the responder party vouches/returns this strand" (host-returned strand still passes).
- **`strand-formation-manager.ts`** — `provisionAsResponder(token, initiatorPartyId, disclosure)`:
  resolve strand → record consent → return real strand + key; **fallback** path now threads
  the real `sAppId` (via `isTokenValid().invitation.sAppId`) into `strandProvisioner.provisionStrand`
  instead of `''` (closes the subsumed `formation-provision-sappid-not-threaded` backlog item).
  `formStrand` sets `memberPrivateKey` on the result.
- **`types.ts`** — `FormStrandResult` gains `memberPrivateKey?` (distinct from
  `invitePrivateKey`, the initiator's own generated signing key — NOT overloaded).
- **`cadre-node.ts`** — `publishFormationInvite` options gain `strandId?` so a host can mint
  a bound invite end-to-end.

## How to validate

- `yarn workspace @serfab/cadre-core test` — **327 pass / 0 fail** (incl. `control-schema-drift`).
- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `npx eslint <changed files>` — 0 errors; only 5 pre-existing `any`/`cause` warnings, none on
  touched lines.

### Key tests (the floor — extend, don't trust as exhaustive)

- **`test/strand-formation-consent.spec.ts`** (new) drives the real responder stack
  (`StrandFormationManager` + real `ControlFormationUsageRecorder` over an in-memory control DB),
  with a pre-existing closed strand + bound invite, via an in-memory stream + captured handler:
  - (a) unknown **and** expired token → rejected, no identity/key disclosed, **no** usage row,
  - (b) exactly **one** `FormationUsage` row, `StrandId` keyed to the host strand,
  - (c) result carries the host's **real** `strandId` + its `memberPrivateKey`,
  - (d) second use of a `TotalUses:1` invite → rejected, writes **no** extra row.
- **`control-formation-invite.spec.ts`** — updated the recorder test for record-only semantics
  (pre-create the strand, then `recordUsage`); added a `resolveStrand` unit test (bound →
  strand+key, unbound/unknown → null).
- **`control-authorization-binding.spec.ts`** — `inviteMessage` helper now signs the 7-field
  payload incl. `StrandId` (`''` when absent); raw inserts omit the column (defaults null →
  signs `''`), exercising the unbound/legacy path. Replay / single-use / delete-branch tests
  re-pass.

## Reviewer focus / known gaps (treat as a starting point, not a finish line)

- **No agent-runnable two-node libp2p leg.** The consent path is asserted via an in-memory
  stream + DB effects only. The real network round-trip lives in `@serfab/integration-tests`
  (multi-node, **not** agent-runnable — left for CI/human). Worth a look that the wire shape
  matches what a real dial produces.
- **Security-critical schema edit.** Re-verify the `StrandId` digest term byte-matches the
  signer for both bound (non-null) and unbound (null→`''`) cases, and that nullable-`coalesce`
  placement (after `ValidationUrl`, before `StampId`) is correct on **both** insert and delete
  branches. The drift guard only proves the two copies match, not that the crypto is right.
- **Membership key is a read-gating secret on the wire.** It is disclosed only after token +
  disclosure validation (same gate as responder cadre). Confirm no path leaks it on rejection
  (the disclosure-timing tests in `strand-formation-protocol.spec.ts` cover identity/cadre; the
  new consent spec covers the key on the bound path — but a dedicated "no key on rejection of a
  *bound* invite" assertion could be tighter).
- **RN consumers NOT updated.** `FormStrandResult.memberPrivateKey` is now populated by the
  manager path, but `reference-app-rn`'s `joinClosedChatStrandFromFormation` still reads
  `invitePrivateKey` and the out-of-band `ClosedStrandInvite` envelope still carries the key.
  Switching RN to the protocol-delivered key + dropping the envelope is **ticket 2**
  (`formstrand-rn-drop-out-of-band-envelope`, still in implement) — by design.
- **Fallback double-read.** The open/legacy fallback re-queries `isTokenValid` purely to fetch
  `sAppId` (a local DB read). Acceptable; flagged for awareness. It keeps the manager DB-agnostic.
- **`initiatorCreates` mode untouched** — out of scope here; see backlog
  `formation-initiatorcreates-cover-or-remove`.
- **Concurrency not unit-tested.** Concurrent redemptions of one token still rely on the
  `Monotonic` / `(Token,UseNumber)` PK collision for serialization (documented in
  `recordFormationUsage`); single-use is proven sequentially, not under race.
