----
description: A node could silently give up on a peer forever when that peer's list of network addresses was formatted inconsistently; that is fixed, and a failed attempt to nudge a sleeping peer awake now reports every address it tried instead of just the last one, under an overall time limit.
files: packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/peer-record-resolution.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/architecture.md
difficulty: medium
----

# Review: control-network dial paths now agree on what a peer's address list is

Implemented from `implement/wake-and-cohort-dials-mishandle-peer-address-lists`. All three arms
landed. Read "What to distrust" before signing off — the intermittent this came from is still
unproven either way, and one whole-file integration failure showed up that is **not** this work
(measured at `HEAD`, recorded in `tickets/.pre-existing-error.md`).

## What changed

### Arm 3 — the seam (this was the verified defect)

New pure helper `withTrailingPeerId(addr, peerId)` in `peer-record.ts:138`. Given a multiaddr and
the peer it is supposed to reach, it returns that address guaranteed to end in `/p2p/<peerId>`, or
`null` when it cannot. Three cases:

| input | result |
| --- | --- |
| `/ip4/1.2.3.4/tcp/4001` (no `/p2p/` at all) | suffix appended |
| `…/p2p/<relay>/p2p-circuit` (relay hop, destination missing) | suffix appended → full circuit |
| `…/p2p/<X>` | unchanged if `X` is the target; **dropped** otherwise |

The discriminator is "does the address's LAST component name a peer", which is exactly what
libp2p's own `calculateMultiaddrs` uses, followed by its wrong-peer-id filter. So a normalized list
is what libp2p would have built anyway.

`CadreNode.resolvePeerAddrs` (`cadre-node.ts:2009`) applies it to every address it returns, via
`normalizeDialAddrs`. That is the single place every control-network dial path gets its candidates
from, so the mixed suffixed/unsuffixed list that made `libp2p.dial(addrs)` throw
`InvalidParametersError` — and the sibling be skipped **entirely**, on every reconcile pass,
forever, with only a debug line — is no longer representable downstream.

Entry side: `resolveInviteAddresses` (`cadre-node.ts:4845`) now normalizes both app-supplied
sources — `setInviteAddresses` (the admin API `PUT /admin/invite-addresses`) and
`network.inviteAddressResolver` — onto `/p2p/<self>` via `normalizeSelfAddrs`. **Choice made and
worth reviewing:** normalize on the way in, rather than only document the requirement. Both hooks'
doc comments now state that a suffix is optional. The third branch (`getMultiaddrs()`) is
deliberately *not* normalized — it is libp2p's own output, which already carries the suffix; a
comment says so at the site. Unparsable or other-peer-addressed entries pass through untouched on
this path (publication does not police validity; `resolvePeerAddrs` drops both on the read side).

### Arm 1 — a failed wake names every candidate

`dialWake` (`strand-wake-protocol.ts:296`) collects a `{addr, error}` per candidate and throws one
error naming each address and its cause, with the first failure as `cause`. A single-candidate
failure still throws that candidate's own error unchanged, so `rejects.toThrow(/timed out/)` still
means what it says. `dialOneSibling` (`strand-addr-protocol.ts:387`) got the reporting half only —
one log line naming every target and cause on total failure; the best-effort `[]` return is
unchanged, as the source ticket required.

### Arm 2 — one budget for the whole wake dial

`DEFAULT_WAKE_DIAL_BUDGET_MS = 20_000` (exported), with the reasoning in its doc comment, following
`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS`'s pattern and landing on the same number. Per-attempt
timeout stays 10 s; the whole call is capped at 20 s. The last candidate inside the budget gets
whatever remains of it (a real, shortened try — not a skip); candidates the budget leaves no room
for are reported as `not tried`, named, rather than silently dropped. `DialWakeOptions.budgetMs`
overrides per call.

The candidate loop was **not** collapsed into one `dialProtocol(addrs)`, per the source ticket's
trap. A doc comment at `dialWake` now records why, so the next person does not re-derive it.

## Use cases to exercise

**The one that was broken.** A cadre sibling whose `CadrePeer` record mixes address shapes — say a
relay-provided circuit address ending in `/p2p/<sibling>` plus a NAT-resolver-provided direct
address with no `/p2p/` at all. Before: skipped by every reconcile pass; the pass logged
`dialed=0` and moved on. After: dialed. Reachable in production through either invite-address hook,
not just in tests — `cadre-host`'s `buildInviteAddresses` happens to suffix everything, but nothing
enforced that.

**Wake a peer whose addresses are all dead.** With `DEBUG=sereus:cadre:strand-wake` off, the thrown
error alone should now tell you which addresses were tried and why each failed. Previously it named
whichever was tried last — which is how the source ticket came to be written about the wrong
address.

**Wake a peer with several blackholing addresses.** Total wall-clock should be ≈20 s, not
(addresses × 10 s).

**Invite-address round trip.** `setInviteAddresses(['/ip4/1.2.3.4/tcp/4001'])` → the published
`CadrePeer` row carries `/ip4/1.2.3.4/tcp/4001/p2p/<self>`. Passing it already-suffixed is a no-op.

## Tests

- `packages/cadre-core/test/peer-record.spec.ts` — 7 new cases on `withTrailingPeerId`: append to a
  bare direct addr, append to a `ws` addr, leave a target-suffixed circuit addr untouched (by
  identity, not merely string equality), complete a destination-less relay hop, drop a
  different-peer addr, idempotence, and a mixed list becoming uniform.
