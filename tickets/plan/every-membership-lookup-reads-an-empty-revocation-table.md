description: Before answering almost any question about who is in the party or how to reach them, the control database first asks "has this been revoked?" — and on a party where nothing has ever been revoked, that question costs a full network lookup every single time, because an empty table is exactly the case the storage layer never learns to stop checking. An idle solo node spends about 46 network lookups a minute on this, forever, and every control-plane insert pays one too.
prereq:
files:
  - packages/cadre-core/src/control-database.ts:1021 (`queryRevokedStamps` — called unconditionally, before the row read)
  - packages/cadre-core/src/control-database.ts:872 (`queryCadrePeers` — pays it on every call)
  - packages/cadre-core/src/control-database.ts:1069 (`queryPeerRecord` — same)
  - packages/cadre-core/src/control-database.ts:1038 (`queryRevocations` — full scan, no empty short-circuit)
  - packages/cadre-core/src/cadre-node.ts:2652 (`reapRevokedRows` on the ~15 s reconcile tick)
  - packages/quereus-plugin-sereus/src/control-schema.ts:26,107,167,335,389,501 (`NotRevoked` insert checks subquerying `Revocation` on six tables)
  - packages/cadre-core/src/control-database.ts:848-851,1011-1013,1909-1916 (existing debt comments acknowledging this)
  - packages/cadre-core/src/cadre-node.ts:2596-2601 (same)
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts:200 (the budget spec that excludes genesis by construction)
difficulty: medium
tradeoffs: Caching "nothing is revoked" is caching a security-relevant negative, and a revocation that has landed but is not yet visible is the failure direction that actually matters. Any memo here needs a retirement story a reviewer would accept for an authorization check, which is a higher bar than for an ordinary read cache — and is why the cheapest-looking fix (just cache it) is the one most likely to be wrong.
----

# Every membership and address lookup pays a network read of an empty `Revocation` table

## Measured

From an in-process trace of a real solo `CadreNode` (network transactor, coordinated read path) driven through `start()` → `ensureOwnerKey()` → `foundStrand()`. Counters are Optimystic's own `cluster-fetch:solo-self-skip` and `commit:solo-cohort`; repeat runs identical.

| phase | cohort consults | commits |
|---|---|---|
| cold control-DB start (9-table schema + 8 uniq index trees) | 24 | 2 |
| genesis — **one** `OwnerKey` row | **18** | 4 |
| `foundStrand` — `Strand` row + strand launch | 47 | 12 |
| **founding total** | **89** | **18** |
| then idle, per minute, indefinitely | **~46** | 0 |

Eighteen cohort consults to write a single `OwnerKey` row, because `OwnerKey.NotRevoked` and `OwnerKey.Authorized` are deferred subqueries and one of them reads `Revocation`.

The idle figure is the one that should be alarming: **4 `Revocation` + 4 `CadrePeer` consults per ~15 s reconcile pass, forever, on a node doing nothing.** Both tables are empty on a fresh party.

Isolated directly — same query shape, six consecutive calls:

| collection | ever written? | consults per call |
|---|---|---|
| `OwnerKey` | yes, at genesis | 1 on the first call, then **0** |
| `Revocation` | never | **2, every call, 6 of 6** |

`ControlDatabase.queryCadrePeers()` measures **exactly 4 consults on every call, flat across 20 consecutive calls, with zero damping**. Writing a self peer record did not retire the `CadrePeer` half.

## Why an empty table behaves differently from a populated one

This is an Optimystic-side property, tracked there as `plan/a-block-we-do-not-hold-is-consulted-on-every-read`. In short: its read path rate-limits re-checking a block **it holds** (a 10 s window), but a block that is absent locally skips that window entirely and consults the cohort on every read, with nothing bounding it. A table that has never been written has no local block, so every read of it is the unbounded case.

So the upstream defect is real and is being fixed there. **This ticket is the half that stays ours**: even with a perfect upstream fix, reading a revocation table before every membership lookup is more work than the question requires.

## Why it is hot — the call sites

`queryRevokedStamps` is called **unconditionally, before the row read**, by both `queryCadrePeers` (`:872`) and `queryPeerRecord` (`:1069`). So every membership or address lookup pays an extra absent-block consult before it does its own work.

