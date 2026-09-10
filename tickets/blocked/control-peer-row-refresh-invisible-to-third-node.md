----
description: When a third machine joins a group, one of the machines already there keeps reading an old copy of the shared member directory and never learns the newcomer's address. It does not know it is behind, so nothing anywhere tries to catch it up. The code that decides what version a read sees lives in a separate repository.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/db-core/src/transactor/transactor-source.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/cadre-core/src/cadre-node.ts
difficulty: hard
repro: verified
----

> **Re-measured 2026-09-05 against `@optimystic/db-p2p` 0.28.0 — the mechanism this ticket
> described is GONE, and a different one is doing the damage. Everything below the "What a user
> sees" heading is kept for history but is no longer the explanation.**
>
> The body says the repair cannot converge because a 3-peer cohort needs 2 corroborators and only
> 1 peer answers — "arithmetic, not a race", evidenced by 1821 `cluster-fetch:no-quorum` and 954
> `read-repair-triggered` on `default/CadrePeer`. Instrumented run today, correct namespaces
> (`optimystic:db-p2p:*` — the channels are peer-id suffixed now, so the old exact-match `DEBUG`
> string in the Reproduce section silently matches nothing; that cost one wasted run here):
>
> | | 2026-08-12 | 2026-09-05 |
> | --- | --- | --- |
> | `no-quorum` on `default/CadrePeer` | 1821 | **0** |
> | `no-quorum` on other blocks | — | 466, every one `holders=0` on `default/Revocation` / `default/Strand` |
> | `read-repair-triggered` / `applied` | 954 / 2 | 25 / **0** |
> | shape of the declines | `responders: 1, required: 2` | `cohortPeers=2 holders=0 required=2` |
>
> **There is no corroboration deadlock on the member directory any more.** The repair path is not
> declining for `CadrePeer` — it is never invoked for it. The certified-claims chain upstream
> (`4`, `4.1`, `4.2`, plus `2-single-signer-proof-outweighs-corroboration`) landed in 0.28.0 and
> single-signer certified claims are visibly being accepted in the same run
> (`certified-claims accept-unanchored block=default/CadrePeer rev=1 … signers=1`).
>
> **What is actually happening** is finding 4 below, on its own: B's collection view never advances
> past the owner-vouch revision of C's row, and B has no way to notice. Measured in one boot:
>
> - B read C's row 156 times over the 45 s gate, every time identical:
>   `updatedAt=1788660197517, addrs=[], sig=(empty)` — the owner-vouch revision, which carries a
>   peer id and no addresses, so `resolvePeerAddrs` correctly refuses it.
> - C committed two self-signed refreshes *with* an address in that window
>   (`updatedAt=…198257` and `…198548`, `1 addrs`, valid sig). Neither is ever seen by B.
> - No `no-quorum`, no repair, no error, on that block. B is not declining to answer — it is
>   answering confidently from a lineage that stops before C's refresh.
>
> The remaining `no-quorum` volume is a **separate** and probably benign shape: `holders=0` on
> `default/Revocation` and `default/Strand`, tables this scenario never writes. Worth its own look
> before anyone treats 466 declines as evidence of this bug.
>
> **Unblock condition, restated:** an upstream change that makes a reader whose view has stopped
> advancing either notice (and re-read at the current revision) or refuse. Filed as
> `../optimystic/tickets/fix/1-a-reader-cannot-tell-its-view-stopped-advancing.md`, carrying this
> measurement. The old upstream slug named below
> (`1-stale-read-returned-as-authoritative-when-repair-cannot-converge`) is no longer the right
> description of the failure.
>
> **The harness predicted this.** `control-trio.ts:244` already says of this exact gate: "a genuine
> A→B replication failure is a product bug and deserves its own ticket rather than a wider timeout
> here."

