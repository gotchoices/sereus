----
description: Docs and code comments now say plainly that Sereus's "4 copies" / "16 copies" replication numbers count machines, not independent people holding a copy — and that for strand data, the machines a party actually finds are all its own.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md, docs/strands.md
difficulty: easy
----

# What shipped

Prose and doc comments only across three files. No constant, function, schema, or test changed —
`git diff -U0 -- packages/` adds no executable line.

**`packages/quereus-plugin-sereus/src/cluster-size.ts`**
- `DEFAULT_STRAND_CLUSTER_SIZE`: new "Four machines, not four parties" paragraph. Cohort
  selection upstream is owner-blind (`findCluster`, upstream ticket
  `optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`); the path that
  discovers a strand's peers seeds only from this party's own control-database peer rows
  (`CadreNode.resolveCohortSeed`); a cross-party mesh is possible only by hand. Points at
  `docs/architecture.md` → "Replication cluster size" for the reasoning and
  `backlog/feat-strand-party-identity` for the fix.
- `CONTROL_REPLICATION_BREADTH`: one paragraph — a cadre is one party by construction, so
  owner-blind selection is not a question the control network's breadth answers.

**`docs/architecture.md`**
- "Replication cluster size" → new first bullet in "What matters operationally": both reasons
  the strand machine count is not a party count, the hand-built cross-party escape hatch, and
  the control network's exemption.
- "Strand Networks" → "Peer cohort" corrected from a flat "(union of all member cadres)" to
  intended-vs-discovered, pointing at the open cross-party-discovery question in `strands.md`.

**`docs/strands.md`**
- "Some Questions" → the within-party-answer paragraph records the consequence: until
  cross-party strand discovery lands, every discovered strand cohort is one party's machines,
  so strand replication breadth buys machine redundancy and no party redundancy.

# Review findings

## Claim verification (the substance of a prose ticket)

Each new claim was re-derived from source, not taken from the handoff.

- **`Libp2pKeyPeerNetwork.findCluster` is owner-blind — CONFIRMED.**
  `../optimystic/packages/db-p2p/src/libp2p-key-network.ts:680`. Cohort comes from
  `fret.assembleCohort(hashKey(key), wants)` — pure hash proximity — then the only filter is
  `membershipOf(id, protocols)`, i.e. "does this peer serve this network's protocol". No owner,
  party, or identity concept anywhere in the selection.
- **`CadreNode.resolveCohortSeed` seeds from this party only — CONFIRMED.**
  `packages/cadre-core/src/cadre-node.ts:3547`. `bootstrapNodes` come from
  `controlDatabase.queryCadrePeers()` → connected siblings → `collectStrandAddrs` over
  `/sereus/strand-addr/1.0.0`, plus this node's own circuit relays. Its two callers (`:3012`
  resume, `:3510` start) are the only sources of a strand's `bootstrapNodes` inside cadre-core.

- **FIXED (minor, accuracy): "always this party's machines" was an overclaim.**
  Both the implement-stage code comment and the architecture bullet said the strand cohort is
  *always* one party's machines. It is not: `StrandConnectionOptions.bootstrapNodes`
  (`packages/quereus-plugin-sereus/src/types.ts:9`) and the `bootstrap_nodes` connection-string
  key (`parse-config.ts:14`) flow to `createNode({ bootstrapNodes })` in `compose-strand.ts:223`,
  so an embedder calling `connectToStrand` itself can seed a strand with another party's
  addresses — an escape hatch that lives in the very package the comment sits in. The
  integration test reaches the same shape by a hand dial
  (`strand-membership-closed-strand-e2e.integration.ts:431`), which the ticket had described.
  Reworded in all three files: the claim now scopes to the *discovered* cohort and states
  plainly that a cross-party mesh is not forbidden, only undiscoverable. This is the one thing
  a prose ticket can get wrong, and it was wrong in the direction of a stronger promise.
- **FIXED (minor, DRY):** the corrected code comment initially repeated the doc's full
  escape-hatch explanation. Trimmed to one sentence with a pointer, restoring the ticket's
  "canonical in the doc, pointer in the code" split. Code paragraph is now 12 lines against the
  doc bullet's fuller version; no paragraph is duplicated verbatim.

## Checked and clean (no change needed)

- **Cross-references the ticket flagged.** `docs/cadre-consistency.md:20,24,28,30` and
  `docs/STATUS.md:957` re-read directly. All are control-network statements (where "the whole
  party" is the correct and intended cohort) or bare pointers into the architecture section —
  none restates "copies" as a party count. The implementer's assessment holds.
- **Link anchors resolve.** `strands.md#some-questions` (`docs/strands.md:78`),
  `architecture.md#strand-networks` (`:81`), `architecture.md#replication-cluster-size` (`:58`),
  `architecture.md#strand-address-resolution` (`:514`) all exist as headings.
- **Referenced tickets exist.** `backlog/feat-strand-party-identity`,
  `backlog/debt-replication-proof-above-cohort-size`,
  `../optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`. Neither adjacent
  ticket was edited, per the ticket's instruction.
- **Measured claims untouched.** The read-repair failure counts, latency figures, and
  `corroboratorCapacity` arithmetic in the surrounding bullets are byte-identical to before.
- **`CONTROL_REPLICATION_BREADTH` paragraph.** Claim is that a cadre is one party by
  construction; consistent with `CadrePeer` rows all being one `partyId` and with
  `cadre-consistency.md`'s existing framing. Correct as written.

## Not applicable, stated explicitly

- **No new tests.** Nothing asserts prose, and the diff has no executable line — a test here
  would assert comment text, which is worse than nothing. Not a gap.
- **No behavioural findings.** There is no behaviour in the diff to find them in. The
  design-level concerns this prose *describes* (owner-blind placement, no cross-party discovery)
  are already owned by `backlog/feat-strand-party-identity` and the upstream Optimystic ticket.
- **No tripwires recorded.** The one candidate — an embedder hand-seeding a cross-party mesh
  through `StrandConnectionOptions.bootstrapNodes` — is a documented knob, not a dormant defect,
  and is now stated in both the code comment and the architecture doc. Nothing conditional was
  left unparked.
- **Source hygiene.** `cluster-size.ts` is 200 lines, of which the file is deliberately
  comment-dominated (it is the project's design record for these two constants, by explicit
  design in the file header). No function, no size, no naming change to review.

## Validation

- `yarn lint` (repo root) — exit 0, no output.
- `yarn build` in `packages/quereus-plugin-sereus` — exit 0.
- `yarn test` in `packages/quereus-plugin-sereus` — **4 failed / 73 passed / 1 todo**. All four
  failures are in `test/e2e/networked.e2e.spec.ts` (real multi-peer libp2p strands): three die
  with `Missing block` inside `OptimysticVirtualTable.doInitialize` while applying the `Strand`
  membership schema, the fourth times out waiting for a late joiner to catch up. Pre-existing —
  this ticket's diff adds no executable line, so no comment in it can reach a p2p block fetch.
  Not in `tickets/.pre-existing-known.md`, so recorded in `tickets/.pre-existing-error.md` for
  the triage pass. Nothing skipped, disabled, or loosened.
