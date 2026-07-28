description: Two strangers could seize control of a private group by vouching for each other in a single step and then evicting the real administrators. That hole is closed — each administrator record now carries a number saying how far it sits from the group's founder, and every appointment must be signed by someone strictly closer.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, docs/strands.md, docs/architecture.md
----

# `Strand.Manager` generation ordering — same-transaction mutual promotion closed

## What shipped

`Strand.Manager` gained a `Generation integer not null` column, and `Manager.Authorized`
went from three branches to four:

- **Bootstrap** (insert) — unchanged founding-state gates, plus `new.Generation = 0`.
- **Self-resignation** (delete) — unchanged.
- **Promotion** (insert) — the authorizer must be a `Manager` row with
  `A.Generation < new.Generation` (strict), and the signed payload is
  `new.MemberKey || '|' || new.Generation`, so the generation is bound into the signature.
- **Removal by another manager** (delete, split out of the old shared branch) — keeps the
  bare `digest(old.MemberKey)` payload and deliberately carries no generation condition,
  so a later-generation manager can still remove an earlier-generation one.

The closure argument: the deferred CHECK still sees same-transaction sibling rows as
existing managers, but among any set of rows inserted in one transaction the
minimum-generation row cannot find an authorizer of strictly smaller generation among its
siblings — so its authorizer must pre-date the transaction and have genuinely signed.
Mutual pairs, rings of any length, equal generations, and below-zero generations all fail
on this.

Writer (`strand-membership-writer.ts`): the founder is seated at generation 0;
`addManager` reads the authorizer's generation, seats the new manager at that value + 1,
and signs `` `${newManagerKey}|${generation}` ``; a missing authorizer row falls back to
generation 1 without throwing, leaving the schema as the rejector. `removeManager` is
behaviorally unchanged.

Both schema copies (`schemas/strand.qsql` and `STRAND_SCHEMA`) were edited together; the
drift guard passes. `docs/strands.md` and `docs/architecture.md` describe the new rule and
no longer list the takeover as an open gap.

## Review findings

### Checked

- **The constraint, adversarially, branch by branch.** Constructed and reasoned through:
  mutual pairs, three-key rings, equal generations, negative generations, a stranger
  claiming generation 0 post-bootstrap, self-promotion, cross-branch signature replay
  (add-signature-as-removal and the converse), a delete riding along in the attack
  transaction, `UPDATE` as an escape hatch, and the interaction with the separately
  tracked unauthorized-`Member`-delete hole (`bug-strand-member-delete-unauthorized`).
  None of them get through. Two properties are load-bearing and both hold: `Manager` has
  `NoUpdate check on update (false)`, so a seated generation can never be mutated; and the
  promotion branch's `exists` runs against the post-image, so an attacker row can never
  become an authorizer without a pre-existing manager's real signature.
- **Whether the closure survives non-integer generations.** The minimum-generation
  argument needs only that `<` is a *strict order*, which holds under every plausible
  comparison semantics (integer, mixed-type storage-class ordering, or a NULL result for
  incomparable operands). A NULL generation is inert in both directions — it can neither
  be seated (`NULL < n` is falsy) nor authorize. So no type-confusion variant reopens the
  hole, and no extra guard is warranted.
- **Attacker-chosen generation values.** Confirmed the implementer's judgment call: the
  schema enforces ordering only, so a manager may seat a successor at an arbitrarily large
  generation. That grants no power (generation is lineage, not privilege) and has no
  exhaustion angle — the only consequence is arithmetic saturation, parked as a tripwire
  below.
- **Promote-and-resign in one transaction is rejected**, because the authorizer must be in
  the post-image. That matches the documented add-then-resign hand-off order and is already
  pinned by an existing test — consistent, not a regression.
- **Every repo-wide reader of `Strand.Manager`.** All select named columns; there is no
  `select *` consumer, so the added column breaks no caller.
