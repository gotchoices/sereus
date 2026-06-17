description: Add an end-to-end test proving a private strand's full lifecycle works across two real nodes — found it, invite and admit a second party, register its node, and confirm authorized writes pass while unauthorized ones are blocked.
prereq: strand-membership-invite-join, strand-membership-peer-and-rotation
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/cadre-core/src/index.ts
difficulty: medium
----

## Context

Capstone integration coverage for the strand membership lifecycle landed by tickets 1–3. Drives
the full **closed-strand** path across two real `CadreNode`s over libp2p, asserting the
layer-2 (`Strand.*`) membership tables behave end-to-end. Model the setup on the proven
two-node pattern in `rbac-signed-write.integration.ts` (real `CadreNode`s, `formStrand` over
libp2p, `addStrand` on each side, a manual strand-level dial) and the Phase-2 lifecycle tests in
`strand-formation-e2e.integration.ts`.

## Scope (settled)

Assert the **SQL-layer membership lifecycle** using the writer APIs from tickets 1–3 against the
two nodes' real strand DBs. The full closed-formation-over-the-wire delivery of
`MemberPrivateKey` (provision-then-record) is already exercised at the control layer
(`strand-formation-e2e` Phase 4) and is **out of scope** here — construct the shared closed
`StrandRow` directly (`Type:'c'`, a `MemberPrivateKey` minted via `generateStrandMemberKey`),
exactly as existing tests construct the open `StrandRow` from `formResult.strandId`. Both nodes
`addStrand` the same closed row; the founder passes `founder:true`, the joiner `founder:false`.

## What to assert

- **Founder bootstrap**: after the founder's `addStrand({ founder:true, … , mode:'networked' })`,
  its strand DB has exactly one `Strand.Header(Type='c')`, one founding `Strand.Member`, one
  founding `Strand.Authority` (keys = `strandMemberKeyPair(MemberPrivateKey).publicKeyB64`).
- **Joiner writes nothing on bring-up**: the joiner's `addStrand({ founder:false })` inserts no
  membership rows of its own (counts come only from sync / later consumption).
- **Sync of bootstrap rows** (networked mode, manual strand dial as in the existing Phase-2
  tests): the joiner observes the founder's `Header`/`Member`/`Authority` via Optimystic sync
  without re-inserting. (If replication of `Strand.*` rows proves flaky under the current
  manual-wire setup — the same bootstrap-vs-networked caveat noted in `rbac-signed-write` — make
  the sync observation a logged best-effort, not a gating assertion, and gate instead on the
  founder-local rows + the writer-driven accept/reject cases below. Document the choice.)
- **Invite → join**: founder authority `issueInvite` → joiner `consumeInvite` with its own member
  keypair → joiner's `Member` + `ConsumedInvite` admitted. An *unauthorized* join (consume with a
  wrong invite key, or issue by a non-authority) is rejected.
- **MemberPeer**: the joining member `registerMemberPeer` succeeds with its own signature; a peer
  insert under a different signer is rejected.
- **Authority rotation**: the founder authority adds the joining member as a second authority;
  a non-authority attempt is rejected.
- **A signed sApp write** by the newly-admitted member is accepted (ties layer-2 membership to
  layer-3 sApp RBAC) — reuse the `App.Items` signed-write shape from `rbac-signed-write`.

## Edge cases & interactions

- **Two-node lifecycle teardown**: `try/finally` stops both nodes (cascades to strand libp2p
  nodes), matching the existing scenarios — no leaked nodes.
- **bootstrap vs networked**: request `mode:'networked'` explicitly on both `addStrand` calls
  (as the existing Phase-2 tests do) so writes route through the network transactor and the
  manual strand dial actually replicates; otherwise the empty `CadrePeer` cohort infers
  `bootstrap` and rows stay node-local.
- **Rejection floor**: per the optimystic deferred-constraint-rollback bug (backlog), rejected
  writes assert via `rejects.toThrow()` ("throws" is the floor) and do not assert post-state
  rollback. Follow the pre-existing-error protocol if a *new* unrelated red surfaces.
- **Timeouts**: real-network scenarios are slow; use the existing per-test timeouts (45–60s) and
  `waitUntil` helpers. Keep the new scenario self-contained so it can run via
  `test strand-formation-e2e` (or a new file) without the full suite.
- **Determinism**: distinct member keypairs for founder vs joiner; assert the second member/
  authority genuinely take the non-bootstrap (signature-verifying) branches.

## TODO

- Add a closed-strand lifecycle scenario (extend `strand-formation-e2e.integration.ts` Phase 2,
  or a new sibling file) using two real `CadreNode`s, a directly-constructed closed `StrandRow`,
  founder/joiner `addStrand`, and a manual strand-level dial.
- Drive and assert: founder bootstrap rows; joiner no-write; invite issue/consume (accept +
  reject); `registerMemberPeer` (accept + reject); authority add (accept + reject); a signed
  sApp write by the admitted member.
- Run `yarn workspace @serfab/integration-tests test strand-formation-e2e 2>&1 | tee /tmp/e2e.log`
  (stream) and typecheck. Note any sync-observation downgrade to best-effort with rationale.
- Update `docs/architecture.md` if the membership lifecycle description needs the end-to-end flow.