> **Correction 2026-08-24 — one of the two arms this repo has been reporting was already fixed
> upstream, and had been since 2026-08-12.**
>
> The upstream ticket filed tonight led with the claim that `CoordinatorRepo.get` acts on an
> `inconclusive` outcome only when the block is **missing**, so a present-but-stale block is
> returned to the caller as authoritative. That is quoted from this ticket's own 2026-08-12
> analysis, and it is **no longer true** — `../optimystic`'s `coordinator-serves-stale-data-as-if-confirmed`
> fixed it and was reviewed 2026-08-12; the fix stage re-verified that tonight. The claim was
> carried forward here for twelve days without being re-read against the code it describes.
>
> **The other arm is real, and is now measured rather than argued.** The repair genuinely cannot
> converge in this shape, and the arithmetic that decides it was swept directly
> (`resolveClusterPolicy` / `corroboratorCapacity` / `quorumSize`):
>
> | nodes | peers who answered | capacity | corroborators needed | converges? |
> | --- | --- | --- | --- | --- |
> | 2 | 1 | 1 | 1 | yes |
> | **3** | **1** | **2** | **2** | **NO** |
> | 3 | 2 | 2 | 2 | yes |
> | **4** | **1** | **3** | **2** | **NO** |
> | 4 | 2 | 3 | 2 | yes |
>
> Row 2 is exactly this ticket: three nodes, B can reach only A, so one peer answers, two
> corroborators are required, and no amount of retrying changes that. It is arithmetic, not a race.
> *(Superseded 2026-09-05: this shape no longer appears for `CadrePeer`.)*
>
> **And nothing says so.** 1821 `cluster-fetch:no-quorum` and 954 `read-repair-triggered` in one
> boot, 2 repairs applied, no error raised — a fact the node knew at the moment of every single
> decline, which then cost twelve days to re-derive from logs. Now
> `../optimystic/tickets/implement/1-repair-deadlock-is-never-named.md`, which also reports that the
> cohort-size advice printed at startup is wrong about how many machines are needed.
> *(That ticket has since landed; it is in `../optimystic/tickets/complete/`.)*
>
> Note what this does **not** claim: naming the deadlock does not make this scenario converge. It
> converts a silent permanent stall into a loud one. The convergence question stays open on the
> parent fix ticket.

> **Upstream owner filed 2026-08-24 — and the one this ticket named never existed.**
> The body says an upstream ticket
> `../optimystic/tickets/fix/collection-view-forks-silently-when-repair-cannot-reach-quorum.md`
> was "created by this pass". **It is not in that repository** — not on the board, not in
> `complete/`, and no run log, which that repo writes for every ticket it processes. It was never
> created, or was removed without one. So the analysis below sat unowned for twelve days while
> three integration suites failed on it.
>
> Now filed, carrying the measured record verbatim:
> `../optimystic/tickets/fix/1-stale-read-returned-as-authoritative-when-repair-cannot-converge.md`.
> It leads with the half of this that is self-contained and fixable on its own — `CoordinatorRepo.get`
> acts on an `inconclusive` outcome only when the block is **missing**, so a present-but-stale block
> is returned to the caller as authoritative with nothing raised — ahead of the harder convergence
> question.
>
> Two sibling tickets were filed there at the same time and may be the same defect:
> `1-two-node-index-divergence-guard-never-fires` (the shape behind
> `secondary-index-seek-blind-to-sibling-rows`) and, less likely,
> `1-inbound-relayed-connection-addr-is-never-published`. Each cross-references the others.

> **Audit 2026-08-21 — still real, but narrower than the body claims.** Measured across the
> full-suite runs of 2026-08-20 and 2026-08-21, of the four scenarios this ticket names:
>
> | scenario | status |
> | --- | --- |
> | `control-cohort-edge-carries-data` | still fails, both runs |
> | `control-cohort-three-node-isolation` | intermittent — failed one run, passed the other |
> | `control-write-degraded-cohort-member` | **7/7 passing, both runs** |
> | `control-write-while-alone-convergence` | **2/2 passing, both runs** |
>
> The last two no longer demonstrate anything. That does not clear the ticket — the fork it
> describes is still visible through `control-cohort-edge-carries-data` — but anyone re-measuring
> should not expect those two to reproduce it, and the blast radius stated in the body is wider
> than what is currently observable.

# Blocked (b): node B's control collection silently forks and never merges back

**Category (b) — dependency outside this repo.** Everything that must change is in the
sibling checkout `../optimystic` (`@optimystic/db-core` and `@optimystic/db-p2p`), which
Sereus consumes from its built `dist`. Nothing in this repository can make the failing
scenarios pass.

