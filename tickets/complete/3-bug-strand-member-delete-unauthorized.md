----
description: Removing members from a private group used to require no permission at all — anyone could evict anyone, or everyone. Removal is now permission-checked, a removed person cannot re-admit themselves off their old invitation, and the group can never be emptied.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, docs/strands.md
----

# Complete: authorize `Strand.Member` removal

## What was wrong

`Strand.Member` is a closed strand's read gate. A bare Quereus `check (...)` defaults to
insert|update, so `Member` DELETEs passed through ZERO constraints: anyone could evict
anyone (or everyone, permanently denying the whole strand), an evicted invite-member could
re-insert itself off its stale `ConsumedInvite` row, and a member delete could orphan that
key's `Manager` row.

## What shipped

**Schema** (mirrored in `schemas/strand.qsql` and the embedded `STRAND_SCHEMA`):

- `Member.Authorized` is now `check on insert, delete`, following `control.qsql`'s
  `OwnerKey` shape: `committed.*` pre-transaction authorizer reads plus domain/action-tagged
  signed digests — `digest('Strand.Member', 'add'|'remove', key)` — so an admission approval
  can never replay as an eviction or vice versa.
- Delete branches: a pre-existing `committed.Manager` row may sign a remove-tagged digest
  over `old.Key`, or the departing key itself signs the same digest (self-departure).
- Founder bootstrap branch gated to inserts on an empty `committed.Member` set **and** to a
  single seat (see review findings).
- Invite branch gained a freshness clause: only a same-transaction fresh `ConsumedInvite`
  admits, so a stale row from an earlier join cannot re-admit an evictee.
- `Member.MinOneMember` (`check on delete`): the member count can never reach zero.
- `Member.NotAManager` (`check on delete`): a key still holding a `Manager` row cannot be
  un-membered; reads the post-image, so resign+revoke in ONE transaction passes.

**Writers** (`strand-membership-writer.ts`, exported from `index.ts`):
`signStrandMemberAction(action, memberKey, priv)`, `revokeMember(db, { managerKeyPair,
memberKey })`, `leaveStrand(db, { memberKeyPair })`; `addMemberByManager` re-signed to the
tagged 'add' digest; founder/invite inserts bind `MemberSignature = null` explicitly.

**Docs**: `docs/strands.md` gained a "Removing Members" subsection and extended known-gaps.

## Review findings

Read the implement diff (`d835487..HEAD`) before the handoff summary. Checked: both schema
copies for drift, every `Authorized` branch and its near-misses, the constraint interaction
matrix (`MinOneMember` × `NotAManager` × `Authorized`), the `Manager` table's bootstrap
branch for newly-reachable states, writer/schema payload agreement, doc accuracy against
actual behavior, source hygiene, and the full test suites.

### Fixed in this pass (minor)

- **The bootstrap branch waived authorization for an unbounded batch, not one seat.**
  The diff replaced the old post-image cap `(select count(1) from Member) <= 1` with a
  pre-image gate `(select count(1) from committed.Member) = 0`. The pre-image gate is what
  correctly kills the same-transaction wipe-then-seat attack — but on its own it is true for
  *every* row of a founding transaction, so one transaction could seat any number of members
  with no signature at all. The branch's own comment said "seats the first member", singular;
  the code did not enforce it. **Verified by experiment, not inspection**: the new probe test
  was run against the pre-review schema and it passed the multi-seat insert. Both gates are
  now conjoined, so the waiver covers exactly one seat. This also removes a bricking mode —
  `Manager`'s bootstrap branch requires at most one `Member`, so a multi-seat founding
  transaction produced a strand in which no founding manager could ever be seated. Not a
  privilege escalation (the founding party can seat itself as manager and then admit anyone
  anyway), but a lost invariant and a code/comment disagreement.
