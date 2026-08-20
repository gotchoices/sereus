---
description: A node could silently give up on a peer forever when that peer's list of network addresses was formatted inconsistently; that is fixed everywhere a node picks addresses to dial, and a failed attempt to nudge a sleeping peer awake now reports every address it tried instead of just the last one, under an overall time limit.
files: packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/invite-address-push.spec.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/architecture.md
---

# Complete: control-network dial paths agree on what a peer's address list is

Implemented in `969cd42`, reviewed and extended in this pass. All three arms of the source ticket
landed; the review found the fix had been applied to one of the **three** places a control dial gets
its candidate addresses, and closed the other two.

## What the feature does

A `CadrePeer` row carries a peer's dialable multiaddrs. Some of them end in `/p2p/<peer>` (a
circuit-relay address always does), some do not (a bare direct address). `libp2p.dial(addrs)`
refuses a list that mixes the two — the addresses in one call must all name a peer id or none may —
and it refuses it *before touching a transport*, so the caller sees one thrown error and the peer is
skipped **entirely**, on every reconcile pass, forever, with only a debug line.

The fix is a single rule, `withTrailingPeerId(addr, peerId)` (`peer-record.ts:138`): return the
address guaranteed to end in `/p2p/<peerId>`, or `null` when it cannot because it already ends in a
*different* peer's id. It discriminates on "does the address's LAST component name a peer", which is
exactly what libp2p's own `calculateMultiaddrs` does, followed by libp2p's wrong-peer-id filter — so
a normalized list is what libp2p would have built anyway. It appends the suffix to a bare direct
address, completes a destination-less relay hop (`…/p2p/<relay>/p2p-circuit`), leaves an
already-correct address untouched by identity, and drops an address naming someone else.

`CadreNode.normalizeDialAddrs` applies it — and now also de-duplicates, since normalization is what
makes the suffixed and unsuffixed forms of one address equal. Entry side, `normalizeSelfAddrs` puts
the two app-supplied hooks (`setInviteAddresses`, the admin API `PUT /admin/invite-addresses`; and
`network.inviteAddressResolver`) onto `/p2p/<self>` before anything publishes them, so neither hook
has to know the rule.

Two further behaviours landed with it:

- **A failed wake names every candidate.** `dialWake` collects a `{addr, error}` per candidate and
  throws one error naming each address and its cause, with the first failure as `cause`. A
  single-candidate failure still throws that candidate's own error unchanged.
- **One budget for the whole wake dial.** `DEFAULT_WAKE_DIAL_BUDGET_MS = 20_000` caps the whole
  `dialWake` call; the per-attempt timeout stays 10 s. The last candidate inside the budget gets a
  real (shortened) try; candidates the budget leaves no room for are reported as `not tried`, named,
  rather than silently dropped. The candidate loop is deliberately NOT collapsed into one
  `dialProtocol(addrs)` — libp2p would re-sort it with `defaultAddressSorter`'s
  `circuitRelayAddressesLast` pass and demote the signaling address the ordering puts first (verified
  in `libp2p/dist/src/connection-manager/address-sorter.js:124`).

`dialOneSibling` (`strand-addr-protocol.ts`) got the reporting half only — one log line naming every
target and cause on total failure; its best-effort `[]` return is unchanged, as the source ticket
required.

## Review findings

### Fixed in this pass