**Upstream ticket:** `../optimystic/tickets/fix/1-a-reader-cannot-tell-its-view-stopped-advancing.md`
(filed 2026-09-05, carrying the re-measured record above). Supersedes the 2026-08-24 filing.

**Unblock condition:** an optimystic fix that makes a node whose collection view has
stopped advancing either (a) notice and re-read at the current revision, or (b) refuse to
answer from the stalled view, landed and rebuilt
(`cd ../optimystic && yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-p2p build`).
Then re-run the scenarios below at least five times each and remove this ticket's entries
from `tickets/.pre-existing-known.md`.

**Current rates, 2026-09-05, five runs each:**

| scenario | result |
| --- | --- |
| `control-cohort-edge-carries-data` | **5 red / 5** — deterministic, always the boot gate |
| `control-cohort-three-node-isolation` | **4 red / 5** (and green on a sixth, instrumented run) |
| `control-write-degraded-cohort-member` | 5 red / 5, but **4 of them on a different fingerprint** — see `fix/control-write-retry-does-not-absorb-a-transient-stream-reset` |

This is very probably the **same upstream defect** as
`tickets/blocked/forked-control-collection-sync-livelocks.md` — same collection, same file
(`db-core/src/collection/collection.ts`) — seen from its silent side. That ticket's fork
announces itself as `SyncRetryExhaustedError`; this one never raises anything at all. Both
tickets should clear on one upstream fix; keep them separate only until that fix lands,
because their fingerprints and their failing suites are different.

## What a user sees

Three machines, A (the owner) plus B and C. C joins last. C publishes its network address
into the shared `CadrePeer` directory. A sees it. C sees it. **B never does** — not in the
45 s the test waits, and not afterwards. B cannot dial C, so the two never connect. No
exception is thrown, nothing is logged as an error, and B keeps serving reads and
committing writes to the directory perfectly happily. It is simply reading a different
history of the same table from everyone else.

## Blast radius

Three integration suites fail their boot gate on this (all already listed in
`tickets/.pre-existing-known.md` against this slug):

- `control-cohort-three-node-isolation.integration.ts`
- `control-write-degraded-cohort-member.integration.ts` (boot gate)
- `control-cohort-edge-carries-data.integration.ts` (boot gate)

Measured hit rate on 2026-08-12: **5 failures in 66 consecutive boots** of `bootControlTrio`.
Re-measured 2026-09-05 (table above): far higher — `control-cohort-edge-carries-data` is now
deterministic. It is no longer only a boot race.

In production the same shape is a member that can never dial a newly joined machine, with
no error to act on and no self-healing path.

## What was measured, 2026-08-12

Six runs of a throwaway probe scenario (since deleted) that boots `bootControlTrio` in a
loop until step 6 fails, then interrogates the trio. It patched
`Libp2pKeyPeerNetwork.prototype.findCoordinator` / `findCluster` through the existing
`packages/integration-tests/src/harness/key-network-patch.ts` so every routing decision
could be attributed to the node that made it — the peer-id attribution the predecessor
ticket asked for. Sibling repos clean and freshly built; `DEBUG='optimystic:db-p2p:coordinator-repo'`.

**1. B's view is stuck, permanently, and A's and C's are not.** Sampled every 2 s after the
failure, byte-identical in all five failing runs:

```
A[updatedAt=1786519567099 addrs=1 sig=piX_ESleUqHy]
B[updatedAt=1786519566062 addrs=0 sig=(empty)]     ← the owner-vouch revision
C[updatedAt=1786519567099 addrs=1 sig=piX_ESleUqHy]
```

*(Re-confirmed 2026-09-05, same shape, 156 identical reads in one 45 s gate.)*

**2. B routes that block to itself; A and C route it elsewhere.** Over one failing boot,
B called `findCoordinator` 2548 times and picked itself 1657 times; for the `CadrePeer`
data block specifically it picked itself **930 of 930 times**, while A picked B and C
picked A for the same block.

**3. Routing is NOT the cause.** Forcing every coordinator to A (`pinCoordinator([A])`,
confirmed live: 16 pinned `findCoordinator` calls served during the probe) and re-reading
on B still returns **0 addresses**. B asks A, and A answers — with the old revision,
honestly, because the read is context-pinned: `TransactorSource.tryGet` passes
`context: this.actionContext` on every read, so a collection sitting at an old revision
asks every peer for that old revision's view and gets it.

