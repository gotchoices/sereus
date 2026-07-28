description: Anyone able to write to a party's control database can make themselves a top-level owner of it, and can also delete every existing owner. Both holes are confirmed by measurement; close them so only an owner that already existed can enroll or remove another, and the party can never be left with no owner at all.
files: schemas/control.qsql (OwnerKey table, lines 4-17), packages/cadre-core/src/control-schema.ts (mirrored CONTROL_SCHEMA, lines 15-28), packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts, docs/architecture.md (line 321, the trusted-owner-anchor paragraph)
difficulty: medium
----

# `CadreControl.OwnerKey` — self-authorization and unauthorized deletion, both measured

## What was measured

Nine probes were run against a real control database (a `CadreNode` with an empty bootstrap
list and the `transaction` profile — the harness `control-authorization-binding.spec.ts`
uses), each on its own freshly-booted node seeded with one founding owner via
`ensureOwnerKey`. **Six attacks succeeded**:

| # | Attack | Pre-fix result |
|---|--------|----------------|
| 1 | A key holding no owner row inserts itself, signing its own row, naming itself `context.OwnerKey` | **accepted** |
| 2 | Two non-owner keys inserted in ONE transaction, each signing the other's row | **accepted** |
| 3 | Unsigned `delete` of a real owner row while two owners exist | **accepted** |
| 4 | Unsigned `delete` of the LAST owner row (table left empty) | **accepted** |
| 5 | Unsigned `update` re-pointing the sole owner row at an attacker key | **accepted** |
| 6 | Unsigned delete-of-founder + insert-of-attacker in ONE transaction (sole-owner swap) | **accepted** |

Two diagnostics ran alongside to pin the *mechanism*, and both behaved as hoped, so the
diagnosis is not "the constraint never runs":

- A **garbage signature** on the attack of row 1 is **rejected** — the CHECK genuinely
  evaluates on insert, so row 1 is accepted specifically because the deferred subquery
  matches the row being inserted.
- An **unsigned update while TWO owners exist** is **rejected** — so `UPDATE` *is*
  constrained, and row 5 succeeds by riding the bootstrap branch (`count(1) <= 1` is true
  of the post-update image, which still holds exactly one row).

The three root causes:

- **Self-satisfying authorizer subquery** (rows 1 and 2). The `Authorized` CHECK carries a
  subquery, so Quereus defers it to COMMIT and evaluates it against the POST-mutation row
  set. The row being inserted — and any sibling row from the same transaction — is
  therefore already visible to `exists (select 1 from OwnerKey A where A.Key =
  context.OwnerKey ...)`. This is the same defect that was measured and closed in
  `Strand.Manager` (`strand-manager-authorization-hardening`,
  `strand-manager-same-txn-mutual-promotion`).
- **`delete` is not covered at all** (rows 3, 4, 6). A bare `check (...)` defaults to
  insert + update; the constraint never names `delete`, so removing an owner key requires
  no authorization whatsoever. Combined with the bootstrap branch this is a two-step total
  takeover: delete every owner row, then insert your own key as the "first" owner.
- **The bootstrap branch is not gated to the founding state** (rows 5 and 6). `(select
  count(1) from OwnerKey) <= 1` is a post-image count, so it is also true of an update
  that leaves one row and of a same-transaction swap that leaves one row.

There is also **no minimum-one-owner floor**: a control database with zero owner keys can
authorize nothing further (every other `CadreControl` table's CHECK requires an `OwnerKey`
row), so emptying the table is a permanent, unrecoverable denial of that party's control
plane.

## Severity — what an attacker actually needs

Not an anonymous internet write. The attacker needs write access to the party's control
collection, which travels over the Optimystic control-DB protocols
(`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`) on the party's control
network. Establishing what guards that:

- Those protocols expose **no per-stream authorization hook** — see the blocked ticket
  `control-repo-protocol-stream-authz-optimystic`, and the module doc of
  `packages/cadre-core/src/membership-connection-gater.ts`, which names itself the current
  outermost defense for them.