- **Docs against the code.** `docs/architecture.md` and `docs/strands.md` both reflect the
  new rule; the stale "two keys can promote each other" gap bullet and the dangling
  `tickets/fix/strand-manager-same-txn-mutual-promotion.md` pointer are gone.
  `docs/STATUS.md` covers unrelated subsystems and needed no edit.
- **Validation.** `yarn lint` and `yarn typecheck` clean. `@serfab/cadre-core`: 774 passed
  / 1 pre-existing skip (54 files). `@serfab/quereus-plugin-sereus`: 56 passed, plus the
  4 failures in `test/e2e/networked.e2e.spec.ts > connectToStrand (networked e2e)` that
  `tickets/.pre-existing-known.md` already tracks under
  `control-db-convergence-optimystic-p2p` — not re-reported. Note that cadre-core consumes
  the plugin's built `dist`, so the plugin must be built before running its tests.

### Found and fixed in this pass (minor)

- **Two coverage gaps, both now tested** in `strand-membership-peer-rotation.spec.ts`:
  - *No test pinned that the ordering guard does not over-reject.* A batch of promotions
    in one transaction is legitimate when the batch has a root outside it (founder seats A
    at 1, A seats B at 2, one commit). Added an acceptance test — it passes, so the guard
    rejects rings without breaking legitimate batching.
  - *`docs/strands.md` claims an "add X" approval can no longer double as "remove X",
    and nothing tested it.* Added a test covering both directions: a promotion signature
    (`key|generation`) rejected as a removal, and a removal-shaped signature (bare key)
    rejected as a promotion.
- **Duplicated prose.** `addManager`'s JSDoc restated the schema's anti-takeover argument
  nearly verbatim — six copies of the same paragraph existed across schema comments, the
  writer, and two docs. Trimmed the writer's copy to a short statement plus a pointer, so
  the invariant has one home.

### Found and filed as new tickets (major)

None. No attack shape I could construct defeats the constraint, and no defect in the
writer, tests, or docs rose above the fixes listed above.

### Tripwires recorded (conditional, not tickets)

- **Generation arithmetic saturates.** `addManager`'s `+1` is a no-op at
  `Number.MAX_SAFE_INTEGER`, which would emit a row the schema then rejects as
  equal-generation. Unreachable while generations only grow by 1 from 0, but the schema
  enforces ordering rather than adjacency, so a manager *may* seat a successor at any
  larger value. Parked as a `NOTE:` at the arithmetic in `strand-membership-writer.ts`.
- **The authorizer generation lookup is a single-column full-primary-key point seek**, the
  shape observed to miss on a networked strand. A miss falls back to generation 1, which
  still succeeds for a founder authorizer and spuriously rejects a generation ≥ 1 one — an
  availability failure, never a security one. The implementer's existing `NOTE:` at the
  lookup stays; no new ticket, because
  `backlog/debt-composite-pk-point-lookup-unreliable-untracked` already names this exact
  query and explicitly rules pre-emptive call-site rewrites out of scope pending evidence
  that single-column seeks are affected at all.

### Known limitations carried forward (unchanged by this work)

- **Networked mode is unvalidated.** All coverage runs in bootstrap mode; the networked
  path — including the `addManager` call in
  `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts` —
  is blocked behind `control-db-convergence-optimystic-p2p`.
- **No migration for pre-existing rows.** Per project rules there is no backwards
  compatibility yet, so a `Manager` row persisted before this change has no `Generation`
  and its writes will fail after upgrade. Expected, not handled.
- **Signature replay is still open** in the narrowed form: a captured removal approval can
  be replayed as a later removal, and a captured appointment can be re-used if the same
  generation becomes seatable again. Tracked as
  `backlog/bug-strand-manager-authority-antireplay`.
- **`MinOneManager` is a per-transaction local count**, so partitioned nodes removing
  different managers can still converge to zero. Noted in the schema next to the check.
- **`tickets/fix/bug-control-ownerkey-self-authorization`** carries a pointer to probe the
  same-transaction mutual variant in the control schema and port this mechanism if it
  reproduces — the `<>`-style exclusion alone will not close it there either.
