----
description: Device-record removal now runs on two real networked machines — a member deleting its own record, and a manager clearing the leftovers of a member it removed. Review the new test and the docs it updates.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts (the whole change), docs/architecture.md (~line 623, "End-to-end coverage"), packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (pre-existing single-process coverage — context, unchanged), packages/cadre-core/src/strand-membership-writer.ts (unchanged — removeMemberPeer/listMemberPeers/memberPeerStampId are the subjects), schemas/strand.qsql (unchanged — MemberPeer, Revocation)
difficulty: medium
----

# Networked coverage for `MemberPeer` removal — review handoff

## What landed

**No production code changed.** The diff is one integration-test file plus one docs paragraph.

`strand-membership-closed-strand-e2e.integration.ts`:

- Extracted `bringUpClosedStrand(label)` — everything from "two real `CadreNode`s" through
  the manual strand-level dial and the best-effort replication probe, including the
  bring-up invariant assertions (founder seated exactly `Header`/`Member`/`Manager`; joiner
  wrote nothing before the dial). Returns a `ClosedStrandFixture`. On internal failure it
  stops both nodes and rethrows, so a bring-up fault cannot leak live libp2p nodes into the
  sibling test. Each call gets its own provisioner instance and its own `label`-scoped party
  and strand ids.
- The original `it` now consumes the helper and is otherwise **verbatim**. It passed before
  and after the extraction.
- New second `it` — *"a member clears its own device record and a manager clears a revoked
  member's leftovers"* — with its own two-node strand.
- New scan-based helpers in the file: `memberPeerStamp`, `revocationExists`, `memberKeys`.

`docs/architecture.md` → *End-to-end coverage*: removed the stale "⚠️ that assertion has
**not yet executed**" claim (it executes green now), and added a paragraph describing the
removal coverage, the observe-then-require rule, and what is still uncovered.

`docs/strands.md` → *Removing Members* was read and left alone; it already describes the
behaviour correctly.

## Verification actually run

| Command | Result |
|---|---|
| `yarn workspace @serfab/integration-tests test strand-membership-closed-strand` (before edit) | 1 passed, `sync=true`, 2.70 s test body |
| same, after edit | **2 passed**, 3.89 s + 3.39 s, 17.3 s file |
| `yarn lint` | clean |
| `yarn typecheck` | clean |

Console from the passing run, worth knowing because it is the interesting branch:

```
[closed-strand:removal] M's device rows observed on joiner=true (bootstrap sync=true);
                        cross-node removal checks GATE
```

So the conditional cross-node assertions **took the gating path**, not the skip path — the
joiner really did observe each removal propagate.

## NOT run — please run these

- **`yarn workspace @serfab/integration-tests test` (full suite).** Cut for budget. Nothing
  in the diff touches shared code, and the new test brings up its own nodes and tears them
  down in a `finally`, so collateral is unlikely — but it is unverified. Run it.
- The sibling `packages/cadre-core` suite. Untouched by this diff, same reasoning.

## Environment trap you will hit

The stale-build guard blocks every run in this package until `../quereus` is rebuilt, and it
tripped **three separate times** during this ticket. Each time the cause was the same and it
is *not* a real staleness: another worker is actively editing `C:\projects\quereus` (it has
uncommitted changes right now), and a file there gets its mtime bumped without its content
changing. `tsc` then correctly decides there is nothing to emit, leaves `dist` untouched, and
the guard — which compares mtimes — still reports stale. `yarn workspace @quereus/quereus
build` therefore appears to "do nothing" and the error repeats.

Workaround that actually clears it:

```sh
cd /c/projects/quereus/packages/quereus && rm -f dist/tsconfig.tsbuildinfo && npx tsc
```

Deleting the incremental state forces a full re-emit, which moves the `dist` mtimes. Expect
to need it again if the neighbouring repo is still being edited. **This is an observation
about the environment, not a defect to fix in this ticket** — the guard's mtime-vs-content
tradeoff is deliberate and documented at length in `test-harness/build-freshness.ts`.

## What the new test does, in order (order is load-bearing)