- **The seam had a second source, and it hands back a list that is inherently mixed.**
  `resolvePeerAddrs` was normalized; `peerStoreAddrs` — the cold-start fallback
  `resolveControlDialAddrs` uses when a sibling's signed record does not resolve yet — was not, and
  its output goes straight into the same `controlNode.dial(addrs)`. It is not a tidier source than
  the record but a messier one: `@libp2p/peer-store`'s `dedupeFilterAndSortAddresses`
  (`node_modules/@libp2p/peer-store/dist/src/utils/dedupe-addresses.js`) strips a trailing
  `/p2p/<peerId>` only when that id is the address's **first** `/p2p/` component — so a direct
  address round-trips bare while a relayed one, whose first `/p2p/` names the relay, keeps its
  suffix. The repo already knew this (it is why `peer-addr-book.ts`'s `addrKey` exists) and the
  address book is filled from both sides: `mergePeerAddrs` writes the resolver's now-always-suffixed
  addresses into it, libp2p's identify writes bare ones. The whole original defect, on the one path
  where the fallback is the *only* way in. Normalized, with a test that fails without it.
- **`bootstrapDialAddrs` was a fourth hand-rolled copy of the same rule, and disagreed with the new
  one.** It bound a seed's retained owner addresses by "does any `/p2p/` component match", which
  reads a destination-less relay hop's trailing id as the relay's and drops the address — where
  `withTrailingPeerId` completes the circuit to the owner. Replaced with a call to
  `normalizeDialAddrs`, deleting ~20 lines and the divergence; the pre-existing bootstrap tests
  (bind-when-absent, drop-different-peer) still pin the behaviour, and a new test covers the relay
  hop. The source ticket's own framing — three sites with three rules — was one site short.
- **Normalization can create duplicates.** The suffixed and unsuffixed forms of one address are
  distinct strings on a record and the same address afterwards; a surviving duplicate costs a real
  dial attempt, which for `dialWake` is a whole slice of its 20 s budget. `normalizeDialAddrs` now
  keys by the normalized string. Test added; it fails without the dedupe.
- **`withTrailingPeerId` can throw and one caller passes an unvalidated peer id.** It encapsulates
  `/p2p/<peerId>`, which throws on an id that does not parse — unreachable for a `CadrePeer` row (the
  binding gate parsed it already) but reachable for a seed-supplied one, which is now a caller.
  Extracted `bindAddrToPeer`, which logs and returns `null` instead, so list-shaping stays total for
  every caller.
- **Docs asserted an invariant narrower than the one that now holds.** `docs/architecture.md`
  attributed normalization to "this one seam"; it now names all three candidate sources, the
  peerStore's asymmetric round-trip, and the dedupe. The cold-start bullet's binding description was
  updated to the shared rule (it still described the deleted hand-rolled one).
- **`normalizeSelfAddrs`'s error path was untested.** Added a case to `invite-address-push.spec.ts`:
  a pushed bare address comes back suffixed, an unparsable entry passes through untouched. That
  spec's existing first case already pins the deliberate non-normalization of the `getMultiaddrs()`
  branch.

### Checked and found sound

- **`groupAddrsByPeerId`** still has its own attribution rule and is correct as-is: it consumes the
  strand-addr RPC's peer-*agnostic* union, where there is no single target to normalize against, so
  dropping an unattributable address is the right answer there, not a fourth disagreement.
- **`mergeStrandPeerAddrs`** writes per-peer groups into a peerStore and never dials a list, so the
  all-or-none precondition does not apply to it.
- **`dialControlSibling`** hands a whole list to one `dial()`, which libp2p then re-sorts with
  `circuitRelayAddressesLast` — inverting the signaling-first order the resolver produced. Not a
  defect and deliberately not "fixed": `dial()` tries every address until one connects, so the order
  costs latency, not reachability, and `controlDialTimeoutMs` bounds the pass. This is the exact
  asymmetry `dialWake`'s doc comment explains for the case where it *does* matter.
- **`withTrailingPeerId` on a WebRTC circuit address** (`…/p2p-circuit/webrtc`) appends to produce
  `…/p2p-circuit/webrtc/p2p/<peer>`, which is the canonical form — checked because
  `resolvePeerAddrs` is documented as the WebRTC dial path's input.
- **Signature safety.** Both new helpers are applied strictly after verification; `resolvePeerAddrs`
  still verifies against the original on-record strings, and `peer-record.ts` says so at the site.
- **Wake budget accounting.** Attempts are capped at `min(timeoutMs, remaining)`, so the call returns
  at the budget rather than past it; the failure list is bounded by the candidate count; the aborted
  attempt's signal still resets the live stream, so nothing leaks on the shortened try.
- **`pushWake` is `dialWake`'s only caller** and `PushFanoutService.wakePeer` awaits it with no
  timeout of its own, so the budget is a strict improvement there (previously unbounded in the
  candidate count).

### Recorded as tripwires, not tickets

- `strand-addr-protocol.ts:359` (`NOTE:` on `dialOneSibling`, parked by the implementer and left in
  place): its cost is still (targets x `timeoutMs`) with no whole-sibling budget — the shape
  `dialWake` now bounds. Fine today because `dialTargets` yields the peer id plus one or two resolved
  addresses for a cadre device; if a sibling's record ever carries a long address list, it needs the
  same treatment.

### Not filed

- **`cadre-node.ts` is 5591 lines**, measured with `wc -l`. Already claimed by
  `backlog/debt-cadre-node-single-file-size`; this pass took a net 7 lines *off* it (the
  `bootstrapDialAddrs` collapse pays for the new helper) and did not file a duplicate.
- **The reported wake intermittent stays unproven, deliberately.** The source ticket could not
  reproduce it and neither did the implementation or this review. The rate comparison that would
  settle it (several full integration runs at `d3c7c2a` vs HEAD, ~969 s each) is not agent-runnable.
  The aggregated wake error is what makes the *next* occurrence self-explaining — it will name a
  specific address, and that is what a follow-up ticket should be filed against. Filing one now would
  be filing against a guess.
- **The whole-file push-wake integration failure the implementer flagged is already owned.** The
  runner's triage pass (`696b7ad`) re-triaged it, filed
  `blocked/block-held-by-only-one-machine-is-unreadable`, and re-pointed `.pre-existing-known.md`;
  `.pre-existing-error.md` is consumed and gone. Root cause is upstream in `@optimystic/db-p2p` (a
  block with exactly one holder against a read-repair corroboration floor of two). Nothing to add.

### Coverage gaps that remain

- **The full integration suite (~969 s) was not run** — it is not agent-runnable inside a ticket.
  Four address-shape-relevant scenarios were: `push-wake-e2e` (4/4),
  `control-cohort-cold-start-retry` (1/1, the scenario that exercises the newly-shared
  `bootstrapDialAddrs`), `control-cohort-auto-convergence` (1/1, the peerStore-fallback path), and
  `relay-only-control-addr` (4/4). A scenario elsewhere asserting on exact resolved address strings
  would not have been caught.
- **No test drives a real libp2p `dial()` with a mixed list.** The cohort spec's fake reproduces
  `getPeerAddress`'s precondition from the installed source rather than calling it, so an upstream
  change to that rule would not surface as a failing test here. Acceptable: the rule is a documented
  libp2p API contract, and the alternative is a live two-node dial per case.

## Results

| command | result |
| --- | --- |
| `yarn lint` | clean |
| `yarn typecheck` | clean |
| `yarn workspace @serfab/cadre-core test` | 104 files, 1664 passed / 1 skipped (4 added this pass) |
| `yarn workspace @serfab/cadre-host test` | 66 files, 608 passed / 4 skipped |
| `yarn workspace @serfab/cadre-cli test` | 16 files, 213 passed |
| `push-wake-e2e.integration.ts` | 4/4 |
| `control-cohort-cold-start-retry.integration.ts` | 1/1 |
| `control-cohort-auto-convergence.integration.ts` | 1/1 |
| `relay-only-control-addr.integration.ts` | 4/4 |

Every new test was verified adversarially: reverting the fix it covers fails that test and no other.
Reverting the `peerStoreAddrs` + `bootstrapDialAddrs` normalization fails 4 (one new, three
pre-existing bootstrap cases); reverting the dedupe alone fails exactly 1.
