description: Private strands created before each party got its own identity key are now refused when their founder launches them, with a clear "recreate this strand" error, and join attempts against them are rejected as "must be recreated" instead of being told to retry forever. Review the detection, the launch-failure handling, and the formation rejection.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-pre-split-founder.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/cadre-node-issue-membership-invite.spec.ts, packages/cadre-core/test/strand-formation-membership-invite.spec.ts, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----

# Refuse founder launches of closed strands founded before the per-party identity split

## Background

Before `strand-party-member-key`, a closed strand's founding `Strand.Member` / `Strand.Manager` rows were seated under `strandMemberKeyPair(Strand.MemberPrivateKey)`. That key is derived from the shared read secret every joiner receives, so any joiner could sign as the founding manager (gotchoices/sereus#4). The founder bootstrap is insert-if-absent, so re-running it under the new per-party key (`StrandPartyKey`) silently skipped those rows. The strand then kept the shared-derived key as its only manager, and every invite the party issued failed `InviteValid`. There is no migration (no backwards compatibility, and a rewrite of a compromised manager can't be trusted), so the fix is to refuse such a strand loudly.

## What changed

**Detection** (`strand-membership-writer.ts`): `FounderBootstrapParams` gains an optional `sharedMemberPublicKey`. For a closed strand, `bootstrapFounderMembership` throws the new exported `PreSplitStrandIdentityError` (which carries `strandId`) when any `Strand.Manager` row equals that key. The check runs before any write and reuses `managerRow`, the module's scan-then-filter lookup. It checks for the shared-derived key itself, not "the party key is missing". So a founder who handed management to a successor and resigned, a sealed strand, and rows that haven't loaded yet never match. The closed-without-key error text now names `StrandPartyKey`.

**Threading** (`strand-database.ts`): `bootstrapFounder` passes `strandMemberKeyPair(memberPrivateKey).publicKeyB64` whenever the row carries a `MemberPrivateKey`. Both `buildStrandRuntime` and `startStrand` already thread `strandRow.MemberPrivateKey` into `StrandDatabaseConfig.memberPrivateKey`. `ensureFounderBootstrap` now sets its own `founder` flag only after the bootstrap succeeds.

**Launch failure handling** (`strand-instance-manager.ts`, `cadre-node.ts`):

- A fresh founder launch throws out of `initialize()`. `buildStrandRuntime` rolls back, and `startStrand` drops the record, which is the existing behaviour.
- In-place founding (`foundExistingStrand` on a live tracked instance) now calls the new `withdrawFounderRequest(strandId)` when the bootstrap throws, then rethrows. Without this, the retained config stayed `founder: true`, every retry resolved `'already-founder'` and "succeeded", and the failure was reported only once. This applies to any bootstrap failure, not only a pre-split refusal, and it also makes the existing comment in `strand-watcher.ts` (~191, "the retry re-attempts the bootstrap on it") true.
- On the `needs-resume` path, `CadreNode.startOrFoundStrand` wraps the wake plus `ensureFounderBootstrap` and withdraws on failure.
- `CadreNode.launchStrand` is now a thin wrapper around `startOrFoundStrand`, which is the old body moved unchanged. The wrapper records `PreSplitStrandIdentityError` in `strandLaunchRefusals`, a `Map<strandId, error>`. It clears the entry when a *founder* launch succeeds. `detachStrand` and `unpublishStrand` also clear it; `unpublishStrand` does so because a refused fresh launch leaves no tracked instance for `stopStrand` to detach.

**Formation** (`cadre-node.ts`, `strand-formation-manager.ts`):

- `issueStrandMembershipInvite` rethrows the recorded refusal right after the open-strand check, before the party-key and runtime checks.
- `issueBoundMembershipInvite` now returns a `reason`. `PreSplitStrandIdentityError` maps to the new exported `HOST_STRAND_MUST_BE_RECREATED_REASON = 'Host strand must be recreated'`; everything else still maps to `MEMBERSHIP_INVITE_UNAVAILABLE_REASON`. Both rejections happen before consent is recorded, so the token stays unspent.

**Text and docs:**