1. Bring up a two-node closed strand via the helper.
2. Admit a plain member **M** through the real `issueInvite` → `consumeInvite` flow.
   M is **never** promoted to manager — `Member.NotAManager` would refuse to un-member a key
   still holding a `Manager` row, and step 5 revokes M.
3. M registers **two** devices: the joiner node's real strand peer id, and a synthetic
   second. Both live `StampId`s are captured while the rows exist.
4. `listMemberPeers(founderDb, M)` equals both ids — the first networked execution of the
   leading-key scan as a public enumeration.
5. **Self removal** of the second device. Sibling survives; a `Strand.Revocation` row with
   `TableName='MemberPeer'` and the removed stamp is asserted present. This must precede the
   revocation: `Revocation.Authorized` verifies the tombstone filer against
   `committed.Member`, so a revoked M could no longer file one, and the failure would land
   on the tombstone rather than on the delete.
6. **Revoke M.** Its `Member` row is gone; `listMemberPeers(M)` still returns the remaining
   device — orphan survival, now on a real network.
7. **Manager cleanup loop** — `listMemberPeers` then one `removeMemberPeer` per id. List
   ends empty; the second tombstone is asserted present.
8. **Restart-safe re-clear** — calling `removeMemberPeer` again for the same `(M, peerId)`
   resolves quietly. This is the absence probe answering "absent" for a row that is genuinely
   gone, over the network.
9. **Loud-failure backstop, LAST.** Registers a device for the founder's own key, asserts it
   present, then attempts a bare `Strand.Revocation` insert naming that **live** row's stamp,
   correctly signed by a committed member — expected to throw `/RowIsGone/`.

## Honest gaps — do not read this as complete coverage

- **The `"still present after delete"` JavaScript re-check in `removeMemberPeer` is
  UNEXECUTED.** `Revocation.RowIsGone` fires first at commit, so the re-check behind it never
  runs in any test. Step 9 pins the constraint that *converts* a missed delete into a loud
  failure; it does not pin that re-check.
- **The point-lookup miss itself is not provoked.** It is nondeterministic and there is no
  fault-injection seam (the ticket explicitly said not to add one). The standing value is
  inverted: if the miss *does* occur during a run, this test fails loudly instead of passing
  — the scenario is now a detector for
  `debt-composite-pk-point-lookup-unreliable-untracked`.
- **Cross-node assertions are conditional.** They gate only when the joiner was first
  observed to see M's two rows appear. They gated on every run so far, but a slow or absent
  replica turns them into a logged skip rather than a failure. That is deliberate — the
  alternative flakes — but it means a green run does not by itself prove cross-node
  propagation was checked. Read the `[closed-strand:removal] … GATE|SKIPPED` line.
- **Concurrency is untested.** Nothing here drives two writers at one strand. The
  check-then-write race in `removeMemberPeer`/`registerMemberPeer` is documented as a
  `NOTE:` in `strand-membership-writer.ts` and was out of scope.
- **Permission/rejection semantics are not re-tested here** — they are settled in
  `cadre-core/test/strand-membership-peer-rotation.spec.ts` under bootstrap mode. This file
  adds network, not rules. Don't ask for them to be duplicated.

## Things worth an adversarial look

- The two `it`s share a `describe` and a file but nothing else. Confirm no identifier can
  collide across them (party ids, strand ids from the per-call provisioner, member keypairs).
- `requireJoinerAgrees` compares sorted arrays via `JSON.stringify`. Fine for peer-id
  strings; ugly if anyone later passes non-strings.
- The rejection floor: exactly one rejected write exists in the new `it` and it is last. Any
  future edit that adds an assertion after step 9, or a second rejected write anywhere,
  breaks the file's own stated rule.
- The helper asserts bring-up invariants with `expect` outside an `it` body (inside an
  `async` function the `it` awaits). Works, and vitest attributes the failure to the calling
  test — but a reviewer may want that confirmed by deliberately breaking one.
- Both `it`s call `bringUpClosedStrand` *outside* their `try`. That is intentional: the
  helper owns teardown for its own failures, so a `finally` that ran on a failed bring-up
  would double-stop. Check the reasoning holds.
