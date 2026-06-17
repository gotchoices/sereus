----
description: A new end-to-end test proves a private (closed) strand's whole membership lifecycle works across two real nodes — found it, invite and admit a second party, register that party's node, and confirm authorized writes pass while forged ones are blocked.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-key.ts, schemas/strand.qsql, docs/architecture.md
difficulty: medium
----

## What landed

A single self-contained integration scenario,
`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`,
driving the **closed-strand membership lifecycle** across **two real `CadreNode`s**
over libp2p — the capstone over the three component-spec tickets
(`founder-bootstrap`, `invite-join`, `peer-and-rotation`). It proves the `Strand.*`
writer APIs (`issueInvite`/`consumeInvite`/`registerMemberPeer`/`addAuthority`) behave
end-to-end on a real strand DB, and ties layer-2 membership to a layer-3 signed
`App.Items` write by the newly-admitted member. No production code changed — pure
test + a docs (`architecture.md`) "End-to-end coverage" subsection.

The lifecycle accept/reject cases run against the **founder's** strand DB (the
authoritative DB where bootstrap seated the constraint-backing rows); the joiner
contributes a real node, a real strand peer id, the proof it writes nothing on
bring-up, and a best-effort (logged, not gated) sync observation. See the design
choice in the Review findings.

## Review findings

Adversarial pass over commit `248b584` (implement). Read the diff first, then the
writers (`strand-membership-writer.ts`), the schema (`schemas/strand.qsql`), the sApp
fixture (`fixtures/simple-sapp.qsql`), and the harness/fixture helpers.

### Checked & verified (no action needed)

- **Build / lint / typecheck / test — all green.**
  - `yarn workspace @serfab/cadre-core build` → exit 0 (writer + member-key exports
    present in `dist`).
  - `eslint` on the scenario file → clean (no unused imports; all imports exercised).
  - `yarn workspace @serfab/integration-tests typecheck` → exit 0. The pre-existing
    `TS6059` red the implement handoff flagged (in `formation-responder-smoke.spec.ts`)
    was already resolved by triage commit `c79b8e9`, which deleted that temporary smoke
    file. `tickets/.pre-existing-error.md` is likewise gone — nothing left to flag.
  - Scenario test → **1 passed (~1.8s)**, `sync=true` observed.
- **Every reject (#5–#9) rejects for the *intended* constraint** (cross-checked each
  against `strand.qsql`): non-authority `issueInvite` → no matching `Authority`
  (`InviteValid`); wrong invite key consume → `ValidUsage`/`Member.Authorized` both
  fail; impostor `MemberPeer` → `MemberPeer.Authorized` self-signature mismatch (the
  `MemberExists` branch passes, so the reject is precise); non-authority `addAuthority`
  → count > 1 and no matching `Authority` (`Authority.Authorized`); tampered sApp write
  → `App.Items.AuthorizedWrite` signature mismatch (`CreatedBy = MemberKey` holds, so
  only the signature branch fails). None are false-positive rejects.
- **Accept assertions are non-tautological** — precise key lookups
  (`where Key = ?` / `where MemberKey = ?`), or a count at a point where exactly one
  row exists and the matching reject is sequenced *after* it, so a leaked row from a
  rejected write (per the rollback gap) cannot corrupt an earlier accept.
- **Resource cleanup** — `try/finally` stops both nodes (cascades to the strand
  libp2p nodes); test run showed all four nodes stopping. No leaked nodes.
- **Two-node reality is genuinely exercised** — joiner asserted to write 0 rows
  *before* any dial (proving `addStrand({founder:false})` bootstraps nothing), real
  negotiated `strandId` via `formStrand`, and the `MemberPeer` uses the joiner node's
  real strand peer id.
- **Coverage deferrals are justified** — `addMemberByAuthority` and `removeAuthority`
  are not re-covered e2e; both have component specs (`strand-membership-invite.spec.ts`,
  `strand-membership-peer-rotation.spec.ts`), and `removeAuthority` is a non-assertion
  anyway under `optimystic-deferred-check-not-enforced-on-delete`. Acceptable for a
  capstone e2e.
- **Docs** — the `architecture.md` "End-to-end coverage" subsection accurately
  describes the founder-DB-authoritative design, the best-effort sync, and the two
  worked-around networked-transactor quirks.
- **DRY** — the duplicated test helpers (`createTestNodeConfig`, `wsTransports`,
  `signItem`, `freshKeyPair`, `createSignedSAppConfig`) follow an established
  convention duplicated across 7 scenario files; consolidating them is a pre-existing
  codebase-wide cleanup, out of scope for this ticket (not introduced here).

### Filed as follow-ups (major → backlog)

Both are documented future concerns gated on platform behavior, not defects in this
work:

- **`joiner-db-closed-strand-lifecycle-e2e`** — once `Strand.*` replication is proven
  reliable, deepen the scenario to drive `consumeInvite` (and the lifecycle) on the
  **joiner's own** replicated DB and assert bidirectional convergence, turning the
  current best-effort sync observation into a gate. Captures the implementer's noted
  "stronger follow-up."
- **`optimystic-networked-composite-pk-seek-unreliable`** — a full composite-PK point
  lookup (`MemberPeer where MemberKey = ? and PeerId = ?`) returned `undefined` for a
  provably-present row on the networked transactor. The e2e worked around it (read the
  singleton directly), but the same composite-`where` backs `registerMemberPeer`'s
  `memberPeerExists` insert-if-absent guard, so the seek miss is a latent
  fail-open/duplicate-row hazard for the production re-register path.

### Minor findings fixed inline

None. The scenario is correct, passes, lints, and typechecks as committed; nothing
warranted an inline change.

### Empty categories (explicit)

- **Security/auth regressions** — none. The reject matrix exercises the RBAC floor
  (non-authority issue/admit, impostor peer, unsigned/forged sApp write) and each
  rejects for the correct constraint.
- **Error-handling / exception-eating** — none. `consumeInvite`'s rollback-after-
  failure swallow is narrowly scoped and logged; the best-effort sync `catch` logs its
  outcome and is intentionally non-gating.

## How it was validated

```
yarn workspace @serfab/cadre-core build              # exit 0 (dist is gitignored — required before the test)
yarn workspace @serfab/integration-tests test strand-membership-closed-strand-e2e   # 1 passed, sync=true
yarn workspace @serfab/integration-tests typecheck   # exit 0
npx eslint packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts  # clean
```

The full integration suite (slow, real-network) was not run — the scenario is
self-contained, touches no shared harness/fixtures, and cannot regress siblings.