- `packages/cadre-core/test/peer-record-resolution.spec.ts` — real control DB. Existing cases
  updated to the new (correct) expectations; one new case pins that a resolved addr terminating in
  a different peer id is dropped. Also asserts the *stored* row is uniformly suffixed, so the
  entry-side normalization is pinned, not just the read side.
- `packages/cadre-core/test/cadre-node-control-cohort.spec.ts` — 3 new cases in
  `— inconsistently-suffixed sibling record`, driven by the REAL `resolvePeerAddrs` against a
  signed record (new `records:` option on `injectCohort`). **The shared `dial` fake now enforces
  libp2p's own all-or-none peer-id precondition**, so these assert `dialed=1` and the exact
  addresses dialed, not merely "no throw". Verified adversarially: with `normalizeDialAddrs` removed
  all 3 fail and the other 35 still pass.
- `packages/cadre-core/test/strand-wake-protocol.spec.ts` — 5 new cases: all-candidates-named,
  first-failure-as-cause, single-candidate-unchanged, whole-call budget with an untried candidate
  named, and the last-candidate-gets-the-remainder case.
- `packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts` — `syntheticDirect` kept
  (it is the only coverage of the fall-through path) and now doubles as the *unsuffixed* arm of a
  mixed record; both wake routes assert the resolved list is uniformly suffixed with Rx's peer id.

## Results

| command | result |
| --- | --- |
| `yarn workspace @serfab/cadre-core test` | 104 files, 1660 passed / 1 skipped |
| `yarn workspace @serfab/cadre-host test` | 66 files, 608 passed / 4 skipped |
| `yarn workspace @serfab/cadre-cli test` | 16 files, 213 passed |
| `yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts` | 4/4 — but see below |
| `yarn workspace @serfab/integration-tests test src/scenarios/relay-only-control-addr.integration.ts` | 5/5 |
| `yarn typecheck` | clean |
| `yarn lint` | clean |

## What to distrust

**The reported intermittent is still unproven.** The source ticket could not reproduce it and
neither did this work. A green push-wake file is not evidence it is gone. The rate comparison that
would settle it (several full integration runs at `d3c7c2a` vs HEAD, ~969 s each) is not
agent-runnable and needs a human or CI. Arm 1 is what makes the *next* occurrence self-explaining;
do not file a follow-up ticket before there is a named address to file it against.

**A different whole-file integration failure appeared and is NOT this work.** The push-wake
scenario's fourth case (`wakes a member whose authorization and address were learned by control-DB
replication…`) failed five consecutive whole-file runs with `Block default/OwnerKey is unavailable
(claimed-elsewhere)` — then passed 4/4 before and after that streak, and passes reliably when run
alone. Reproduced with the same fingerprint after replacing all seven modified source files with
their `HEAD` contents and rebuilding. Written up in `tickets/.pre-existing-error.md` for the
runner's triage pass. `.pre-existing-known.md:112` already lists this test, but its owning ticket
(`control-db-cross-node-convergence-halted`) is in `complete/`, so nothing in flight owns it.

**Dropping a different-peer address is a behaviour change beyond "append a suffix."** It is the
right call — such an address does not reach the target, and libp2p filters the same shape one layer
lower — but it means a record that previously produced N candidates can now produce N−1. Two
existing test fixtures relied on the old leniency (a circuit addr ending in a made-up
`/p2p/12D3KooWMember` for a peer whose real id was something else) and were corrected to be
self-consistent. If any other caller depends on getting back exactly what the record stored, this
is where it would show.

**`normalizeSelfAddrs` is not applied to `getMultiaddrs()`.** That branch relies on libp2p always
encapsulating the peer id into the addresses it reports — true for the current version, verified in
`libp2p/dist/src/connection-manager/dial-queue.js` and by the `invite-address-push` spec's real
behaviour, but it is a dependency on someone else's invariant rather than one enforced here. It was
left that way deliberately: normalizing it changed what `createInvite` embeds for zero production
benefit, and `getMultiaddrs()` is not one of the two arbitrary-string hooks the ticket named.

**Only two integration scenarios were run.** Both address-shape-relevant ones, but the full
integration suite (~969 s) was not — so a scenario that asserts on exact resolved address strings
elsewhere would not have been caught. `grep`ping for `resolvePeerAddrs` across
`packages/integration-tests` turned up only length and `/p2p-circuit`-contains assertions, which
are unaffected, but that is a read rather than a run.

## Review findings

- **Tripwire parked at `strand-addr-protocol.ts:359`** (`NOTE:` on `dialOneSibling`): its cost is
  still (targets × `timeoutMs`) with no whole-sibling budget — the same shape `dialWake` now bounds.
  Fine today because `dialTargets` yields the peerId plus one or two resolved addresses for a cadre
  device; if a sibling's record ever carries a long address list, it needs the same treatment. Not
  filed as a ticket: it is conditional, not a latent defect.
- The three-way disagreement the source ticket identified (`groupAddrsByPeerId` drops unsuffixed
  addrs, `mergePeerAddrs` accepts them, `dialControlSibling` throws) is resolved by the seam rather
  than by changing those three sites: they now only ever see normalized input from
  `resolvePeerAddrs`. `groupAddrsByPeerId` still has its own rule for the *strand-addr RPC* union,
  which is a genuinely peer-agnostic list with no single target to normalize against — that one is
  correct as-is and was left alone.
- `docs/architecture.md` gained the normalization invariant (item 4 of the node-startup list) and
  the wake-dial budget + aggregated-error behaviour (hibernation mechanism 3). Both are architectural
  facts with no single code site that a reader would meet otherwise.
