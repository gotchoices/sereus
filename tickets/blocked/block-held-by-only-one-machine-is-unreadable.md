----
description: When a machine writes something to the shared database before any other machine has joined, the other machines can be unable to read it back — not "not yet", but an outright error — because the database library refuses to accept a record that only one machine has a copy of. It usually rights itself by luck, which is why this shows up as a test that fails about four times in ten. The rule that causes it lives in a separate library this project depends on but does not edit.
prereq:
files: ../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts (corroboratorCapacity, quorumSize, CORROBORATION_FLOOR), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (queryClusterForLatest ~line 848-935, fetchBlockFromCluster ~line 621-712, the AbsenceVerdict mapping in get ~line 417-450), ../optimystic/packages/db-core/src/transactor/network-transactor.ts (get, the single second-chance retry round ~line 128-220), packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenario 4), packages/quereus-plugin-sereus/src/cluster-size.ts (CONTROL_CLUSTER_POLICY — the knob that does NOT reach this), tickets/blocked/control-peer-row-refresh-invisible-to-third-node.md (same upstream site, different symptom)
difficulty: hard
repro: verified
----

> **Gate re-run 2026-08-24 after the upstream fix — 4 of 5 green. Improved, NOT fixed. Stays blocked.**
>
> | measurement | result |
> | --- | --- |
> | isolated ×7, 2026-08-22 (pre-fix) | **0 passed, 7 failed** |
> | isolated ×5, 2026-08-24 (post-fix) | **4 passed, 1 failed** |
> | full suite, same session | failed |
>
> The one failure carries the same `Block default/OwnerKey is unavailable (claimed-elsewhere)`
> verdict as every previous one, so this is the same defect at a lower rate, not a new one.
>
> **What this settles.** `../optimystic`'s `1-third-party-address-set-has-two-definitions` — the
> three redirect resolvers publishing connections alone where `findCluster` published connections ∪
> peerStore — was filed there with an explicitly **unproven** link to this scenario. The link is now
> demonstrated: 0/7 → 4/5 is far outside noise. That ticket asked to be told either way; it should
> be told this.
>
> **What it does not settle.** Something else still produces the same verdict about one run in five.
> This ticket's unblock condition is five clean runs and it has four. Do not close it, and do not
> record the upstream fix as the cause — record it as *a* cause.
>
> **The rate change makes this harder to work, not easier.** Every prior investigation had a
> deterministic reproducer. The next one will need to run the scenario repeatedly to catch a
> failure, and a green run now proves nothing.

> **Correction 2026-08-24, same day — the candidate named just above was REFUTED upstream.**
> The `direction !== 'outbound'` theory rested on an inbound relayed `remoteAddr` being a dialable
> circuit address. It is not, and the upstream fix stage settled it from the vendored
> `@libp2p/circuit-relay-v2@4.x` source rather than by argument:
>
> - The listener composes that address as **our** connection-to-the-relay encapsulated with
>   `/p2p-circuit/p2p/<dialer>` (`transport/index.js:272`). The relay it names is the one **we** hold
>   a reservation with — not one the dialer is reachable on.
> - A dialer needs no reservation to open a circuit; the relay requires one for the **destination**
>   only (`server/index.js:219-223`). So a third party dialing that address reaches the dialer only
>   if the dialer coincidentally shares our relay.
> - And in that coincidental case the dialer's genuine circuit address has already arrived by
>   `identify`, so publishing the composed one adds nothing.
>
> The decline is being pinned as a `NOTE:` at the predicate so it stops being re-derived.
>
> **A real defect was found next door, with the same symptom shape.** `findCluster` answers "which
> addresses may we publish for this peer" as connections **∪ peerStore**; the three redirect
> resolvers (`repo/service.ts:162`, `cluster/service.ts:123`, `libp2p-node-base.ts:577`) answer it
> with connections alone. The peerStore arm is the only place a relay-only peer's real circuit
> address ever comes from, so a cohort member that only ever dialed **us** is described by
> `findCluster` with an address and by a repo redirect with none — and `RepoService.checkRedirect`
> has no cluster record to fall back on. Now
> `../optimystic/tickets/implement/1-third-party-address-set-has-two-definitions.md`.
>
> **The link to this ticket is still unproven.** That upstream ticket says so itself — "nobody has
> measured this in production; it is filed on the strength of reading the two code paths side by
> side". It is a plausible mechanism for `claimed-elsewhere` against a relay-only holder, not a
> demonstrated one. Re-run this ticket's five-run gate once it lands, and do not record it as the
> cause until the scenario actually goes green.