Reached from: `isAuthorizedMember` (per authorization check), the inbound strand-wake and strand-addr RPC gates, `admitInboundControlConnection` (**every inbound encrypted connection**), `admitControlRelayReservation`, `peer-join-backfill.authorizePeer` (per connected peer per pass), `resolveDeviceToken` (two separate `Revocation` reads per push target), the ~15 s reconcile tick, and the peer-record heartbeat.

`queryRevocations` (`:1038`) is a full scan with no empty short-circuit, called by `reapRevokedRows` on every reconcile tick.

And beneath the TypeScript entirely: six control-plane tables carry `NotRevoked` insert checks that subquery `Revocation`, plus `RevocationRecorded` on delete and `Strand.AuthorizedInsert`'s consent branch. **Every control-plane insert reads an absent block**, with no call site to grep for.

The code already knows. There are debt comments at `control-database.ts:848-851`, `:1011-1013`, `:1909-1916` and `cadre-node.ts:2596-2601`. What was missing was the number.

## What a design pass has to settle

**1. Is this a cache, or a question we should stop asking?** The cheap framing is "memoise the empty revocation set". The better question is why an address lookup consults a revocation table at all before reading the row it was asked for — a revocation could equally be checked against the row once it is in hand. Prefer the design that removes the read over the one that caches it; only fall back to a memo if the check genuinely has to precede the row.

**2. If it is a memo, what retires it?** This is an authorization input. A revoked member whose revocation is not yet visible is the failure direction that matters, and "it expires in 15 seconds" is an answer a reviewer should push back on. Name the invalidation event (a local write to `Revocation`, a reconcile that observes one, a version counter) and state the worst-case staleness in seconds, for a human to accept or reject.

**3. The schema-level reads are the larger half and have no call site.** Six `NotRevoked` insert checks cannot be fixed by editing TypeScript. Decide whether those subqueries can be made conditional, indexed, or deferred — and note that changing `control-schema.ts` is a schema change with its own migration consequences.

**4. `CadrePeer` is absent too on a solo party, and writing a peer record did not retire it.** Establish why before assuming the same fix covers both; it may be a different block (index tree versus base table) than the one being written.

**5. Interaction with the upstream fix.** If Optimystic bounds absent-block consults, the idle floor drops without us doing anything, and the remaining cost is one consult per window rather than per read. Decide honestly whether that is sufficient and this ticket becomes a smaller cleanup — but do not *assume* it, because the upstream conservative variant may only cover a provably-solo cohort, which is not the deployment shape that matters most here.

## Coverage gap — none of our budgets can see this

Worth stating plainly, because it is why this ran for months unmeasured:

- **`control-start-storage-op-budget.spec.ts:200` excludes genesis by construction** — it takes its snapshot first, with a comment saying "Genesis AFTER the snapshot, so it costs the cold budget nothing." The 18 consults and 4 commits of genesis are budgeted nowhere.
- **Both storage budgets count `IRawStorage` calls below the write-through cache.** Every counter above lives *above* that cache, in Optimystic's coordinator, and an absent-block consult never reaches raw storage at all. A regression doubling cohort consults would leave both budgets green.
- **`strand-solo-write-budget.spec.ts` wraps only strand storage** and asserts control-storage ops are zero before `addStrand`, so the control plane is excluded deliberately.
- **`packages/integration-tests/` asserts no op or commit counts at all** — its `callCount()` uses are anti-vacuity checks, and the degraded-cohort scenario bounds wall clock rather than counts.

The gate that would have caught this is a **commit and cohort-consult budget over `start()` → `ensureOwnerKey()` → `foundStrand()`**. It does not exist. Build it before the fix so the improvement is measured rather than asserted.

## TODO

- [ ] Add the founding commit/consult budget gate first; record the current 89/18 as the baseline.
- [ ] Settle questions 1–5. Question 2 is an authorization-staleness call — if it has no defensible default, route it to `blocked/` rather than picking a TTL.
- [ ] Add an idle-rate assertion too: a node doing nothing should not emit a per-minute consult floor that grows with the number of empty control tables.