**4. B is not merely behind — it has FORKED.** After the failure, `B.registerSelf()` returns
`refreshed`, i.e. B successfully commits a brand-new revision to that very same
`CadrePeer` table — and B's read of C's row is *still* the pre-refresh revision.
`B.reconcileControlCohort()` afterwards changes nothing either. B is committing on a
lineage that does not contain C's refresh, and the commit is accepted. (Control writes run
with cohort downsizing allowed, so a node can commit alone; see
`packages/quereus-plugin-sereus/src/cluster-size.ts`.)

**This is the surviving finding.** Findings 3 and 5 describe machinery that either changed
or no longer runs; finding 4, plus the context-pinning sentence in finding 3, is the whole
mechanism as of 0.28.0.

**5. The safety net that should catch this is measurably dead.** *(Superseded 2026-09-05 —
the repair is not declining for this block; it never runs. Kept for the historical shape.)*
B's lazy read-repair fires constantly on `default/CadrePeer` and on the collection's data
block, and **every single pass fails the same way**:

```
cluster-fetch:no-quorum { blockId: 'default/CadrePeer', responders: 1, required: 2 }
```

1821 `cluster-fetch:no-quorum`, 954 `cluster-tx:read-repair-triggered`, 952
`cluster-tx:read-repair-noop`, 2 `read-repair-applied` in one run. The cohort B sees for
that block is all three peers `[A, B, C]`, so `corroboratorCapacity` is 2 and the
corroboration floor stays at 2 (`db-p2p/src/cluster/quorum-restore.ts`). B can reach only
A. **The second corroborator B needs is C — and C is unreachable precisely because the
record being repaired is C's address.** The dependency is circular, so the repair can never
converge.

## What this rules out

The predecessor ticket's leading hypothesis — "B answers its own read from its own replica"
— is **half right and not the root cause**: B does self-coordinate the block (finding 2),
but finding 3 shows that taking that away fixes nothing. The coordinator cache
(`coordinator-cache-poisoned-by-boot-time-self-selection`, fixed upstream), network
scoping, and the 16-wide cohort were already ruled out by that ticket and were not
revisited.

Ruled out 2026-09-05: the sereus-side peer-join backfill is **not** the seam. It runs and
succeeds in every failing boot (`catch-up peer=… offered=17 accepted=17 rejected=0`), so B
physically receives blocks; the problem is which revision B's *view* reads, not which bytes
B holds.

## Reproduce

From `packages/integration-tests`, at least five times — `control-cohort-edge-carries-data`
is deterministic, the other two are not:

```
npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

For diagnosis — note the trailing star, the db-p2p channels are peer-id suffixed and an
exact-match filter matches nothing:

```
DEBUG='optimystic:db-p2p:*,optimystic:db-core:collection*,sereus:cadre:node' \
  npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

Permanent instrumentation already in place and worth keeping:
`packages/cadre-core/src/cadre-node.ts` logs `updatedAt`, `addrs` and a signature prefix on
the `resolvePeerAddrs` verification failure, and a signature prefix on both `registerSelf`
success paths. That pair is what made today's measurement a ten-minute job.

## Note on scope

There is a Sereus-side lever here — control writes are allowed to commit on a downsized
(possibly one-member) cohort, which is what lets B's branch exist at all. It is deliberate
and load-bearing: a one-node party must be able to write, and
`control-write-while-alone-convergence.integration.ts` exists to hold that behaviour. Taking
it away is a product decision, not a bug fix, and it would not repair a fork that has
already happened. Left alone here on purpose.

