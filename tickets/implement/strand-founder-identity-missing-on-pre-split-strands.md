description: Private strands created before each party got its own identity key still have a founder identity that every member can compute, and restarting them silently leaves them in that state while breaking invitations. Make the founder's launch refuse such a strand with a clear "recreate this strand" error, and make join attempts against it say so instead of telling the joiner to retry forever.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-pre-split-founder.spec.ts, packages/cadre-core/test/cadre-node-issue-membership-invite.spec.ts, docs/strands.md, docs/architecture.md, .release-notes.pending.md
repro: verified
----

# Refuse founder launches of closed strands founded before the per-party identity split

## Background

`strand-party-member-key` (complete) split a closed strand's founding identity from the shared read secret. Before it, the founding `Strand.Member` / `Strand.Manager` rows were seated with `strandMemberKeyPair(Strand.MemberPrivateKey)`. That is the control-layer read secret formation hands to every joiner, so any joiner could sign as the founding manager (gotchoices/sereus#4). Since the split, the founder identity is `strandMemberKeyPair(CadreControl.StrandPartyKey.PrivateKey)`, a per-party key that never goes on the wire.

## Reproduced

`packages/cadre-core/test/strand-pre-split-founder.spec.ts` (new, passes today, asserting the BROKEN behavior) does the following:

1. Launches a closed strand through `StrandInstanceManager` as a joiner, which writes nothing.
2. Seats Header / Member / Manager by hand via `bootstrapFounderMembership` with the shared-derived keypair. This is what a pre-split founder did.
3. Calls `foundExistingStrand` with a fresh party key.

Observed:

- `foundExistingStrand` resolves `'bootstrapped'`.
- `Strand.Manager` still holds only the shared-derived key.
- `issueInvite` with the party keypair is rejected by `InviteValid`.

`foundExistingStrand` → `StrandDatabase.ensureFounderBootstrap` → `bootstrapFounder` → `bootstrapFounderMembership` is the same function a fresh founder launch runs in `StrandDatabase.initialize()`, so the launch path behaves identically.

Root cause: `bootstrapFounderMembership` (`strand-membership-writer.ts` ~383) is insert-if-absent per table (`insertFounderMemberIfAbsent` / `insertFounderManagerIfAbsent` skip when the table count is > 0). It never checks that the rows it found belong to the identity it was asked to seat. `CadreNode.resolveStrandPartyKey` mints a party key on the founding machine and its comment calls that "the heal", but nothing re-seats membership.

## Fix design

No migration: the repo's policy is no backwards compatibility, and a strand whose manager key was shared cannot be trusted by rewriting its manager (see the original ticket's "Considered and rejected": any joiner could have already admitted or revoked anyone, or could race the migration).

### Detection: positive signal, at the bootstrap seam

Fire when **a `Strand.Manager` row's `MemberKey` equals `strandMemberKeyPair(memberPrivateKey).publicKeyB64`**, the key derived from the shared read secret. Do not use the weaker "manager set is non-empty but lacks the party key" rule. That rule false-positives on a legitimately founded strand whose founder handed off management: `removeManager` allows add-successor-then-resign. The shared-derived key can never legitimately be a manager after the split, so its presence is exactly the pre-split fingerprint, and it cannot misfire:

- Rows not loaded yet: the Manager table reads empty, so no match. The existing founding inserts run as today.
- Correctly founded strand: the manager is the party key and cannot equal the shared-derived key.
- Joiner launch: joiners never run the bootstrap.
- Sealed strand: zero managers, so no match.

Where:

- `bootstrapFounderMembership` gains an optional `sharedSecretKeyPublic?: string` (or similar) on `FounderBootstrapParams`. For `type === 'c'`, before the Member/Manager inserts, it scans `Strand.Manager` and throws the typed error below on a match. It belongs here rather than in `StrandDatabase` so the membership writer owns all founder-row reasoning and is unit-testable without a runtime.
- `StrandDatabase.bootstrapFounder` passes `strandMemberKeyPair(this.config.memberPrivateKey).publicKeyB64` when `memberPrivateKey` is present. Check that `StrandInstanceManager.buildStrandRuntime` actually threads `strandRow.MemberPrivateKey` into `StrandDatabaseConfig.memberPrivateKey`; the field exists and is documented as "carried for read-gating", so it should be.
- Use the module's existing scan-not-seek idiom (see `strandHasManagerRevocation` / `scanMemberPeers`), or a `select 1 from Strand.Manager where MemberKey = ?`, whichever matches the file's current convention.

### Failure mode: hard launch failure

Throw from the bootstrap. `StrandDatabase.initialize()` rethrows, and `buildStrandRuntime` rolls the runtime back. On the tracked-instance path, `foundExistingStrand` / `ensureFounderBootstrap` reject. `launchStrand` rejects either way:

- `addStrand` / `foundStrand` callers get the error directly.
- The control-discovered path (`handleStrandAdded`) emits `strand:error` and rethrows, so the watcher retries on each poll and re-emits `strand:error`. This is the documented behavior for any failing launch (`addStrand` doc, cadre-node.ts ~4134). It stays loud until the operator recreates or unpublishes the strand.

Refusing only founder writes, with the strand left readable, was considered and not chosen: it needs an enforcement point at every founder-write site, and apps that call the writer functions directly would still see bare constraint errors.

Error: export a typed error from `strand-membership-writer.ts`, e.g. `PreSplitStrandIdentityError extends Error`, carrying `strandId`. Message sketch:

> `Closed strand <id> was founded before per-party strand identity: its founding manager key is derived from the shared MemberPrivateKey that every joining party holds, so any member can act as its founder. It cannot be repaired — recreate the strand (unpublish it and found a new one).`

