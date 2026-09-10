description: Private strands created before each party got its own identity key are now refused when their founder launches them, with a clear "recreate this strand" error, and join attempts against them are rejected as "must be recreated" instead of being told to retry forever.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-pre-split-founder.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/cadre-node-issue-membership-invite.spec.ts, packages/cadre-core/test/strand-formation-membership-invite.spec.ts, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----

# Refuse closed strands founded before the per-party identity split

## Summary

Before `strand-party-member-key` (landed after the v0.13.0 release), a closed strand's founding `Strand.Member` / `Strand.Manager` rows were seated under the key derived from the shared `Strand.MemberPrivateKey`, which every joiner receives. So any joiner could sign as the founder (gotchoices/sereus#4). The insert-if-absent founder bootstrap then silently skipped those rows under the new per-party key, leaving the shared-derived key as the only manager and making every invite fail. There is no migration, so such strands are now refused loudly.

- **Detection:** `assertNotPreSplitStrand` in `strand-membership-writer.ts` throws the exported `PreSplitStrandIdentityError` (which carries `strandId`) when a `Strand.Member` or `Strand.Manager` row equals the shared-derived public key. `bootstrapFounderMembership` runs it before any write whenever `FounderBootstrapParams.sharedMemberPublicKey` is supplied; `StrandDatabase.bootstrapFounder` supplies it whenever the row carries a `MemberPrivateKey`. `StrandDatabase.ensureFounderBootstrap` sets its `founder` flag only after a successful bootstrap.
- **Launch failure:**
  - A fresh founder launch rolls back, as before.
  - An in-place founding (`StrandInstanceManager.foundExistingStrand`) calls `withdrawFounderRequest` when its bootstrap throws, so retries re-check instead of resolving `'already-founder'`.
  - `CadreNode.startOrFoundStrand` withdraws the flip when the `needs-resume` wake fails.
  - `CadreNode.launchStrand` records the refusal in `strandLaunchRefusals`. The entry is cleared by a successful founder launch, and by `detachStrand`, `unpublishStrand` and `cleanup`.
- **Formation:**
  - `issueStrandMembershipInvite` rethrows a recorded refusal. It also runs `assertNotPreSplitStrand` on the live strand rows before issuing, which covers responders that never ran the refused launch.
  - `StrandFormationManager` maps `PreSplitStrandIdentityError` to the non-retryable `HOST_STRAND_MUST_BE_RECREATED_REASON = 'Host strand must be recreated'`, before consent is recorded, so the token stays unspent.
- **Docs:** `docs/strands.md` and `docs/architecture.md` (Strand Membership Bootstrap → "Pre-split strands are refused, not repaired") updated; release-note line added.

## Review findings

Read the implement diff (`66bd83e`) first, then every touched file plus `strand-watcher.ts`, `hibernation-manager.ts`, `schemas/strand.qsql` (Member/Manager), and `CadreNode.cleanup`.

**Fixed inline (minor):**
- **Detection only probed `Strand.Manager` (the implementer's own "known gap 1").** The schema requires every manager to be a member (`Manager.MemberExists`; `Member.NotAManager` on delete). A pre-split founder who handed management to another key and resigned still has a shared-derived `Member` row, and that row is still forgeable by any joiner. The same applies to a sealed pre-split strand. `assertNotPreSplitStrand` now probes `Member` first and still probes `Manager` for the partition case described in the schema's `MemberExists` NOTE. There are no false positives, because nothing seats the shared-derived key after the split: the "successor-and-resign" case in `strand-pre-split-founder.spec.ts` still passes. New writer-spec case: a pre-split founder who handed off and resigned is refused.
- **Issuance relied entirely on the in-memory refusal map (the implementer's "known gap 2").** A sibling machine of the founding party never founder-launches, and a restarted node has no record until a founder launch runs again. Either one answered with the retryable reason forever while its runtime was live. Issuance now runs `assertNotPreSplitStrand` against the live rows after the runtime check, reusing the same helper (now exported from the writer module, not from the package index). `cadre-node-issue-membership-invite.spec.ts` now asserts the refusal is found on live rows *before* any founder launch recorded one. What remains: a strand with no runtime at all and no recorded refusal still answers retryably. That is documented on the `strandLaunchRefusals` field.
- **`CadreNode.cleanup()` did not clear `strandLaunchRefusals`**, so a stale refusal survived a `stop()`/`start()` cycle on the same object. For example, if the strand was unpublished from a sibling machine while this node was down and then recreated under the same id, it would be rejected as "must be recreated" forever. It is now cleared alongside `sAppConfigs`.
- **`PreSplitStrandIdentityError` doc and message** said "founding manager key". They now say "founding member key", to match the broadened fingerprint. The architecture doc's "re-emits `strand:error` on each poll" now reads "on each (backed-off) retry", which matches the watcher's failure backoff.

**Checked, no change needed:**
- The release-note and docs claim "0.13.0 or earlier" is correct. `git log` shows `strand-party-member-key` landed after `chore: release v0.13.0`, and the package is still at 0.13.0.
- `managerRow` / `memberStampId` scan-then-filter lookups are correct, and a missing (not yet loaded) row reads as absent.
- No production path seats `strandMemberKeyPair(MemberPrivateKey)`. Its only remaining use, in `strand-database.ts`, computes the fingerprint's public half, so the fingerprint cannot misfire on a post-split strand.
- The `needs-resume` failure leaves the instance tracked with `status: 'error'` and no runtime. After the withdrawal, the next wake rebuilds it as a joiner; `HibernationManager.beginWake` clears its in-flight promise in `finally`, so a failed wake does not wedge later wakes.
- `withdrawFounderRequest` being a public class method is fine: `CadreNode` needs it across the class boundary.
- A joiner-only launch neither records nor clears a refusal. That is correct: only a founder launch runs the check, and a recreated id is cleared by unpublish, detach, or cleanup.
- The formation-manager import from `strand-membership-writer.ts` creates no cycle (typecheck and lint are clean).

**Test-coverage gaps, left as-is with reasons:**
- No node-level test of the fresh-launch refusal through `handleStrandAdded`. Recording goes through the same `launchStrand` wrapper the node-level test covers, and the fresh refusal itself is covered at the `StrandInstanceManager` level.
- No node-level test of the `needs-resume` withdrawal in `CadreNode`. It is covered at the manager level only, because `wakeStrand` coalescing makes it hard to force at the node level.

**Tripwires:** none new. The one residual (a strand with no runtime and no recorded refusal answers retryably) is stated at its site, the `strandLaunchRefusals` field doc.

**Tickets filed:** none. Every finding was resolved inline.

**Validation:** `yarn workspace @serfab/cadre-core typecheck` exited 0 and `yarn lint` exited 0. `yarn workspace @serfab/cadre-core test`: 122 files, 2032 passed, 1 skipped.
