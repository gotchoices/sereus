description: When the last manager of a private group permanently freezes who belongs to it, we have only ever checked that the machine doing the freezing believes it. Add tests proving a second machine learns about it and refuses to let anyone in, and correct two documented claims that turn out to be wrong.
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, packages/cadre-core/src/strand-membership-writer.ts, schemas/strand.qsql, docs/architecture.md, docs/strands.md
difficulty: medium
----

# Seal propagation, proven on the node that did not seal

The plan pass ran the experiment before designing the tests. Everything below marked
**measured** was observed on a real two-node strand over libp2p; the raw logs are in
`tickets/.logs/strand-seal-binds-a-second-node.probe*.log` (git-ignored, auto-pruned —
the numbers that matter are reproduced here).

## What the experiment found

**The seal does arrive, fast, and whole.** After `sealStrand` committed on the founder,
the joiner reported `isStrandSealed` true at **t+42 ms** in one run and **t+138 ms** in
another. A poll with no sleep between attempts never once observed a *split* state — the
`Manager` delete without its `Strand.Revocation` tombstone, or the tombstone without the
delete. Both halves of the seal were visible together on the joiner at the first read that
saw either. (The two land in one transaction but in different blocks, so a split was the
thing worth looking for.)

**An arrived seal binds the joiner's schema, and the schema does the rejecting.** Every
admission path run against the joiner's own database after convergence, with the exact
constraint each one failed:

| Attempted on the joiner after it converged | Result |
| --- | --- |
| `issueInvite` with the ex-manager's key | rejected — `InviteValid` |
| `consumeInvite` redeeming an invite issued *before* the seal | rejected — `NotSealed (exists (select 1 from Manager))` |
| `addMemberByManager` with the ex-manager's key | rejected — `Authorized` |
| `addManager` re-promoting the ex-manager (who is still a member) | rejected — `Authorized` |
| `cancelInvite` with the ex-manager's key | rejected — `Authorized` |
| raw signed generation-0 re-founding `insert into Strand.Manager` | rejected — `Authorized` |
| `registerMemberPeer` / `removeMemberPeer` self-arm | **accepted** — member self-service survives a seal, as documented |

**⚠ One trap for the implementer, measured.** `addManager` on the joiner naming a *fresh*
key fails on **`MemberExists`**, not `Authorized` — a promotion of a non-member is refused
on a live strand too, so that shape pins nothing about sealing. The seal-specific shape is
re-promoting a key that **is** still a member; on a sealed strand the only such key is the
ex-manager itself, and that one fails on `Authorized`. Write the test that way.

**The propagation window cannot be produced by partitioning a two-node strand.** Two
attempts, both of which ended with the founder *unable to seal at all*:

- With `Strand.Revocation` never yet written, `sealStrand` failed with
  `Block default/Revocation is unavailable (cohort-unreachable): the repo could not
  determine whether it exists` — sealing is a fresh strand's first `Revocation` write, and
  a block whose existence cannot be determined cannot be written to.
- With `Revocation` pre-materialised (register then remove a device record first),
  `sealStrand` failed with `Failed to get super-majority: 1/2 approvals (needed 2, 0
  rejects)` on the `Manager` block.

So on a two-node strand the seal **fails closed** when the other node is unreachable: the
strand stays unsealed on both sides, and after the partition healed both nodes agreed on
that. The residual window is the commit-to-visibility lag measured above (tens of
milliseconds), not something a partition can widen.

This is a property of the *fixture*, not a guarantee of the system. A commit needs a
super-majority of the block's **cohort**, and in a two-node strand the cohort is both
nodes. Above the cohort size a node outside a given block's cohort never has to approve,
so it can stay stale for an unbounded time while the seal commits elsewhere — and *that*
node's window is unmeasured. Recorded as an arm on
`backlog/debt-replication-proof-above-cohort-size`.

## Two documented claims that are wrong

Both say the same false thing in two places, and both must be corrected as part of this
ticket. The claim is that during the propagation window **only the ex-manager's own key
gains anything**:

> `docs/architecture.md` (the ⚠️ **Still open** note in the `sealStrand` / manager-removal
> hazards paragraph): "*that one ex-manager's own key could still admit someone there until
> the delete arrives. Only that key; no stranger gains anything.*"
>
> `docs/strands.md` → *Who May Administer a Closed Strand*, the "**A seal only binds a node
> once it gets there**" bullet: "*Nobody else gains anything — no other key was ever a
> manager on that node either.*"