Export it from `src/index.ts`.

### Formation: do not answer "retry"

With a hard launch failure, a bound closed redemption against that strand reaches `CadreNode.issueStrandMembershipInvite`, finds no live runtime, and throws. The formation manager maps every hook throw to `MEMBERSHIP_INVITE_UNAVAILABLE_REASON` ('…, retry'), so the joiner retries forever. Fix:

- `CadreNode` keeps a small `Map<strandId, PreSplitStrandIdentityError>` of launch refusals. `launchStrand` records the error when a launch rejects with that type and clears the entry on a successful launch. `detachStrand` / `unpublishStrand` clear it as well, so a re-founded id starts clean. One try/catch around `launchStrand`'s body is enough; keep it a small helper, not inline sprawl, since cadre-node.ts is already tracked as oversized (`debt-cadre-node-single-file-size`).
- `issueStrandMembershipInvite` checks the map before the "runtime not live" branch and rethrows the recorded error.
- `StrandFormationManager.issueBoundMembershipInvite` distinguishes `err instanceof PreSplitStrandIdentityError` and returns a distinct reason. Add a new exported constant, e.g. `HOST_STRAND_MUST_BE_RECREATED_REASON = 'Host strand must be recreated'`, with no "retry" in it. `provisionAsResponder` returns that reason. Keep rejecting before consent is recorded (token unspent), as today.
- Rewording `issueStrandMembershipInvite` for hibernating strands is `bug-formation-refuses-join-while-host-strand-hibernates`' job. That ticket touches the same method's not-live branch, not this one, so keep this edit confined to the new pre-check.

### Stale text to correct

- `CadreNode.resolveStrandPartyKey` doc (~4561): minting on a pre-split strand does NOT heal its membership. Say it seats the identity for a publish interrupted before its mint, and that a pre-split strand is refused at the bootstrap. Same for the inline comment in `launchStrand` (~4803, "minted here (heal)").
- `issueStrandMembershipInvite` doc (~6572–6576) and its no-`StrandPartyKey` error text (~6614): drop "a pre-split strand that has not healed at launch".
- `bootstrapFounderMembership` error (~392): "no founder key pair derived from MemberPrivateKey" → name the party's `StrandPartyKey` instead.
- `StrandDatabase.deriveFounderKeyPair` message (~164): "or healed at a founder launch" → reword.
- `cadre-node-issue-membership-invite.spec.ts` line ~68 comment: "(or a pre-split strand not yet healed)".

### Docs and release notes

- `docs/strands.md` → "Closed-Strand Member Key Handling" (~line 222, "healed at a founder launch for strands that predate the split"): replace it with a plain statement. A closed strand founded before the split (0.13.0 or earlier) keeps a founding manager every joiner can impersonate, the founder launch refuses it with `PreSplitStrandIdentityError`, and it must be recreated.
- `docs/architecture.md` → "Strand Membership Bootstrap": in the "Closed strand" bullet (~623), add the pre-split refusal and the positive detection rule. In "Plumbing" (~621), note that the minted key does not re-seat membership. Mention the formation reason.
- `.release-notes.pending.md` (currently empty besides its heading): one line for sApp builders. Closed strands created on `@serfab/*` 0.13.0 or earlier must be recreated after upgrading. The founder launch refuses them with `PreSplitStrandIdentityError`, and join attempts against them are rejected with 'Host strand must be recreated'.

## Scope notes

- Strands with a null `FounderOwnerKey`, and formation-created ones, never resolve as founder without an explicit flag, so they never reach the bootstrap and are not detected here. Bound-formation host strands always come from `publishStrand`, which sets `FounderOwnerKey`, so the formation arm above covers the reachable case. Do not widen to joiner launches.
- The `foundExistingStrand` → `needs-resume` → `wakeStrand` path: the rebuild's `initialize()` throws, and the wake fails. Confirm the wake failure surfaces rather than leaving the instance in a half state, and note what you observe in the handoff.

## TODO

- Flip `test/strand-pre-split-founder.spec.ts` from asserting today's behavior to asserting the fix:
  - the in-place founding (`foundExistingStrand`) rejects with `PreSplitStrandIdentityError`;
  - a fresh founder `startStrand` against pre-split rows rejects and tears the runtime down (seat the rows through a joiner launch on the same storage, or drive `bootstrapFounderMembership` directly against a composed db, whichever the existing helpers make practical);
  - a correctly founded strand still re-bootstraps cleanly;
  - a founder who added a successor manager and then resigned still re-bootstraps. This pins the no-false-positive property.
- Add `PreSplitStrandIdentityError` and the shared-key param to `bootstrapFounderMembership`, and thread `memberPrivateKey` through `StrandDatabase.bootstrapFounder`. Verify `buildStrandRuntime` passes it.
- Add unit coverage in the membership-writer specs for the detection, with and without the shared-key param supplied.
- Record and clear launch refusals in `CadreNode`. Pre-check them in `issueStrandMembershipInvite`.
- Add the non-retryable reason constant in `strand-formation-manager.ts` and map the typed error to it. Export both from `index.ts`.
- Test: a bound closed redemption against a pre-split host strand is rejected with the recreate reason, not `MEMBERSHIP_INVITE_UNAVAILABLE_REASON`. At minimum, cover the hook-level throw in `cadre-node-issue-membership-invite.spec.ts` and the reason mapping at the formation-manager level.
- Correct the stale comments and messages listed above.
- Update `docs/strands.md`, `docs/architecture.md`, `.release-notes.pending.md`.
- Run `yarn workspace @serfab/cadre-core test` (foreground) and `yarn lint`.
