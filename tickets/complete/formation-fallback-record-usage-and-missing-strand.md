description: Responder-side strand-formation fixes — single-use enforcement on the responder-provisions (unbound-invite) fallback via an atomic provisionAndRecord, and a clean protocol rejection (instead of a thrown insert + dropped frame) when a bound invite names a missing/unconverged host strand. Plumbed through a new ResponderProvisionOutcome rejection channel with a best-effort internal-error backstop.
files: packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-formation-consent.spec.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/test-network.ts, docs/architecture.md
----

# Complete: responder formation — record usage on the fallback + reject a missing bound strand

Two coupled responder-provisioning gaps on `StrandFormationManager`, both flowing through
`provisionAsResponder`, landed as one implement change (commit `09044af`). Picked **option (a)**
(record usage on the fallback) over (b) (remove the fallback), as the plan resolved.

## What shipped

- **`ResponderProvisionOutcome`** rejection channel (`strand-formation-protocol.ts`): the
  responder's `provisionStrand` hook may REJECT post-validation; `runSession` turns that into a
  clean **non-disclosing** `approved:false` frame instead of a dropped result frame. A whole-session
  `try/catch` writes a best-effort `'Internal formation error'` frame iff nothing was written yet
  (`wroteFrame` guard), then re-throws so `handleStream` still logs. `getResponderIdentity()` is now
  read only on the approval path — a security improvement (no identity/cadre disclosed on any rejection).
- **`ResolvedHostStrand`** discriminated union (`strand-solicitation.ts`) replaces the old
  `{strandId,memberPrivateKey}|null`, splitting `bound` (strand row present) from `missing` (invite
  has a `StrandId` but no `Strand` row). `control-formation-recorder.ts` classifies via `queryStrand`.
- **`provisionAndRecord`** (`control-formation-recorder.ts`): mints `strand-${randomBytes(128,'hex')}`
  (128-bit CSPRNG, the cross-platform primitive `generateStampId` uses) and delegates to
  `ControlDatabase.redeemInvitation`, whose single transaction inserts the consent-authorized `Strand`
  + the `FormationUsage` row together — closing the single-use hole (the old fallback wrote no usage
  row, so a `TotalUses:1` unbound invite was infinitely redeemable).
- **`provisionAsResponder`** (`strand-formation-manager.ts`) routes on `ResolvedHostStrand.kind`:
  `bound` → record + approve; `missing` → clean reject (no usage row, no disclosure); `unbound` →
  `provisionUnbound` (precedence: `provisionAndRecord` → `strandProvisioner` → structural placeholder).
  A `try/catch` maps known provisioning/redeem failures (incl. the concurrent `(Token,UseNumber)` PK
  collision) to a logged `'Formation conflict, retry'`.

## Review findings

### Verified correct (checked, nothing to change)

- **Atomicity & single-use.** Read `redeemInvitation` (`control-database.ts`): one explicit
  `begin…commit` inserts `Strand` + `FormationUsage` so both deferred CHECKs (`Strand.Authorized`
  consent branch ↔ `FormationUsage.StrandExists`) see both rows at commit. Single-use is enforced
  upstream by `validateToken` → `isTokenUsed` → `countFormationUsage >= TotalUses`; the now-written
  usage row is what makes the second unbound redemption reject with `'Invalid token'`. Confirmed by
  test (e).
- **`randomBytes(128,'hex')`.** `randomBytes`'s first arg is **bits**, not bytes (matches
  `generateStampId`, which combines a 16-byte = 128-bit random part). So the minted id is `strand-` +
  32 hex chars / 128 bits of entropy — collision-safe, no buffer overflow.
- **Disclosure timing.** `getResponderIdentity()` read only on approval; token/disclosure/provision
  rejections and the internal-error backstop all leave `partyId`/`cadrePeerAddrs` undefined. Asserted
  by the protocol spec and consent spec (g).