That is not what the schema says. `ConsumedInvite.NotSealed` is `exists (select 1 from
Manager)` over the rows **that node** can see, so on a node that has not converged on the
delete the gate passes, and the holder of an invitation issued before the seal — a
stranger, never a manager anywhere — can redeem it and join. The plan pass observed a
cut-off joiner accepting exactly that redemption (`consumeInvite` with a pre-seal invite,
by a fresh key, ACCEPTED); what it could not reach was the sealed precondition, because on
two nodes the seal fails closed. So: the *mechanism* is observed, the *composite* is
inferred from the schema text. Say so honestly in the docs rather than upgrading it to a
demonstrated exploit.

The second correction is the good news, and it belongs beside the first: the window is not
open-ended. State the measurement (both halves of the seal visible on the second node in
tens of milliseconds, no split state observed) and the scope limit (a strand larger than a
block's cohort has an unmeasured window; two nodes does not).

`docs/architecture.md` also says, of the convergence-hazard class, "*has no test for any of
them*" and "*Coverage is single-node only*". Once this ticket lands, seal propagation has a
test — qualify those sentences rather than deleting them; the `MemberExists` partition
hazard and `Revocation` tombstone replay are still uncovered.

## Where the tests go, and why

**Extend `strand-membership-closed-strand-e2e.integration.ts`. Do not open a sibling
file.** The decision is made; do not re-litigate it.

The seal cases need `bringUpClosedStrand`, `stopBoth`, `freshKeyPair`, `GATE`,
`managerKeys`, `memberKeys`, `inviteKeys` and `scanColumn` — roughly 400 lines of harness
that is currently private to that file. A sibling would either duplicate it (against the
repo's DRY rule) or require hoisting it into `src/harness/`, which is a refactor across six
passing network tests and belongs to its own ticket, not to this one. The file is 1349
lines today and lands around 1550 with this change, in line with its siblings.

Record the "if this grows again" concern as a tripwire comment (`NOTE:`) beside the new
block, not as a ticket: *if a third scenario ever needs this harness, hoist it into
`src/harness/` rather than duplicating it.*

Add the seal cases as their **own `describe` block** at the end of the file, and extend the
file header's opening paragraph — it currently enumerates "SIX independent tests" and
describes the file's scope, and that count and scope both change.

### Two new tests

Both use their own `bringUpClosedStrand` (each call is ~2-3 s; the file already does six).

**Test A — the founder's seal converges to the second node and binds its schema there.**

- Issue an invitation on the founder **before** the seal, and gate it visible on the joiner
  (`inviteKeys`). This is the pre-seal invitation the rejection block redeems later.
- Capture the founder's live `Strand.Manager.StampId` **before** sealing, so the tombstone
  assertion below is keyed rather than "some `Manager` tombstone exists".
- Assert the joiner currently sees the founder's `Manager` row — otherwise a later "no
  managers" assertion could pass because nothing ever arrived.
- `sealStrand` on the founder; assert `isStrandSealed(founderDb)`.
- **The gate:** `waitUntil(() => isStrandSealed(joinerDb))` on the shared `GATE` budget.
  A timeout here is a real convergence defect — no skip branch, matching the rest of the
  file.
- Assert the joiner's sealed shape, **all of it before any rejected write**: `managerKeys`
  empty, and a `Strand.Revocation` row carrying `TableName = 'Manager'` and the captured
  stamp. Absence and tombstone lookups **scan and filter in JavaScript** — never a full-PK
  where-equality — per the file's lookup-shape rule; `Revocation`'s primary key is
  `(TableName, StampId)`, so an equality on both is exactly the point lookup that rule
  forbids. The existing `revocationExists` helper already does this correctly.
- Then the rejection block against `joinerDb`, in this order, each `rejects.toThrow(...)`
  against the constraint name from the table above: `issueInvite` → `/InviteValid/`;
  `consumeInvite` of the pre-seal invitation by a fresh key → `/NotSealed/`;
  `addMemberByManager` → `/Authorized/`; `addManager` re-promoting the ex-manager →
  `/Authorized/`.
- **No count or enumeration assertion may follow the rejection block** — the file's
  rejection floor. Everything about state is asserted above it.

**Test B — a sealed strand cannot be re-founded from the node that did not seal it.**

- Bring up, seal on the founder, gate `isStrandSealed(joinerDb)`.
- Assert the joiner's state first: `managerKeys` empty, `memberKeys` holds exactly the
  founder.
- Then the claim: a **signed** generation-0 `insert into Strand.Manager` against
  `joinerDb`, shaped exactly like the one in
  `cadre-core/test/strand-seal.spec.ts` → "refuses a SIGNED re-founding attempt at
  generation 0", `rejects.toThrow(/Authorized/)`.
- Nothing after it, for the same floor reason. The local spec already pins the post-state;
  what this test adds is *the other machine*.

Keep Test B separate from Test A rather than appending it: A's claim is "the seal binds",
B's is "the seal is irreversible", and A's rejection block has already spent its budget for
post-write assertions.

### What deliberately gets no test

**The propagation window.** It cannot be staged on two nodes (measured above), and the
fail-closed behaviour that prevents it is an optimystic quorum property that could
legitimately change — asserting it would pin a dependency's internals and fail as a false
alarm the day solo-cohort commit reaches that block. Record it instead as a `NOTE:` comment
beside the new tests, naming both observed failure strings, so the next person who tries
does not repeat the experiment. Then say the same thing in one line in `docs/architecture.md`.

## Edge cases & interactions

- **A gate that times out is a defect, not a slow machine.** The file's `waitUntil`
  swallows a throwing condition and reports a bare timeout, so if the new gate ever
  expires, check the harness debug log for `Wait condition threw:` before concluding
  non-convergence. Do not add a skip branch.
- **Visibility is not physical replication.** The joiner's post-seal reads may be served
  remotely by the founder as coordinator. These tests claim *visibility*, which is what an
  application observes; do not let a comment overclaim that the seal's blocks live in the
  joiner's store. The file's fourth and sixth tests are where physical presence and offline
  durability are proven, and this ticket does not extend them.
- **Solo-cohort commit and certifiability.** The plan pass confirmed the seal's blocks
  commit fine on a connected two-node strand (both probe runs sealed successfully), so the
  0.27.0 proof-minting path is not a blocker here — the scenario file's historical reason
  for being blocked does not apply.
- **`addManager` rejects for two different reasons** — see the trap above. A test that
  pins `MemberExists` is testing promotion-of-a-non-member, not sealing.
- **The pre-seal invitation must be gated visible on the joiner before the seal**, or the
  `NotSealed` rejection could instead be an `InviteExists` failure and the test would pass
  for the wrong reason.
- **`Revocation` tombstone scans, not seeks** — stated above; it is the single most likely
  way this test silently passes on a networked strand while asserting nothing.
- **Founder-side state after the seal** — both probe runs ended with founder and joiner
  agreeing (`managers=[]`, one member, `sealed=true`). If they ever disagree, that is the
  finding, not something to work around.
- **Do not weaken the guarantee to make a test pass.** If the joiner fails to converge, or
  accepts an admission it should refuse, file it as a defect against the writer or schema.
  Do not relax a gate or a constraint pattern.

## TODO

- [ ] Extend the file header: the "SIX independent tests" enumeration and the scope
      paragraph, so a reader meets the seal cases where they meet the rest.
- [ ] Add the seal `describe` block with Test A (convergence + schema binding on the
      joiner) exactly as specified, including the pre-seal invitation setup and the
      keyed tombstone assertion.
- [ ] Add Test B (re-founding refused on the joiner).
- [ ] Add the `NOTE:` tripwire comments: the harness-hoist condition, and the two observed
      failure strings that make a partition-staged window untestable on two nodes.
- [ ] Correct `docs/architecture.md`: the false "no stranger gains anything" claim, the
      window measurement and its cohort-size scope limit, and the now-partly-stale "no test
      for any of them" / "single-node only" sentences.
- [ ] Correct `docs/strands.md` → *Who May Administer a Closed Strand*, the "A seal only
      binds a node once it gets there" bullet, in the same plain language the rest of that
      section uses — a stranger holding an invitation issued before the seal can still join
      at a node that has not heard about the seal yet.
- [ ] Consider the same correction in `schemas/strand.qsql` — the `Manager` table's
      seal-propagation `NOTE:` (around line 408) does not itself make the false claim, but
      `ConsumedInvite.NotSealed`'s comment is the place a reader would look to learn that
      the gate is locally evaluated. One sentence there, no more.
- [ ] Run `yarn workspace @serfab/integration-tests exec vitest run
      src/scenarios/strand-membership-closed-strand-e2e.integration.ts` in the foreground
      (all eight tests, not just the new two — the header change and the new block must not
      disturb the six that pass today), plus `yarn lint` and the package typecheck.