> **REFUTED 2026-08-24 (same day, later) — `a8f64d0` is not the cause. The candidate below is
> withdrawn; the green→red flip is still unexplained.**
>
> The upstream fix ticket asked for was worked and its premise killed on three independent grounds.
> Reported back here as promised.
>
> 1. **The rule is unreachable in this scenario.** Scenario 4 builds no relay and no NAT'd node.
>    `controlNodeConfig` (`packages/integration-tests/src/harness/node-fixtures.ts:97-125`) gives
>    A, S and Rx `listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws']` and no `relayAddrs`; the scenario's own
>    header calls it "full mesh, A the only writer", and line 640 seeds Rx's record from
>    `controlAddrs(Rx)` — a real direct listen address. **No `/p2p-circuit` connection exists in
>    scenario 4**, so how `publishableConnectionAddr` treats inbound relayed connections cannot
>    affect it. The candidate above described **scenario 2** (the NAT/relay case), not scenario 4.
>
> 2. **The chronology rules it out.** This ticket's own *Measurement conditions* record the
>    `responders: 1, required: 2` capture with `../optimystic` clean at `235539e` — which is
>    version **0.24.0**, dated 2026-08-19, and is an ancestor of `a8f64d0` (2026-08-21). The exact
>    failure signature was already reproducing 4-of-9 two days **before** the direction rule
>    existed. `a8f64d0` cannot have introduced it. (It could in principle have moved the *rate*
>    4/9 → 7/7, but by point 1 it has no lever in this scenario to do so with.)
>
> 3. **The mechanism was wrong anyway.** An inbound relayed `remoteAddr` is not a third-party
>    address. `@libp2p/circuit-relay-v2@4.x` composes it as
>    `ourConnectionToTheRelay.remoteAddr` + `/p2p-circuit/p2p/<dialer>`
>    (`dist/src/transport/index.js:272`), so the relay it names is **the one we hold a reservation
>    with**, not one the dialer is reachable on. The relay's `handleConnect` requires a reservation
>    for the **destination** only (`dist/src/server/index.js:219-223`, `NO_RESERVATION`) — a dialer
>    needs none — so a third party reaches the dialer at that address only if the dialer happens to
>    share our relay. Separately, `findCluster` already unions live-connection addresses with the
>    peerStore, so a relay-only peer's genuine self-advertised circuit address (learned by
>    `identify`) is published regardless of connection direction. The premise "a relay-only peer has
>    no publishable address at all" is false for `findCluster`.
>
> `../optimystic/tickets/fix/1-inbound-relayed-connection-addr-is-never-published.md` is closed
> without a behaviour change. `publishableConnectionAddr` keeps `direction !== 'outbound'`, and the
> decline is being recorded as a `NOTE:` at that predicate so it is not re-filed.
>
> **What the investigation did find, and what it does not explain.** The redirect address resolvers
> (`repo/service.ts`, `cluster/service.ts`, and the resolver `libp2p-node-base.ts` injects) read
> live connections only, while `findCluster` reads connections **plus** the peerStore — so a
> relay-only member can be published with an address by one path and with nothing by the other.
> That is a genuine upstream inconsistency and is now
> `../optimystic/tickets/implement/1-third-party-address-set-has-two-definitions.md`. It is **not**
> a candidate for this ticket: scenario 4 has no relay-only member, and `claimed-elsewhere` here was
> measured with every cohort peer answering (no `cluster-fetch:peers-silent`), which is not what an
> address gap looks like.
>
> **Suggested next step for the flip, since the upstream-address theory is dead.** The 0.24.0 →
> 0.24.2 range also contains `3216929` (dependency upgrades) and the `db-p2p-adopt-fret-framing`
> pair (`42b1d2e` / `235539e`) — but `235539e` is the SHA this ticket already measured red at, so
> the range that remains genuinely unexamined is `235539e..daeac29`, and within it only `3216929`
> plausibly touches timing this scenario depends on. A real bisect over those four commits, with
> `DEBUG='optimystic:db-p2p:coordinator-repo*'` captured at each end, would settle it — and would
> also confirm whether today's 7/7 still carries `responders: 1, required: 2` or has become a
> different failure wearing the same error string. Nobody has captured DEBUG at 0.24.2 yet; the
> 2026-08-22 gate matched on the error text alone.

