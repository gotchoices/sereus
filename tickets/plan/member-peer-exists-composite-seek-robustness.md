description: Decide how the member-peer "already registered?" check should behave given a networked-database lookup that can miss a row by its full key — either rely on the upstream fix or make the check robust on its own — and pin it with a test.
files: packages/cadre-core/src/strand-membership-writer.ts, packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: medium
----

## Background

`memberPeerExists()` in `strand-membership-writer.ts` is the insert-if-absent guard behind
`registerMemberPeer`. It checks for an existing peer with a composite-PK point lookup
(`select 1 from Strand.MemberPeer where MemberKey = ? and PeerId = ?`). On a **networked**
strand that seek can fail-open — return no row when one provably exists — so the guard always
concludes "absent" and re-inserts, which (combined with the write-side PK-uniqueness gap) can
accumulate duplicate `MemberPeer` rows on re-register / multi-device flows.

The platform half — reproducing and fixing the composite-PK seek miss in the networked
transactor — is tracked in optimystic as `optimystic-networked-composite-pk-seek-unreliable`
(now in `../optimystic/tickets/`).

## Follow-up (this repo: Sereus-side disposition)

Decide and implement one of:

- **Rely on the upstream fix**: once `optimystic-networked-composite-pk-seek-unreliable` lands,
  keep the composite-PK seek and add a regression test asserting `registerMemberPeer` is a
  true no-op on re-register of the same `(MemberKey, PeerId)` on a networked strand.
- **Make `memberPeerExists` robust regardless**: replace the composite-PK point lookup with a
  scan-and-filter of the member's peers so the guard is correct even while the platform seek is
  unreliable.

Either way, pin the corrected no-op-on-re-register behavior with a test (the closed-strand e2e
in `strand-membership-closed-strand-e2e.integration.ts` is the natural home, or a focused unit
test).

## Notes

- Future concern — promote out of `backlog/` when picked up. The robustness option does not
  depend on the upstream fix; the rely-on-fix option is cross-repo gated (no enforceable
  `prereq:` here).