> **Upstream ticket is in flight as of 2026-09-05.** Noted from the `../optimystic` side; nothing
> here was re-measured.
>
> The 2026-09-05 re-measurement at the top of this file was filed upstream as
> `optimystic/tickets/fix/1-a-reader-cannot-tell-its-view-stopped-advancing`, now being worked
> through that repo's pipeline. It carries this ticket's finding 4 as its whole subject: a
> collection sitting at revision *n* asks its peers for *revision n's view* and is correctly given
> it, and nothing in that loop ever asks whether *n* is still the latest — so a view that stops
> advancing has no way to notice, and read-repair is never invoked at all.
>
> **One correction to the measurement above, traced upstream in code rather than inferred.** The
> table records "466 `no-quorum` on other blocks, every one `holders=0`" and leaves them as a
> separate, possibly-benign question. They are benign, and the reason is a misleading log name
> rather than a decline: with `holders=0` there is nothing for `selectQuorumRev` to select, so the
> `cluster-fetch:no-quorum` line fires on a cohort that unanimously answered *"I hold nothing"* — an
> answer. The same code returns early from its repair-deadlock reporting for exactly that shape
> ("the cohort agrees the block is absent, which is an answer, not a deadlock"), and the read is
> then served as an authoritative, unflagged absent.
>
> **That only holds when `silent` is 0, and this capture did not record `silent`.** With those peers
> silent rather than answering, the identical `cohortPeers`/`holders` numbers give `answered = 0`,
> verdict `isolated`, and `unavailable: 'cohort-unreachable'` — a genuinely failed read, and the
> fingerprint that kills `control-read-over-fresh-edge-stream-resets` at boot. Same numbers,
> opposite outcome. **Record `silent` on the next capture before calling any of these lines benign.**

## Measured 2026-09-10 — the same wait now fails under suite load, and it is contention, not a regression

Full-suite run (`tickets/.logs/rel2-check.log`, sereus at the post-release-night HEAD, optimystic
`1.0.0-beta.1`): three integration files red, and **two of them fail inside the same helper** —
`bootControlTrio` (`packages/integration-tests/src/harness/control-trio.ts:249`), with

```
Error: Timeout waiting for B resolves C's signed CadrePeer address record after 45000ms
```

- `control-write-degraded-cohort-member.integration.ts` — dies in setup, so all 7 of its tests are
  reported *skipped* rather than failed. They did not run; do not read that 7 as green.
- `control-cohort-three-node-isolation.integration.ts` — one test failed. **This file passed on the
  immediately preceding full run of the same optimystic build**, which made it look like a
  regression from that night's work.

It is not. Discriminated by running the two files together and then alone:

| run | result | test time |
| --- | --- | --- |
| full suite | isolation file fails at `:65` | — |
| the two files together | degraded-cohort passes 8/9; isolation file fails at `:110` — a *different* test | 333s |
| isolation file alone, run 1 | **2/2 pass** | 25s |
| isolation file alone, run 2 | **2/2 pass** | 20s |

Two signals say contention rather than defect: the failing test *moves* between runs while the
throw site stays fixed at the shared boot helper, and the same work takes 20-25s alone versus 333s
beside `control-write-degraded-cohort-member`, which forces a 3-peer cohort and injects stalls.

Also checked and cleared as a cause: that night's revocation work edited
`packages/cadre-core/src/membership-connection-gater.ts`, which would be the obvious suspect for
"B cannot reach C". The diff is comment-only plus one `export` — the revoked-peer denial composes
onto CLOSED STRAND nodes only and never touches control-network gating.

**Do not respond by raising the 45s timeout.** The wait is the measurement; a longer one would hide
exactly the propagation delay this ticket exists to characterize. The harness-level problem — that
a fixed wall-clock wait makes two files fail when scheduled next to a stall-injecting neighbour — is
tracked separately as `debt-control-trio-boot-wait-is-contention-sensitive`.


> **Re-measured 2026-09-10, after the per-party strand identity chain (`strand-party-member-key` → `strand-formation-membership-invite` → `strand-node-binds-member-peer` → `strand-party-removal-via-formation-e2e`) and on `@optimystic/*` 1.0.0-beta.2.** Still the boot gate, still deterministic: `control-cohort-edge-carries-data` failed **4 of 4** — once inside a full `yarn check` integration run (287 passed / 1 failed of 288, this file the only red) and 3 of 3 run alone, so it is not suite contention. The two recorded fingerprints alternate between runs on the same commit: `Block default/Revocation is unavailable (cohort-unreachable)` (runs 1-3) and `Timeout waiting for B resolves C's signed CadrePeer address record after 45000ms` (run 4) — the first belongs to `control-read-over-fresh-edge-stream-resets`, the second to this ticket. Nothing in the identity chain touches control-cohort replication. Logs: `tickets/.logs/tend-final-check-20260910.log`, `tend-final-cohort-edge-solo.log`, `tend-final-cohort-edge-rep{1,2}.log`.
