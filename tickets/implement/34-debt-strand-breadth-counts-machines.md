----
description: The written explanation of how many copies of your data we keep counts machines, and a reader naturally takes it to mean "how many separate people hold a copy". Those are not the same number, and today they are never the same number — write that down where the promise is made.
files: packages/quereus-plugin-sereus/src/cluster-size.ts, docs/architecture.md, docs/strands.md
difficulty: easy
----

# Say plainly that replication breadth counts machines

## The claim that is currently missing

`DEFAULT_STRAND_CLUSTER_SIZE = 4` and `CONTROL_REPLICATION_BREADTH = 16` are both counts of
**machines**. The prose around them — in `cluster-size.ts` and in `docs/architecture.md` →
"Replication cluster size" — is careful and accurate about consensus arithmetic, read repair,
and write availability. It says nothing about *whose* machines, and a reader who arrives asking
"how many independent people hold a copy of this row?" will read "four copies … holders that may
be offline: 1" and conclude four people. That conclusion is wrong.

Two separate reasons it is wrong, and the second is the one nobody would guess:

1. **Cohort selection is owner-blind.** Optimystic picks a block's cohort by hash proximity,
   filtered only for "does this peer serve this network's protocol"
   (`../optimystic/packages/db-p2p/src/libp2p-key-network.ts` → `findCluster`). It has no
   concept of who owns a peer, so N copies land on somewhere between 1 and N owners depending
   on the block's hash. Filed upstream as
   `optimystic/tickets/backlog/feat-cohort-selection-owner-aware-placement`.
2. **In production, a strand mesh contains exactly one party's machines**, so the answer is
   always 1. Nothing seeds a strand's libp2p node with another party's addresses:
   `CadreNode.resolveCohortSeed` (`packages/cadre-core/src/cadre-node.ts:3547`) builds
   `bootstrapNodes` solely from `CadrePeer` rows — this party's own control database — and
   resolves their strand addresses over `/sereus/strand-addr/1.0.0`, which is single-party by
   design (see `strand-addr-protocol.ts` header and `docs/strands.md` → "Some Questions", where
   cross-party strand discovery is still listed as open). `StrandConfig` has no
   caller-supplied bootstrap override. The two-party strand mesh in
   `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
   is built by a **manual dial** in the test, not by any production path.

So a shared workspace's data is, today, replicated four ways onto the machines of the one party
whose node wrote it. One house fire, one failure domain, one witness, one reachable source — the
configured number is met exactly and measures none of that.

Note the contrast with the control network, where the same wording is already correct and needs
only one clarifying sentence: a cadre **is** one party, so "replicate to the whole party" is the
whole intent and party diversity is not a question there.

## Why this is worth a change even though it is only words

`cluster-size.ts` and `docs/architecture.md` are where this project keeps its design record —
the doc comments on these two constants run to 150 lines and are cited from
`docs/cadre-consistency.md` and `docs/STATUS.md`. A future reader sizing a deployment,
reasoning about durability, or designing a witnessing rule will consult exactly this prose. It
is the only place the correction can be made to stick, and the gap it describes is not going to
close soon (it needs cross-party strand discovery, per-party strand membership, and an upstream
Optimystic change — all captured in `backlog/feat-strand-party-identity`).

One more line in the same docs is actively misleading and should be corrected in the same pass:
`docs/architecture.md` → "Strand Networks" lists a strand's "Peer cohort (**union of all member
cadres**)". That is the intent, not the implementation — today it is this party's cadre only.

## Scope

Prose and comments only. No behaviour change, no new constant, no test asserts any of this
(nothing asserts prose). The `MIN_CLUSTER_SIZE` / `resolveStrandClusterSize` / policy semantics
are untouched, and every measured claim already in these docs stays exactly as measured.

## Edge cases & interactions

- **Do not weaken the existing measured claims.** The read-repair failure counts ("4 failures in
  10 runs at breadth 2, 0 in 20 at breadth 3…"), the degraded-member latency figures, and the
  `ceil(cohort × 0.75)` table are all measured and cited from three files. Add alongside them;
  do not rewrite or re-derive them.
- **Keep the canonical/summary split.** `cluster-size.ts` explicitly says the full explanation
  lives in `docs/architecture.md` → "Replication cluster size" ("Keep it there, not here"). The
  new material follows the same rule: the reasoning goes in the doc, a short pointer-bearing
  sentence goes in the code comment. Do not duplicate paragraphs across the two.
- **Control vs strand must not be blurred.** `CONTROL_REPLICATION_BREADTH`'s existing "exceeds
  any party's node count … every control block lands on every member of the party" is correct
  and stays. The added sentence there says only that a cadre is one party by construction, so
  owner-blind selection is a non-issue on the control network — not that it has the same gap.
- **`docs/cadre-consistency.md` quotes this section three times** (lines 24, 28, 30) and
  `docs/STATUS.md` once (line 957). None of those quotes become wrong under this change, but
  check them rather than assuming — if any of them restates "copies" in a way that now reads as
  a party count, fix it in the same pass.
- **Adjacent, deliberately not merged:** `backlog/debt-replication-proof-above-cohort-size` also
  cites `cluster-size.ts`, but it is about *proving the copy count* on a strand of more than four
  machines — a different root cause (missing test coverage), not this one (missing statement).
  Do not fold them; do not edit that ticket.
- **`schemas/strand.qsql` ↔ `strand-schema.ts` byte-equivalence does not apply here** — neither
  file is touched.

## TODO

- In `packages/quereus-plugin-sereus/src/cluster-size.ts`, extend the `DEFAULT_STRAND_CLUSTER_SIZE`
  doc comment with a short paragraph: the number counts machines; cohort selection is owner-blind
  upstream; and in production a strand mesh is this party's machines only, so four copies are four
  machines of one party. Point at `docs/architecture.md` → "Replication cluster size" for the
  reasoning and at `backlog/feat-strand-party-identity` for the fix.
- In the same file, add one sentence to the `CONTROL_REPLICATION_BREADTH` comment: a cadre is one
  party by construction, so party diversity is not a question the control network's breadth is
  trying to answer.
- In `docs/architecture.md` → "Replication cluster size", add a bullet in the "What matters
  operationally" list stating both reasons the machine count is not a party count (owner-blind
  selection; single-party strand meshes in production), naming `findCluster`,
  `CadreNode.resolveCohortSeed`, and the upstream + Sereus tickets. Keep it to a bullet — it is a
  statement of what the number means, not a design proposal.
- In `docs/architecture.md` → "Strand Networks", correct "Peer cohort (union of all member
  cadres)" to say that this is the intended shape and that today the cohort is this party's cadre
  only, with a pointer to the open cross-party-discovery question in `docs/strands.md`.
- In `docs/strands.md` → "Some Questions", add one sentence to the existing cross-party-discovery
  open question recording its consequence for replication: until it lands, every strand cohort is
  one party's machines, so replication breadth buys machine redundancy and no party redundancy.
- Verify the four cross-references listed under *Edge cases* (`cadre-consistency.md` ×3,
  `STATUS.md` ×1) still read correctly; fix any that now imply a party count.
- Run `yarn lint` and `yarn build` (comment-only source edit — confirm nothing was broken, not
  that anything new passes).