- That gate is a **connection** gate and is **deliberately fail-open**: any error, missing
  dependency, or ambiguous state admits. It also suspends stranger denial entirely while
  the node has an unexpired, not-fully-consumed open formation invitation outstanding.

So the clearly-reachable attacker is an **already-admitted cadre peer** — a drone node that
should never hold owner authority — escalating itself to owner. An outsider admitted during
a formation-invite window or through a fail-open decision is a second, narrower path. The
ticket's caution about the optimystic-side `debt-mesh-client-signature-enforcement` stands:
do not describe the network layer as stopping this.

What a self-made owner gains: minting `FormationInvite` rows (cross-party strand formation
consent), creating `Strand` rows, enrolling `ValidationKey` rows, vouching and — critically
— **deleting** `CadrePeer` and `DeviceToken` rows, i.e. evicting the real cadre. Peer
*vouching* is blunted at read time (`CadreNode.isAuthorizedMember` re-checks the stored
`VouchOwner` against the node-local `TrustedOwnerStore`, not this table), but eviction,
invite minting and strand creation are not.

**This fix does not turn the replicated `OwnerKey` table into a trust anchor, and
`docs/architecture.md` must keep saying so.** A brand-new node with an empty local copy
still has an empty pre-transaction snapshot, so it can still seat its own key as a founder
and let that row replicate. The node-local trusted-owner anchor remains the real anchor.
What this fix closes is escalation and destruction against a control database that is
*already populated*.

## The fix — validated by measurement, simpler than the `Generation` port

The source ticket suggested porting `Strand.Manager`'s `Generation integer not null`
mechanism. **That is not necessary here**, because the control schema can use something the
strand schema does not: Quereus's **`committed.<Table>` pseudo-schema**, a read-only view of
the PRE-transaction snapshot, pinned at transaction start. `CadreControl` already depends on
it (`FormationUsage.Monotonic` reads `committed.FormationUsage`), and the Optimystic vtab was
specifically taught to honour Quereus's `_readCommitted` flag for exactly that constraint —
see the header comment of
`packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts`.

Reading the authorizer set from `committed.OwnerKey` states the intended rule *directly*:
the authorizer must have existed **before this transaction**. That kills self-insertion,
mutual pairs, and rings of any length in one stroke, with no extra column, no writer change,
and no signed-payload change.

The exact replacement for the `OwnerKey` constraint block — this text was applied to
`CONTROL_SCHEMA`, and all nine probes plus the full `@serfab/cadre-core` suite were run
against it (see *Validation already performed*). Reuse it verbatim, then re-comment it to
the surrounding density:

```sql
        constraint MinOneOwner check on delete (
            (select count(1) from OwnerKey) >= 1
        ),
        constraint NoUpdate check on update (false),
        constraint Authorized check on insert, delete (
            -- Bootstrap: first owner key needs no existing authorization
            (old.Key is null and (select count(1) from committed.OwnerKey) = 0)

                -- or an owner that existed BEFORE this transaction authorizes by signing over THIS row
                or (old.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and verify(digest(new.Key, new.StampId), context.Signature, A.Key, 'ed25519')))

                -- or a removal authorized by ANOTHER pre-existing owner over a remove-scoped digest
                or (new.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and A.Key <> old.Key and verify(digest(old.Key, old.StampId, 'remove'), context.Signature, A.Key, 'ed25519')))
        )
```

Why each piece is there:

- **`committed.OwnerKey` in both `exists` branches** — the authorizer must pre-date the
  transaction. No row can authorize itself; siblings inserted in the same transaction are
  invisible to each other as authorizers.
- **`(select count(1) from committed.OwnerKey) = 0`** — the bootstrap branch now means what
  it says: the party had *no* owner before this transaction. The post-image count could not
  express that, which is what let the sole-owner swap through.