- Removed the stale "heal" wording: the `resolveStrandPartyKey` and `ensureStrandPartyKey` docs, the inline comment in the launch body, the `issueStrandMembershipInvite` doc and its no-party-key message, the `deriveFounderKeyPair` message, and the invite spec comment.
- `docs/strands.md` gained a paragraph saying pre-split strands must be recreated.
- `docs/architecture.md` gained a "Pre-split strands are refused, not repaired" sub-bullet under "Closed strand", plus a "minting doesn't re-seat membership" note under "Plumbing".
- Added a line to `.release-notes.pending.md`.

## What happens when a strand is refused (observed in tests)

- **In-place founding, live instance:** `foundExistingStrand` rejects with `PreSplitStrandIdentityError`, nothing is re-seated, and a retry rejects again. The joiner runtime it was launched as stays up, and formation still gets the recreate reason, because the refusal map is checked before the runtime.
- **Fresh founder launch over pre-split rows:** it rejects and `hasStrand` is false.
- **`needs-resume` wake:** `resumeStrand` rejects with the typed error. The instance stays tracked with `status: 'error'` and no `database` or `libp2pNode`; the rollback worked and nothing is half-built. Once the flip is withdrawn, `resumeStrand` rebuilds it as a joiner. Through `CadreNode` the wake error propagates out of `wakeStrand` unwrapped, so `launchStrand` records it.

## Tests

- `strand-pre-split-founder.spec.ts` (real `StrandInstanceManager`, solo, one shared in-memory store and transport key) now asserts the fix: the in-place refusal and its retry, the fresh-launch refusal and teardown (relaunch over the same store), the `needs-resume` rebuild refusal and joiner recovery, a correctly founded strand re-bootstrapping cleanly, and a founder who added a successor and resigned re-bootstrapping (the no-false-positive check).
- `strand-membership-writer.spec.ts`, new describe "pre-split detection": refused with nothing written; without the param, the rows are skipped as before; with the param, a fresh strand founds under the party key and re-runs cleanly; an open strand is never checked.
- `strand-instance-manager-hibernation.spec.ts` (mocked): a throwing live bootstrap withdraws the flip, so the retry runs it again; `withdrawFounderRequest` makes the next rebuild a joiner.
- `cadre-node-issue-membership-invite.spec.ts`: an end-to-end run on a real `CadreNode`. It publishes a closed strand, attaches as a joiner, seats pre-split rows, and checks that the derived-founder `addStrand` rejects. Issuance then rethrows the refusal even though the runtime is live, and after `stopStrand` it falls back to the "runtime not live" error.
- `strand-formation-membership-invite.spec.ts`: a hook that throws `PreSplitStrandIdentityError` produces `HOST_STRAND_MUST_BE_RECREATED_REASON` (no "retry" in the text), and no usage is recorded.
- `yarn workspace @serfab/cadre-core typecheck` is clean. `yarn workspace @serfab/cadre-core test` passed: 122 files, 2029 passed, 1 skipped. That run was before the two hibernation-spec cases were added; those were run on their own afterwards. `yarn lint` is clean.

## Known gaps — reviewer, please weigh these

- **Detection only covers the Manager table.** A pre-split strand whose shared-derived manager has already handed management to a different key isn't detected. The party key then has no manager seat, and invites fail with the retryable reason. Before the split every party's identity was the same shared-derived key, so this needs someone to have deliberately added a foreign manager key. It is rare, but I haven't measured how often. A shared-derived *Member* row, which the Member table would still hold in that case, is also never checked.
- **The refusal map is in memory.** After a restart it is re-recorded only when a founder launch of the strand runs again. If the node has no sApp config registered for the strand, there's no auto-launch. Formation then sees "runtime not live" and answers with the retryable reason until something founder-launches the strand.
- **No end-to-end `CadreNode` test for the fresh-launch path.** The fresh launch goes through `handleStrandAdded` and emits `strand:error`. Recording uses the same wrapper as the tracked path, and the fresh refusal itself is covered at the `StrandInstanceManager` level, but no single node-level test combines them.
- **A joiner-only launch clears nothing and records nothing.** For example, `addStrand(founder: false)` of a strand refused earlier leaves the old refusal in place. That is intended, since only a founder launch runs the check, but worth confirming.
- **`withdrawFounderRequest` is public API on `StrandInstanceManager`.** It is not exported separately; it is a class method. The only callers are `foundExistingStrand` and `CadreNode`.
- **The `needs-resume` withdraw in `CadreNode` has no node-level test.** It has manager-level coverage only; `wakeStrand` coalescing makes it hard to force.