- **Interface fan-out.** The changed `FormationListenerOptions.provisionStrand` (→
  `ResponderProvisionOutcome`) has exactly one production impl (the manager) + the protocol spec, both
  updated. `StrandProvisioner.provisionStrand` (the 3-arg `{strandId}` contract used by
  `strand-solicitation.spec.ts` and the integration scenarios) is **unchanged** — no stragglers.
- **Initiator surfacing.** `formStrand` throws `Formation rejected: <reason>`
  (`strand-formation-protocol.ts:440`) for any `approved:false`, consistent with both new responder
  reasons and both deferred integration assertions.
- **`runSession` catch.** `wroteFrame` correctly prevents a second frame after the `initiatorCreates`
  approval; an `initiatorCreates` `Invalid database result` throw is re-thrown without a second frame
  exactly as before. No behavior regression.

### Minor findings — FIXED inline this pass

- **Docs out of date.** `docs/architecture.md` §Strand Formation still described the unbound path as
  "legacy responder-provisions via `StrandProvisioner`" and omitted the `missing` rejection. Updated
  to describe the atomic `provisionAndRecord` single-use unbound path (with `StrandProvisioner` /
  placeholder as fallbacks that carry no single-use accounting) and the clean `missing`-strand reject.
- **DRY / divergence risk in the deferred Phase 4 integration test.** The new test hand-rolled an
  `authoritySigner` (`cryptoSign` + base64url-string key) that duplicated and diverged from the
  harness's proven `signMessageEd25519` (raw-bytes `ed25519.sign`) used for **every** other
  `insertFormationInvite` in the harness — a real risk for an unrunnable-here test. Exported
  `signMessageEd25519` from the harness and routed `authoritySigner` through it, removing the
  now-unused `uint8arrays`/`cryptoSign` imports. Byte-identical to the harness's own invites.

### Observations — accepted (no change), plan-sanctioned

- **Broad catch reason.** `provisionAsResponder`'s catch labels every caught error
  `'Formation conflict, retry'`. The dominant case is the PK collision; a transient non-conflict DB
  error would also read "retry". Logged before reject (not silent → AGENTS.md-compliant), plan-accepted.
- **Concurrent collision is reasoned, not race-tested** (hard to make deterministic in-process); argued
  from the `(Token,UseNumber)` PK + `Monotonic` constraints. Sequential single-use is tested.
- **`sAppId` plumbed but unused** by `redeemInvitation` — accepted for parity/future, documented.
- **Structural placeholder** (`Date.now()`/`Math.random()`, no-recorder+no-provisioner) is only
  reachable by bare test stubs where no single-use semantics exist to enforce.

### Tests

Happy / edge / error / regression paths are well covered: consent spec (e) unbound single-use +
reuse-reject (the security regression), (f) unbound multi-use with sequential `UseNumber`s, (g)
missing-strand clean reject; protocol spec post-validation reject + provision-throw→internal-error;
invite spec `resolveStrand` reclassification + `provisionAndRecord` unit. No new test gap warranting a
ticket.

### Deferred (not agent-runnable — for CI / human)

- **Phase 4 integration leg** (`strand-formation-e2e.integration.ts`, "Responder consent enforcement
  (real recorder)") — needs a real two-node libp2p run; **typechecked only** here. It now signs
  through the harness's canonical `signMessageEd25519`, removing the prior divergence risk. Still worth
  a real-network run to confirm control-DB read-after-write of the freshly-inserted invite on the same
  node and that the initiator's default `isValidResponderCreatesResult` accepts the
  responder-provisioned **open** strand over the wire.

### Major findings → new tickets

None. The remaining out-of-scope "should the responder-provisions fallback / `StrandProvisioner` exist
at all?" dead-surface question is already captured in plan/backlog
`formation-initiatorcreates-cover-or-remove`; production (`cadre-web.ts`/`cadre-phone.ts`) always
publishes strand-bound invites, so the fallback is exercised only by cadre-core unit tests +
`@serfab/integration-tests`.

## Validation performed (all green)

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — **350 passed (28 files)**.
- `yarn workspace @serfab/integration-tests typecheck` — clean (after the harness-signer reuse edit).
- `yarn lint` (whole-repo enforced gate) — clean (re-run after review edits).