> ~~**Upstream owner filed 2026-08-24, with a concrete candidate for the green→red flip.**~~
> **(Withdrawn — see the refutation directly above.)**
> The 2026-08-22 note above left "what changed between `@optimystic/*` 0.24.0 and 0.24.2" as the
> open question. Reading that range turned up one commit that fits: `a8f64d0`
> (`1-findcluster-publishes-inbound-source-addresses`) added
>
> ```ts
> if (conn.direction !== 'outbound') return undefined
> ```
>
> to `publishableConnectionAddr`. The reasoning is sound for an inbound **direct** connection — its
> `remoteAddr` is the far side's ephemeral source socket, useless to a third party. But it rejects
> inbound **relayed** connections too, whose `remoteAddr` is a real `/p2p-circuit/` address anyone
> can dial. The consequence is that a peer reachable *only* through a relay has no publishable
> address at all — and the receiver in this ticket's failing scenario is deliberately, genuinely
> NAT'd and relay-only.
>
> Filed as `../optimystic/tickets/fix/1-inbound-relayed-connection-addr-is-never-published.md`,
> marked `repro: suspected` on purpose: the correlation is strong and the mechanism fits, but nobody
> has yet watched a redirect payload lose a circuit address and then watched this read fail. That
> ticket's first job is to prove or kill the link, and it is asked to report back **either way** —
> a clean refutation is worth as much here, because this ticket's own stated unblock condition has
> already been met once (the corroboration floor) without the symptom moving.

> **Gate run 2026-08-22 — the named upstream rule is gone and the symptom is WORSE. Stays blocked,
> but the analysis below needs re-pointing before anyone works it.**
>
> **Measured: 7 of 7 red today.** Two full integration runs plus the five isolated runs this
> ticket's own unblock condition asks for:
>
> | observation | result |
> | --- | --- |
> | full-suite runs ×2 (2026-08-22) | red both |
> | isolated runs ×5 (the stated gate) | **red 5/5** |
>
> Every one carries the identical verdict — `Block default/OwnerKey is unavailable
> (claimed-elsewhere): the repo could not determine whether it exists`, raised from a deferred row
> constraint during bring-up. The body describes "about four times in ten"; it is now every run.
>
> **The corroboration floor this ticket blames has already been changed upstream.**
> `quorumSize` in `../optimystic/packages/db-p2p/src/cluster/quorum-restore.ts` now computes
> `Math.max(1, Math.min(CORROBORATION_FLOOR, corroboratorCapacity))` — so a capacity of one yields
> a floor of one, which is exactly what this ticket's unblock condition asked for. Three upstream
> tickets naming that code are in `../optimystic/tickets/complete/`:
> `corroboration-floor-defaults-to-two-for-large-meshes`, `corroboration-floor-uses-assumed-cluster-size`,
> and `1-bug-read-repair-unrepairable-small-cluster`.
>
> So **the unblock condition as written is satisfied and the failure is unchanged.** Whatever
> produces `claimed-elsewhere` today is not the floor. The verdict is minted at
> `../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts:436-443` (`absence === 'claimed'` →
> `'claimed-elsewhere'`); that mapping, not `quorum-restore.ts`, is where a fresh investigation
> should start. The `files:` header above is stale in the same way.
>
> **The green→red flip is real and unexplained.** On 2026-08-18 (HEAD `8418d24`, `@optimystic/*`
> `^0.24.0`) this scenario passed both full runs and the delta note in
> `tickets/.pre-existing-known.md` says so. Today, at `^0.24.2`, it is 7/7 red. Two commits touched
> the scenario file in between (`1b875ee` and `969cd42`), and **neither explains it**: both land in
> scenario 2's setup plus one added assertion in scenario 4, while the failure is a query error
> during bring-up, not an assertion. That leaves the 0.24.0 → 0.24.2 upstream step as the
> unexamined candidate — `../optimystic` landed `relay-cannot-dial-its-own-reservation-holders` and
> `address-book-merge-logs-under-two-namespaces` in that window. Worth a bisect before anything else.
>
> **This is the defect an outside embedding team is holding multi-device work on** (their report is
> in `tmp/cross-machine-replication-known-broken-0.11.0.md`, which names this class and asks for a
> signal when it clears). It has not cleared. Any release note must say so.