- **Two doc claims overstated what removal achieves.** `docs/strands.md` ("A removed member
  cannot walk back in") and `revokeMember`'s doc block ("re-admission takes a fresh manager
  action") both read as absolute. They are true only of the invitation the member already
  spent. Both were narrowed to say so, and point at the new ticket below.
- Rewrapped a comment in `strand-schema.e2e.spec.ts` left over-long by the diff's edit.

### Filed as new tickets (major)

- **`fix/3.6-bug-strand-invite-no-revocation`** — removal is not actually a re-entry gate.
  A removed party holding an *unspent* invitation re-admits itself with no manager action,
  and invitations have no cancellation path (only an optional expiry). The sharp case: a
  manager can mint never-expiring invitations for itself before being removed, then re-seat
  itself indefinitely with no remaining party able to stop it. Reproduced against a real
  closed strand and pinned as a passing test in the revocation spec. Distinct from
  `bug-strand-manager-authority-antireplay`: nothing is captured or replayed here — the
  invitation is used once, exactly as designed, by its legitimate holder.
- **`backlog/debt-strand-consumedinvite-duplicate-constraint`** — `ConsumedInvite` declares
  `MemberExists` and `MemberValid` with an identical predicate and identical operation mask.
  Pre-existing, zero behavior impact; filed rather than fixed here to keep this diff scoped
  to the ticket (the dedupe also touches `docs/architecture.md`).

### Test coverage added

Six probes over branch combinations the implementer's spec did not reach; the spec is now
20 tests, all passing:

- Founding bootstrap seats one member (accept) and rejects a two-member founding transaction.
- A removal naming a REAL manager as `ManagerKey` but carrying a stranger's signature —
  the near-miss of the existing stranger-as-`ManagerKey` case, proving `verify` binds to
  `A.MemberKey` and not to whoever produced the signature.
- A genuine manager removal approval minted over member X, presented on the delete of Y —
  proving approvals are per-target.
- A multi-row `delete ... where Key in (X, Y)` carrying an approval for only X — proving
  `Authorized` is per-row and one approval cannot carry a batch.
- The unspent-invitation re-entry above (a *passing* test that documents current behavior
  and names the ticket that will change it).

### Checked, nothing found

- **`Manager` table reachability under member deletion.** Walked whether the now-possible
  `Member` deletes open the `Manager` bootstrap branch (`count(Manager) <= 1 and
  count(Member) <= 1 and new.MemberKey is a Member`). They do not: `MinOneManager` keeps the
  manager count at ≥ 1 so the post-insert count is always ≥ 2, and `NotAManager` keeps every
  manager in the member set, so the member count cannot be squeezed to 1 while an attacker
  is also a member.
- **Schema copy drift.** The two copies match; `strand-schema-drift.spec.ts` (a real
  comment/string-aware brace scanner, with its own extractor tests) enforces it and passes.
- **Writer/schema payload agreement.** `signStrandMemberAction`'s TS array spelling and the
  SQL literal-argument spelling hash identical bytes; already pinned generically by
  `digest-variadic-parity.spec.ts` case (d).
- **Silent no-op on a nonexistent target.** `revokeMember` deletes zero rows and logs success
  if the key is not a member. Matches `removeManager`'s existing behavior exactly; consistent,
  not a defect.
- **Source hygiene.** `strand-membership-writer.ts` is ~860 lines but is overwhelmingly doc
  comment over short single-purpose exported writers, and is cohesive (one module, one
  concern). Judged fine as-is — deliberately NOT recorded as a tripwire, since there is no
  condition under which it becomes work by itself.

### Tripwires

None recorded. The two conditional concerns that surfaced were already parked by the
implementer — the cross-node member-count floor caveat (`NOTE:` beside `MinOneMember` in both
schema copies, plus a known-gaps bullet) and the replayability of removal approvals (owned by
`bug-strand-manager-authority-antireplay`). Cross-*strand* replay of a removal approval (the
digest carries a domain and action tag but no strand id) falls inside that same ticket's
stated scope and was not parked separately.

## Validation

- `yarn build`, `yarn lint` from root: clean.
- `cadre-core`: 60 files, 911 passed / 1 skipped (was 905 + 6 new probes).
- `quereus-plugin-sereus`: 7 files, 66 passed / 1 todo — includes the schema drift guard.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

## Known residual (deliberate, tracked elsewhere)

- Member removal approvals carry no nonce and stay replayable —
  `bug-strand-manager-authority-antireplay` (fix/), which depends on `Member` keeping this
  tagged-digest form.
- A revoked member's `MemberPeer` rows survive — `strand-memberpeer-revocation-cleanup`
  (implement/).
- An unspent invitation defeats removal — `bug-strand-invite-no-revocation` (fix/, new).
- Revocation is forward-looking: a revoked member keeps replicated data and the strand member
  private key. A real read cut-off means re-forming the strand.
- `MinOneMember` counts locally visible rows; concurrent removals on different nodes can still
  converge to zero.
