description: A new end-to-end test proves a private (closed) strand's whole membership lifecycle works across two real nodes — found it, invite and admit a second party, register that party's node, and confirm authorized writes pass while forged ones are blocked.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/strand-database.ts, docs/architecture.md, tickets/.pre-existing-error.md
difficulty: medium
----

## What landed

A single self-contained integration scenario,
`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`,
that drives the **closed-strand membership lifecycle** across **two real `CadreNode`s**
over libp2p. It is the capstone over the three component-spec tickets
(`founder-bootstrap`, `invite-join`, `peer-and-rotation`), proving the `Strand.*`
writer APIs behave end-to-end on real strand DBs rather than only in isolated
bootstrap-mode component tests.

No production code changed — this is pure test + docs. (`cadre-core`'s `dist/` was
rebuilt locally so the integration test, which imports `@serfab/cadre-core` from
`dist`, sees the writer exports from tickets 1–3; `dist/` is gitignored, so a reviewer
must `yarn build` cadre-core before running — see "How to validate".)

### Setup (modelled on the proven two-node pattern)

- Two real nodes (founder = storage profile + relay; joiner = transaction profile,
  bootstrapping off the founder's control addrs), `formStrand` over libp2p to get a
  real negotiated `strandId`.
- The shared **closed** `StrandRow` is constructed **directly** (`Type:'c'`,
  `MemberPrivateKey` minted via `generateStrandMemberKey`) — the full closed-formation
  *over-the-wire* delivery of `MemberPrivateKey` is out of scope here (it's covered at
  the control layer by `strand-formation-e2e` Phase 4).
- Both nodes `addStrand` the same row in **`mode:'networked'`** (explicit, so writes
  route through the network transactor and the manual strand dial replicates); founder
  `founder:true`, joiner `founder:false`. Manual strand-level dial joiner→founder.
- `try/finally` stops both nodes (cascades to the strand libp2p nodes) — no leaked nodes.

### What it asserts (the use-case matrix)

Gating (deterministic, against the **founder's** strand DB — see "Design choice"):

| # | Behavior | Accept | Reject |
|---|----------|--------|--------|
| 1 | Founder bootstrap | exactly one `Header(Type='c')`, one founding `Member`, one founding `Authority`, keys = `strandMemberKeyPair(MemberPrivateKey).publicKeyB64` | — |
| 2 | Joiner no-write on bring-up (asserted **before** the dial, so nothing could have synced) | `Header`/`Member`/`Authority` counts all 0 on the joiner | — |
| 5 | Invite issuance | authority `issueInvite` → one `Invite` row | non-authority `issueInvite` → throws |
| 6 | Invite → join | joiner `consumeInvite` w/ its own member key → `Member` #2 + matching `ConsumedInvite` | consume a fresh invite with the **wrong** invite private key → throws |
| 7 | MemberPeer | joining member `registerMemberPeer` (its **real** strand peer id), self-signed → one `MemberPeer` row | peer insert under a **different** signer → throws |
| 8 | Authority rotation | founder promotes the joiner to a 2nd `Authority` (count → 2, genuine signature branch) | non-authority `addAuthority` → throws |
| 9 | Signed sApp write (ties layer-2 → layer-3) | the admitted member signs an `App.Items` insert (reusing the `rbac-signed-write` shape) → accepted | a write the member did **not** sign (signature over a different payload) → throws |

Best-effort (logged, **not** gated): #3/#4 — after the dial, the joiner observing the
founder's `Header`/`Member`/`Authority` via Optimystic sync. In practice this was
observed **true on every run** (`sync=true`), but the ticket directs keeping it
non-gating because deferred-constraint-bearing `Strand.*` replication under the
manual-wire setup is not guaranteed.

## How to validate

```
# 1. Build cadre-core so dist has the writer exports (dist is gitignored).
yarn workspace @serfab/cadre-core build

# 2. Run just this scenario (self-contained — no full suite needed).
yarn workspace @serfab/integration-tests test strand-membership-closed-strand-e2e
```

Observed: **1 passed in ~1.5s** test-time (≈9s incl. transform/import). Ran it 4×
locally — green every time, `sync=true` every time (no flakiness seen). It is a
real-network test with a 60s per-test timeout.

## Reviewer focus / known gaps (treat this as a floor, not a ceiling)

- **Design choice — lifecycle runs on the founder DB, not the joiner DB.** The
  invite/join, member-peer, and authority writers all execute against the **founder's**
  strand DB, because that's the authoritative DB where the founder bootstrap seated the
  `Authority`/`Member`/`Header`/`Invite` rows the deferred constraints read. Driving
  `consumeInvite` on the *joiner's* DB would require the `Invite` + founding rows to have
  replicated there first — exactly the `Strand.*` sync the ticket flags as potentially
  flaky. So the "joiner" is a distinct member keypair (+ the joiner node's real strand
  peer id) admitted into the founder DB. **A stronger follow-up** once `Strand.*` sync is
  proven reliable: run the consume on the joiner's own DB and assert it converges. Worth a
  reviewer's judgment on whether that belongs as a new ticket.
- **Coverage scope.** This e2e exercises `issueInvite`/`consumeInvite`/
  `registerMemberPeer`/`addAuthority` + the signed sApp write. It does **not** re-cover
  `addMemberByAuthority` or `removeAuthority` — both have component specs, and
  `removeAuthority` is currently a non-assertion anyway under
  `optimystic-deferred-check-not-enforced-on-delete` (delete-side deferred CHECKs aren't
  enforced). Intentional, but flag if the reviewer wants the direct-admit branch shown
  end-to-end too.
- **Networked composite-PK point lookup is unreliable.** `select … from
  Strand.MemberPeer where MemberKey = ? and PeerId = ?` returned `undefined` even though
  the row was present (count = 1). Worked around by reading the singleton row directly
  (the row genuinely persisted — this is a *query/seek* quirk of the networked
  transactor, not a write failure). Reviewer should sanity-check that reasoning; it may
  deserve its own optimystic backlog note if it bites elsewhere (the writer's own
  `memberPeerExists` insert-if-absent guard uses the same composite-where, though here it
  failing-open just means it always inserts, which is harmless).
- **Rejection floor.** Per the optimystic deferred-constraint-rollback gap, every reject
  asserts only `rejects.toThrow()` — **no** post-state/rollback assertion. Accept
  assertions use precise key lookups (or counts at points where exactly one row exists,
  sequenced before the matching reject) so a leaked row from a rejected write can't
  corrupt them.
- **Pre-existing red (not mine):** `yarn workspace @serfab/integration-tests typecheck`
  fails with 3 `TS6059` cross-package `rootDir` errors, all in
  `src/scenarios/formation-responder-smoke.spec.ts` (a file headed "TEMPORARY review
  smoke — DELETE after running" that imports `reference-app-web` e2e fixtures).
  Reproduced with my file removed from the tree; my file contributes 0 typecheck errors.
  Filed in `tickets/.pre-existing-error.md` for the triage pass. Vitest transpiles
  per-file with esbuild, so the scenario builds/runs regardless of this `tsc` gate.
- **Full suite not run.** Only this scenario was run (it's self-contained and touches no
  shared harness/fixtures, so it can't regress siblings). The full integration suite is
  slow/real-network; not agent-runnable in one shot.