# Blocked (b): a block only one machine holds cannot be read by anyone else

**Category (b) — dependency outside this repo.** The rule that fails is
`@optimystic/db-p2p`'s read-repair corroboration floor, in the sibling checkout
`../optimystic`, which Sereus consumes as built `dist`. Sereus has no configuration
lever that reaches it (measured — see "Why Sereus cannot fix this"). Nothing in this
repository can make the failing case pass.

**Unblock condition:** an upstream change that lets a cohort member acquire a block
that exactly one peer claims, when no second holder exists to corroborate the claim —
or that guarantees a committed block reaches a second holder before it becomes
readable. Then rebuild (`cd ../optimystic && yarn build`), re-run the scenario below
five times, and delete this ticket's entry from `tickets/.pre-existing-known.md`.

## The failing test

`packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts`
→ `E2E push-wake over the control network`
→ `wakes a member whose authorization and address were learned by control-DB replication, not local seeding`

```
yarn workspace @serfab/cadre-core build   # only to satisfy the suite's stale-build guard
yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts
```

```
QuereusError: Error during query on table 'OwnerKey': Query failed:
  Block 8ON_OqRkAS5nMz9mx-K0-sLyKj_sofjYZR0MSgUa3i4 is unavailable (claimed-elsewhere):
  the repo could not determine whether it exists
 ❯ Object.run ../../../quereus/packages/quereus/src/runtime/emit/scan.ts:227:10
 ❯ Object.deferredEvaluator [as evaluator] ../../../quereus/packages/quereus/src/runtime/row-constraints.ts:363:52
 ❯ DeferredConstraintQueue.evaluateEntry ../../../quereus/packages/quereus/src/runtime/deferred-constraint-queue.ts:189:18
Caused by: Error: Query failed: Block 8ON_… is unavailable (claimed-elsewhere): …
 ❯ OptimysticVirtualTable.runQuery ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:825:13
```

The named block varies between runs — sometimes the collection header `default/OwnerKey`,
sometimes a random-id data block like `8ON_…`. Both reach the same failure.

**Rate: 4 of 9 whole-file runs at HEAD `969cd42`** (2 of 5 plain runs, plus the first
exploratory run and the first `DEBUG` run). It fails **early** — the case dies at
~1.35 s, where a passing run of the same case takes ~3.2-3.7 s. So this is not a
timeout: something answers, and the answer is a hard error.

It **passes reliably in isolation** (`-t "learned by control-DB replication"`, ~5 s), and
passes when paired with any single one of its three predecessors. Only the full file
reproduces it. That is a scheduling accident, not evidence of test pollution — see
"Why it looks flaky".

## Root cause (measured, not inferred)

Captured with `DEBUG='optimystic:db-p2p:coordinator-repo*'` on a failing run:

```
cluster-fetch:no-quorum {
  blockId: '8ON_OqRkAS5nMz9mx-K0-sLyKj_sofjYZR0MSgUa3i4',
  responders: 1,
  required: 2,
  repairCorroborationClusterSize: 2
}
```

Emitted twice, by two different peers — the first coordinator and the transactor's
second-chance retry coordinator. Then the read throws.

**`responders: 1, required: 2` is the whole defect.** Exactly one cohort peer claims to
hold the block; the corroboration floor demands two; nothing else can be produced; the
read fails.

Critically, **there is no `cluster-fetch:peers-silent` line for that block id**. Both
non-self peers *answered* the consult within the 1 s deadline — one claimed a revision,
the other truthfully answered "I hold nothing". So this is **not** a slow-peer /
unreachable-peer / timeout problem. It is the literal, correct state of the world: the
block has exactly one holder.

### Why exactly one holder is the normal case here

Scenario 4 stands up a dedicated owner `A`, then `S` and `Rx`:

- `A` starts **alone** and performs genesis (`makeOwnOwner` → `insertOwnerKey`). The
  `OwnerKey` rows commit against a one-node cohort, because control writes are allowed to
  commit downsized. `A` is the only machine in existence, so `A` is the only holder.