- **`old.Key is null` / `new.Key is null`** — separates the insert branches from the delete
  branch, so an enrollment can never be evaluated by the removal rule or vice versa.
- **`check on insert, delete`** — deletes are now authorized at all. This is the single
  largest behavioral change.
- **`NoUpdate check on update (false)`** — no writer updates an `OwnerKey` row (the only
  production writer is `ControlDatabase.insertOwnerKey`), and the old
  `old.Key is not null and old.Key = context.OwnerKey` self-rotation branch was dead code
  that doubled as the sole-owner takeover. Mirrors `Strand.Manager.NoUpdate`. Rotation is
  add-then-remove.
- **`digest(old.Key, old.StampId, 'remove')`** — a distinct, `'remove'`-scoped payload bound
  to the stored row's nonce, so an enrollment signature can never be replayed as a removal.
  Same idiom as `CadrePeer.AuthorizedDelete`.
- **`A.Key <> old.Key`** — an owner cannot sign its own removal. Self-resignation is
  deliberately not offered (the source ticket specifies "a signature from a *different*
  existing owner"); if a resignation path is ever wanted it is a separate, signed branch.
- **`MinOneOwner check on delete`** — the floor the source ticket asked about. It is
  deferred (it carries a subquery), so the count it sees is the post-delete count. Answer to
  "should removing the last owner key be possible?": **no** — an owner-less control database
  can never authorize anything again.

Add a `NOTE:` beside `MinOneOwner` mirroring the one on `Strand.Manager.MinOneManager`: it is
a per-transaction check against locally visible rows, so two partitioned nodes each removing
a different owner can each see a survivor and still converge to zero. That is a tripwire, not
work for this ticket.

### Writers are unchanged

`ControlDatabase.insertOwnerKey` (`packages/cadre-core/src/control-database.ts:545`) keeps
working untouched: it is the genesis path, it supplies a fresh unique `StampId`, and on a
fresh party `committed.OwnerKey` is empty. No column is added, so no caller signature
changes. No production code enrolls a second owner or deletes an owner today — the
enroll path is exercised only by `control-authorization-binding.spec.ts` driving raw SQL,
and nothing deletes owner keys at all. **Do not add speculative writers**; if a later admin
flow needs them, the digest shapes are documented above and in the schema comments.

### Both schema copies must move together

`schemas/control.qsql` and `CONTROL_SCHEMA` in
`packages/cadre-core/src/control-schema.ts` are byte-equivalent by contract, enforced by
`packages/cadre-core/test/control-schema-drift.spec.ts`. Edit both; the drift guard is the
one test that will fail if you forget.

## Tests to write

Recreate the probe suite as `packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts`
(it was written, run, and removed during the fix stage so the tree stayed green). Harness:
mirror `control-authorization-binding.spec.ts` — `generatePrivateKey` / `getPublicKey` /
`sign` / `randomBytes` from `@optimystic/quereus-plugin-crypto`, a `CadreNode` with
`{ controlNetwork: { partyId: <unique>, bootstrapNodes: [] }, profile: 'transaction' }`,
`node.getControlDatabase()!.getDatabase()` for raw SQL, and
`buildAuthorizationMessage` from `control-database.js` for every signed payload. Two harness
points that matter:

- **A fresh node per test**, torn down in `afterEach`. These attacks mutate the owner set
  (one of them empties it pre-fix), so a shared database leaks state between probes. Boot is
  ~1s; give each test a 60s budget.
- **An explicit-transaction helper** for the multi-statement attacks —
  `beginTransaction()` / `commit()`, rolling back in a `catch` and swallowing the
  "no transaction active" error a failed `commit()` leaves behind. Copy the shape of
  `inTransaction` in `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts:263`.

Cover, all expecting rejection with the row set unchanged:

- A stranger enrolling itself by signing its own row.
- Two strangers seating each other in one transaction (mutual promotion).
- An unsigned delete of one owner while two exist.
- An unsigned delete of the last owner.
- An unsigned update re-pointing the sole owner row.
- An unsigned delete-of-founder + insert-of-attacker in one transaction.
- The garbage-signature negative control, so a future regression that disables the
  constraint outright cannot masquerade as a pass.

Plus these acceptance tests, so the fix is not merely over-rejecting everything:

- Genesis: `ensureOwnerKey` on a fresh party still seats the founder (already implicit in
  every test's setup, but assert it).
- A pre-existing owner enrolls a second owner with a row-bound signature over
  `[Key, StampId]`.
- A pre-existing owner removes another owner with a signature over
  `[Key, StampId, 'remove']`.

Consider also adding a signed-remove case that proves an *enrollment* signature is rejected
as a removal (and the converse), mirroring the cross-direction replay test
`strand-membership-peer-rotation.spec.ts` gained during the `Strand.Manager` review. The
`'remove'` scoping makes this hold by construction; nothing pins it yet.

## Validation already performed (during the fix stage, on the candidate schema)

- All nine probes above **fail** on the current schema in exactly the six ways tabulated,
  and all **pass** with the candidate constraint applied.
- `yarn vitest run` in `packages/cadre-core` with the candidate applied to `CONTROL_SCHEMA`
  only: **783 passed, 1 skipped, 1 failed** — and the single failure is
  `control-schema-drift.spec.ts`, precisely because the experiment deliberately patched one
  of the two copies. No other cadre-core test changed behavior; in particular the existing
  `OwnerKey happy path: an existing owner can enroll a new owner` in
  `control-authorization-binding.spec.ts` still passes.
- The experiment was reverted; the working tree carries none of it.

Not run during the fix stage, and worth running during implement: `packages/cadre-host`
(its `trust-circle-integration.test.ts` inserts an owner key) and `yarn lint` /
`yarn typecheck`. The `integration-tests` package is largely blocked behind
`control-db-convergence-optimystic-p2p` — see `tickets/.pre-existing-known.md` and do not
re-report those failures.

## Docs

- `docs/architecture.md` line 321 (the trusted-owner-anchor paragraph) explains that the
  replicated `OwnerKey` table cannot anchor trust because a connecting node can
  genesis-insert its own key locally. **That statement stays true after this fix** — see the
  severity section above. If it is touched at all, it should be sharpened, not retracted:
  the genesis-insert path survives only on a node whose local copy is genuinely empty.
- `docs/architecture.md` line 34 (the control-table summary) and the security discussion
  around it should gain a line that owner enrollment and removal are now authorized against
  the pre-transaction owner set, and that the table can never be emptied.

## TODO

Phase 1 — schema

- Replace the `OwnerKey` constraint block in `schemas/control.qsql` with the validated text
  above, commented to match the surrounding density, including the `MinOneOwner` partition
  `NOTE:`.
- Mirror the identical text into `CONTROL_SCHEMA` in
  `packages/cadre-core/src/control-schema.ts`.
- Run `control-schema-drift.spec.ts` first — it is the cheapest confirmation the two copies
  match.

Phase 2 — tests

- Add `packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts` with the attack
  probes, the negative control, and the acceptance cases listed above.
- Add the cross-direction signature-replay case (enrollment signature rejected as a removal,
  and the converse).

Phase 3 — validation and docs

- `yarn lint`, `yarn typecheck`, `yarn test` in `packages/cadre-core`, and the
  `packages/cadre-host` suite; stream output with `tee`.
- Update `docs/architecture.md` per the *Docs* section — sharpening the trust-anchor
  paragraph rather than removing it.
- Hand off to `review/` honest about what is *not* covered: nothing exercises this over a
  real multi-node control network (blocked behind `control-db-convergence-optimystic-p2p`),
  and per project policy there is no migration for control databases written before the
  change.
