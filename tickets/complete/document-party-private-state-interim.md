----
description: Documented where consumers should put per-user app state (read position, drafts, preferences) until the real party-private storage facility ships, and warned that the interim spot is readable — and writable — by every strand member.
files: docs/strand-contracts.md, docs/strands.md, docs/schema-guide.md
difficulty: easy
----

# Document the interim answer for party-private app state — complete

Answers **gotchoices/sereus#6**. Documentation only; no code or schema changes. The real facility
stays deferred in `backlog/feat-party-private-app-state`.

## What shipped

- **`docs/strand-contracts.md`** — new section "Party-Private App State (Interim)" between
  "sApp Integration" and "Self-Contained Storage: `Strand.Document`". States the interim answer
  (store the value in the strand database keyed by owning party), the read-visibility caveat
  (every member can read every row regardless of key), the new write caveat (see below),
  node-local storage ruled out (never replicated, so state does not follow a party to a second
  device), and one migration sentence. Says nothing about the future facility's shape.
- **`docs/strands.md`** — Terminology `strand` bullet cross-references the new section.
- **`docs/schema-guide.md`** — bullet in "Practical Guidance & Patterns" pointing at the same
  section (added in review; see findings).

## Review findings

**Diff read first, then the handoff.** Verified every factual claim against the code and the
other docs rather than against the summary.

### Fixed inline (minor)

- **Caveat covered reads only.** A per-party key partitions by owner but also does not stop
  another member *writing* that row — the doc left a reader believing the key was some kind of
  ownership boundary. Added a paragraph to the new section saying so and pointing at the
  mutation-context check-constraint pattern (`schema-guide.md` → Roles & Permissions) as the way
  to actually gate writes on the writer's identity.
- **Wrong doc for the audience.** `strand-contracts.md` is about human legal agreements on
  strands; an sApp author deciding "where does read position live" reads `docs/schema-guide.md`,
  which the implement pass never touched and which the original ticket did not name. Added one
  bullet there linking to the interim section.

### Checked, no change needed

- **Anchors resolve.** `strand-contracts.md#party-private-app-state-interim` matches the heading's
  GitHub slug; the new `schema-guide.md#roles--permissions-schema-enforced-via-context` link
  matches its heading (the `&` drops, leaving the double dash).
- **Referenced file exists.** `packages/cadre-core/src/node-local-snapshot.ts` is present and is
  in fact the never-replicated store the section claims.
- **The visibility-vs-replication wording holds.** `docs/cadre-consistency.md` describes strand
  data as replicating to a subset of nodes (`DEFAULT_STRAND_CLUSTER_SIZE`, 4), not to every node.
  The section's "every member can *read* every row" framing is a visibility claim, not a physical
  replication claim, so the two do not conflict and the section survives a change to that
  constant. The implementer's reasoning here was correct; `cadre-consistency.md` needs no note.
- **Closed strands do not weaken the caveat.** A closed strand's read gate is the control-layer
  `Strand.MemberPrivateKey`, which every member of the strand holds — so "every member can read
  every row" is true on closed strands too, which is the case the caveat matters most for.
- **No doc claims a party-private store already exists.** Re-checked `architecture.md`,
  `cadre-consistency.md`, `strands.md`, `reference-app-rn.md`, `strand-contracts-review.md`.
- **`schemas/chat-simple.qsql` correctly left alone.** It has no per-user table and the ticket
  explicitly forbade inventing one for illustration.
- **Doc matches the decision.** "No facility today, none before initial release, shape undecided"
  is exactly what `backlog/feat-party-private-app-state` records.

### Filed as tickets

None. The two findings were one-paragraph doc fixes at their own sites, with no class behind them
to retire with an invariant.

### Tripwires

None recorded. Nothing in this change is conditional-on-later-growth — the caveat is a standing
property of strand-database membership, not a threshold that trips at some size.

## Validation

- `yarn lint` — clean (exit 0). Note that ESLint does not cover markdown; this only confirms the
  change broke nothing in the code gate.
- **Tests not run.** The diff touches three `.md` files and no code, schema, or test surface, and
  the full suite includes integration tests that exceed the ten-minute agent budget. There is no
  test that could observe this change.
- Read-through: both new sections read standalone, neither promises a shape for the future
  facility, and all four cross-reference anchors resolve.
