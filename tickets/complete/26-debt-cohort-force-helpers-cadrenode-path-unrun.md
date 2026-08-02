description: Test helpers that pin a fixed set of machines (and a fixed leader) for a shared write accept three kinds of node; the third kind had no test at all because the only scenario using it is blocked on an unrelated bug in a sibling library. Reviewed, and covered that kind directly instead of waiting for the blocked scenario.
files: packages/integration-tests/src/harness/forced-cluster.ts, packages/integration-tests/src/harness/key-network-patch.ts, packages/integration-tests/src/scenarios/control-cohort-harness-helpers.integration.ts, docs/STATUS.md, tickets/.pre-existing-known.md
----

# Complete: `CohortNodeSource` widening — reviewed, coverage gaps closed inline

## What was under review

`packages/integration-tests/src/harness/forced-cluster.ts` exports `forceFullCohort`
(force a fixed multi-node write-consensus group) and `pinCoordinator` (force which of
those nodes coordinates the write). Their node parameter type `CohortNodeSource`
(`forced-cluster.ts:77`) accepts three shapes — a real `CadreNode`, a harness
`TestCadreNode`, and a bare started `Libp2p` — discriminated in `resolveControlLibp2p`
(`forced-cluster.ts:90-109`).

The implement pass made no code changes; it verified the prior ticket's claims and
edited docs. This review re-verified those claims and then closed the coverage gaps the
handoff had written off as unreachable.

## Review findings

**Checked:** the implement-stage diff (`1154696` — ticket move only) and the plan-stage
docs diff (`ae0d41e`); the current source of `forced-cluster.ts`, `key-network-patch.ts`
and `control-cohort.ts`; the existing test file; `docs/STATUS.md`'s coverage checklist;
`tickets/.pre-existing-known.md`; and the board (`grep -rl` over
`backlog|fix|plan|implement|review` for `forced-cluster|pinCoordinator|resolveControlLibp2p`
— two hits, both consumers of the helpers, neither claiming their unit coverage).

**Fixed inline (minor):**

- **`CadreNode` branch of `resolveControlLibp2p` had zero coverage, and the handoff's
  claim that it "can't be" covered in this repo was wrong.** The branch is discriminated
  purely by the presence of `getControlNode`, so it does not need a booted cadre — only a
  source of that shape. Added `accepts a CadreNode-shaped source, reading through
  getControlNode` and `blames an unstarted CadreNode rather than dialling nothing`
  (`getControlNode()` returns `null` before `start()`; forcing on that would build an
  addressless cohort entry that reads downstream as a dial failure). Both were unrun
  before.
- **`resolveControlLibp2p`'s null / non-object guard had no test** — added
  `rejects a non-object source by naming what it got`.
- **`pinCoordinator` had no direct tests at all**, despite being half of the widened API
  and the mechanism every degradation scenario's determinism rests on. Added three:
  candidate order and the `excludedPeers` fallback (the transactor's re-coordination
  path) plus the all-excluded throw; the candidates-first re-keying of the cohort with
  membership asserted unchanged; and the empty-candidate-set throw. All are
  non-vacuous — each fails without the pin installed.
- **`docs/STATUS.md` sentence was mangled** by the plan pass: the blocked-status note had
  been inserted mid-sentence, splitting `…integration.ts` from its `— the third flavour…`
  description. Moved the note to the end of the entry, unchanged in substance.
- **`docs/STATUS.md` had no entry for
  `control-cohort-harness-helpers.integration.ts`** even though the whole "the widening is
  proven" claim rests on it. Added one to the coverage checklist next to its two
  dependants.
- Updated the test file's header to match what it now covers.

**Filed as tickets (major):** none. Nothing found rose above "fix it here" — the code
under review is small, the discriminator is documented at its site, and the only real
gaps were missing tests, which are now written.

**Parked as tripwires (conditional):** one. A structural `CadreNode` stand-in cannot
catch a `CadreNode` that later *gains* a `libp2p` property — that would silently re-route
`resolveControlLibp2p` to the `TestCadreNode` branch with no test failing. Recorded as a
`NOTE:` on `asCadreNodeSource` in
`packages/integration-tests/src/scenarios/control-cohort-harness-helpers.integration.ts`,
pointing at the existing warning in `resolveControlLibp2p`'s doc comment. Conditional, so
not a ticket.

**Not re-run, deliberately:** `control-write-degraded-cohort-member.integration.ts`. Its
`beforeAll` times out (~64 s) on an upstream `../optimystic` coordinator-cache bug already
tracked as `blocked/transactor-key-network-ignores-network-scoping` and already listed in
`tickets/.pre-existing-known.md` (line 28) with a 2026-08-02 reconfirmation. Re-chasing a
known hang would produce no new information. Per the pre-existing-failure protocol, no new
`.pre-existing-error.md` was written and nothing was re-filed.

## Validation

- `yarn lint` (repo root): exit 0, no output.
- `yarn typecheck` (`packages/integration-tests`): exit 0.
- `yarn vitest run src/scenarios/control-cohort-harness-helpers.integration.ts`
  (`packages/integration-tests`): **18/18 passed**, ~13 s — was 12/12 before this pass.

## Still open, outside this repo

The `CadreNode` branch is now covered structurally but still has no *live multi-node*
run. If `../optimystic` is rebuilt with the upstream coordinator-cache fix, re-running
`control-write-degraded-cohort-member.integration.ts` would be the first end-to-end proof.
Not required by anything here — the resolver's behaviour is pinned by tests either way.