- `S` and `Rx` then start and join, and all three are explicitly connected in a full mesh.
- Now a read of `OwnerKey` (a deferred row constraint on the next control insert) is
  coordinated by whichever of the three is closest to the block id. Test peer identities
  are ephemeral, so that is a different node on every run.
- If the coordinator is `A`, it holds the block locally, never enters the missing-block
  consult, and serves it. **Pass.**
- If the coordinator is `S` or `Rx`, the block is missing locally, it consults the cohort,
  and gets exactly one claim (`A`) against a floor of two. **Fail.**

This is a **bootstrap deadlock**: read repair is the mechanism that would give the block
a second holder, and read repair refuses to run until the block already has a second
holder.

### Why the floor cannot come down

In `quorum-restore.ts`:

```
corroboratorCapacity(cohortPeerCount, repairCorroborationClusterSize)
  = max(cohortPeerCount, repairCorroborationClusterSize - 1)

quorumSize(responderCount, threshold, capacity)
  floor = max(1, min(CORROBORATION_FLOOR /* 2 */, capacity))
```

Here `cohortPeerCount` is 2 (the two non-self peers) and
`repairCorroborationClusterSize` is 2 (Sereus's `assumedClusterSize`), so
`capacity = max(2, 1) = 2` and the floor stays at 2.

The `max` with the observed cohort size is **deliberate upstream** — it is what stops a
partitioned or attacker-shrunk cohort view from talking the corroboration requirement
down to a single voter. But it conflates *"how many peers could answer"* with *"how many
peers could possibly hold this block"*, and for a freshly-committed block those are
different numbers.

### Why the transactor's retry does not save it

`network-transactor.get` gives a flagged (`unavailable`) entry exactly **one**
second-chance round against a different coordinator. With a three-node cohort and one
holder, both the first coordinator and the retry coordinator can be non-holders — which is
precisely what the two `no-quorum` lines from two distinct peers show. There is no third
round, so `BlockUnavailableError` propagates into the SQL layer.

Note also that the retry has no reason to prefer `A`: the consult already established that
a specific peer *claims* the block, but that evidence (`claimedAheadRev`) is not used to
steer the retry toward the claimant.

### Contrast: an empty table is fine

The same run shows `default/Revocation` with `responders: 0, required: 2`. Zero claims
means no peer asserts existence, so the verdict is `confirmed` and the absent answer is
authoritative. Only a block with **one** holder — more than zero, fewer than the floor —
hard-fails.

## Why it looks flaky

Nothing leaks between the four cases in the file. Each uses a distinct `partyId`, a fresh
`MemoryRawStorage` per node, and stops every node in a `finally`. What the predecessors
change is **timing**: they shift when `S`/`Rx` finish joining relative to `A`'s genesis
write, and therefore whether some other replication path (the control-DB row re-issue
queue / a `db-p2p/sync` pull) happens to deliver `OwnerKey` to a second node *before* the
constraint read runs. Win that race and there are two holders and it passes; lose it and
there is one holder and it throws.

Running with `DEBUG` on also perturbs the timing — the first `DEBUG` run of this
investigation passed, and the failure was caught on a later one. Expect to run it a few
times.

## Why Sereus cannot fix this

`packages/quereus-plugin-sereus/src/cluster-size.ts` already sets
`CONTROL_CLUSTER_POLICY.assumedClusterSize: 2`, which is the documented escape hatch for
small deployments. It does not reach this case, and no other value would:

| `assumedClusterSize` | `capacity = max(2, size - 1)` | floor |
|---|---|---|
| 1 | `max(2, 0)` = 2 | 2 |
| 2 (current) | `max(2, 1)` = 2 | 2 |
| 16 | `max(2, 15)` = 15 | 2 |

The `max` against the observed cohort peer count (2) pins the capacity at ≥ 2 for any
party with three or more machines, so the floor of two always binds. There is no Sereus
knob that lowers it, and adding one would be re-litigating an upstream safety decision
from the wrong repo.

The other Sereus-side lever — that control writes may commit on a downsized, possibly
one-member cohort — is what creates the single-holder block in the first place. It is
deliberate and load-bearing (a one-node party must be able to write; see
`control-write-while-alone-convergence.integration.ts`), and removing it is a product
decision, not a bug fix. It would also not repair blocks already written that way. Same
disposition as the equivalent note in `control-peer-row-refresh-invisible-to-third-node`.

## Relationship to `control-peer-row-refresh-invisible-to-third-node`

That ticket reports the **same upstream site and the same log line**
(`cluster-fetch:no-quorum … responders: 1, required: 2`, corroboration floor pinned at 2).
It is a genuinely different failure and is kept separate:

|  | that ticket | this ticket |
|---|---|---|
| block state | present locally but **stale** | **missing** locally |
| observed effect | stale revision served silently as authoritative | hard `BlockUnavailableError` reaches SQL |
| why no 2nd corroborator | peer `C` is unreachable, and circularly so — the row being repaired is `C`'s own address | no second corroborator **exists**; the block was committed by a lone node |
| cohort connectivity | degraded (B cannot reach C) | full mesh, all three peers answered |

They are very likely to resolve together — a fix to the single-corroborator case should
clear both — so re-measure this one whenever that one moves. Do not merge them; the
unblock conditions are stated differently and this one has no unreachable peer to blame.

## Design constraints

- **Do not skip, loosen, or delete the test.** The scenario is proving a real production
  path (a member reads a membership fact written by a sibling machine). A single-holder
  block being unreadable is a genuine availability defect that a real party hits on the
  ordinary enrollment sequence — one machine sets things up, others join afterwards — so
  the test is right and the system is wrong.
- **Do not "fix" it by seeding the block locally on `S`/`Rx`.** That is exactly the local
  seeding the scenario exists to prove is unnecessary; it would make the test vacuous.
- **Do not lower the corroboration floor globally.** The floor defends against a lying
  peer steering restoration, and block ids here are **random 256-bit values, not content
  hashes** (`db-core/src/blocks/structs.ts`) — so fetched bytes do *not* self-certify
  against the id, and "one claim is enough because we can verify the content" is **not**
  available as a shortcut. Any upstream fix has to justify trusting a lone claimant some
  other way (e.g. a commit certificate, or a serve-without-persisting path that declines to
  adopt the revision as its own).
- **A fix must not re-open the silent stale serve.** The `unavailable` flag exists because
  the previous behaviour was to quietly serve a possibly-wrong answer. Turning this error
  back into a silent absent would be a regression, not a fix.
- **Preferred fix direction is upstream availability, not upstream trust relaxation:**
  guarantee a committed block reaches a second holder before it is considered readable, or
  let the reader route to the peer that positively claims the block instead of demanding a
  seconder. The second is smaller; the first removes the class.

### Cross-cutting obligations

None triggered. Assessed explicitly:

- **Determinism edition bump** — not applicable; no change to evaluation semantics or
  planner output is proposed here.
- **Byte-format vector** — not applicable; no wire or storage encoding changes. The block
  id format is unchanged (and is load-bearing only as an argument *against* one candidate
  fix).
- **Golden fixture** — not applicable; the failure is an availability/timing property, not
  a serialized output.
- **Migration** — not applicable; no schema or persisted-state shape changes. A fix that
  ensures a second holder at commit time changes replication timing only, not stored bytes.

If the eventual upstream fix does change the commit path's durability contract, re-check
the first and last of these before landing.

## Reproduce

From the repo root, several times — it is a scheduling race:

```
yarn workspace @serfab/cadre-core build
yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts
```

For diagnosis (perturbs timing; may need a few attempts to catch a failure):

```
DEBUG='optimystic:db-p2p:coordinator-repo*' \
  yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts
```

Then look for `cluster-fetch:no-quorum` carrying `responders: 1` on the block id named in
the thrown error, and confirm there is **no** `cluster-fetch:peers-silent` line for that
same block id — that pair is the signature of this defect rather than of a slow cohort.

## Measurement conditions

- sereus clean at `969cd42`, `@serfab/cadre-core` freshly built.
- `../optimystic` clean at `235539e`, `../quereus` clean at `596f8ea76`; every sibling
  package's `dist` verified newer than its `src` before any run, so no portal-dist build
  drift is in play.
- Windows 11, Node via yarn workspaces, vitest 4.1.8.

## Also seen once, and NOT this defect

On the very first run of this investigation the sibling case
`delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial` failed
with `No dialable control-network address for peer 12D3KooW…`. It passed in all eight
subsequent runs, including the five plain ones. Recorded here so the next reader does not
treat it as new, but it is a different signature with a different owner and is not tracked
by this ticket.
