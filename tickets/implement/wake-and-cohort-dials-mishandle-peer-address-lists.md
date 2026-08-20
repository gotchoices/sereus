----
description: When a node has several possible addresses for a peer, the code that dials it reports the wrong address on failure, can spend ten seconds per address with no overall limit, and silently gives up on a peer entirely if its address list is formatted inconsistently.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/peer-addr-book.ts, packages/cadre-core/src/control-cohort.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
difficulty: medium
repro: verified
----

# Control-network dial paths disagree about what a peer's address list is

Investigated from `fix/push-wake-circuit-dial-picks-unreachable-host-address`. That ticket asked
which of two explanations produced a wake-dial timeout against `/ip4/10.255.0.1/tcp/4001/ws`.
**Neither.** Both were wrong, and the investigation turned up a different, reproducible defect on
the same code path. Read "What the source ticket got wrong" before anything else, so the corrected
facts replace the old ones rather than sitting alongside them.

## What the source ticket got wrong

`10.255.0.1` is not a host virtual-adapter address that leaked in. **The test writes it itself**,
on purpose:

```ts
// push-wake-e2e.integration.ts:324
const syntheticDirect = '/ip4/10.255.0.1/tcp/4001/ws';
await L.authorizePeer(sPeerId);
await seedReceiverRecord(L, rxPeerId, rxKey, [rxCircuitAddr, syntheticDirect]);
```

So the receiver's published record legitimately carries two addresses, and the sender legitimately
resolves both. The receiver did not "acquire a direct address under load" (explanation 1) and the
sender did not "reach for an address the peer never advertised" (explanation 2). The hardened
assertion the source ticket suspected — `startAddrs.every(a => a.includes('/p2p-circuit'))` — checks
Rx's *live listen addresses*, which is a different thing from its *published record*, and it is
correct as written.

One property the source ticket flagged does hold, and it matters: on this development host
`10.255.0.1:4001` **blackholes**. A bare TCP connect hangs with no RST — measured at 12 s with a
`net.connect` probe before giving up. Every attempt against that address therefore costs a full
deadline rather than failing in milliseconds, and on a machine that RSTs instead it would cost
nothing. That is why the symptom is host-specific.

## Arm 1 — a failed wake reports an address it may never have dialed

`dialWake` (`strand-wake-protocol.ts:255-278`) walks candidates serially, gives **each** its own
full `timeoutMs` (default 10 s), logs every failure to `debug` only, and finally throws
`lastError`:

```ts
for (const addr of addrs) {
  try {
    return await withDeadline(timeoutMs, `Wake dial ${addr.toString()}`, …);
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    log('Wake dial to %s failed: %o', addr.toString(), err);   // only trace of candidate 1
  }
}
throw lastError ?? new Error('Wake dial failed');
```

The recorded failure took **23 826 ms** (`tickets/.logs/garden-compat-full-test.log`). Setup is
~4 s, and each deadline is 10 s, so *both* candidates timed out — the circuit address first, then
the synthetic direct one. The circuit failure was the interesting one and it went to a debug log
nobody had enabled; the message that surfaced named the second candidate. An entire fix-stage
ticket was then written about the wrong address. That is the cost this arm removes.

Same shape, same loss, at `strand-addr-protocol.ts:352-380` (`dialOneSibling`): every per-target
error is logged and discarded, and the function returns `[]` — a total failure and "the peer had
nothing to say" are indistinguishable to the caller.

## Arm 2 — no bound on the whole dial, only on each attempt

The cost of `dialWake` is (candidates × `timeoutMs`), which nothing chooses or caps. Against
blackholing addresses — the measured behaviour above, and the normal behaviour of a stale address
behind a dropped NAT mapping — each candidate really does burn its whole deadline.

This class is already understood in this repo. `control-cohort.ts:43-64` documents it at length
("an offline sibling's cost is address fan-out × relay hops × ~10 s — a number nothing in this
package chose or bounds") and resolves it by making the **sibling** the unit: one
`DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` budget covers whatever that sibling's addresses look like.
The wake and strand-addr paths never adopted that decision. They should.

## Arm 3 — a peer whose addresses are formatted inconsistently is never dialed at all

**This is the verified, reproducible defect**, and it is not confined to a test.

`dialControlSibling` (`cadre-node.ts:2294-2313`) hands the full resolved list to one
`libp2p.dial(addrs)`. libp2p's `getPeerAddress` (`libp2p/dist/src/get-peer.js:19-34`) requires that
the addresses in one dial **either all carry a `/p2p/` component or none do**, and throws
otherwise. `resolvePeerAddrs` returns exactly the forbidden mix here: the circuit address ends in
`/p2p/<Rx>`, the direct one has no `/p2p/` at all. Observed on every reconcile pass, with
`DEBUG=sereus:cadre:node`:

```
reconcileControlCohort: address book warmed (siblings=1, merged=1, restamped=0, skipped=0, failed=0)
reconcileControlCohort: dialing sibling 12D3KooWC7P9JBbYQjcRWVn6uPqftkin589wg1o9c2tawmpk9Zc2 (2 addr(s))
reconcileControlCohort: dial of sibling 12D3KooWC7P9… failed (continuing):
  InvalidParametersError: Multiaddrs must all have the same peer id or have no peer id
reconcileControlCohort: pass complete (siblings=1, selected=1, dialed=0)
```

The sibling is skipped, every pass, forever, and the only evidence is a debug line. The pass
reports `dialed=0` and moves on.

**How reachable is this outside the test?** The shipped `cadre-host` path is safe, but by luck
rather than by contract: `buildInviteAddresses` (`cadre-host/src/nat/address-resolver.ts`) appends
`/p2p/<peerId>` to every address it returns. Nothing enforces that anywhere else. Both
`setInviteAddresses` (the admin API `PUT /admin/invite-addresses`) and
`network.inviteAddressResolver` accept arbitrary strings, and `collectSelfAddrs`
(`cadre-node.ts`) merges whatever comes back with the relay address from `getMultiaddrs()`, which
always carries the suffix. **One unsuffixed entry from either hook poisons that node's record for
every sibling in the party.**

The same address shape is meanwhile handled three different ways in three places:
`groupAddrsByPeerId` (`peer-addr-book.ts`) **drops** unsuffixed addresses, `mergePeerAddrs`
**accepts** them, and `dialControlSibling` **throws** on them. That spread is the real finding —
each site invented its own rule because no seam ever established one.

## The fix, highest rung first

**Normalize at the seam (representation).** `resolvePeerAddrs` (`cadre-node.ts:1947`) is the one
place every control-network dial path gets its candidates from. If it guarantees that every
address it returns carries the target's `/p2p/<peerId>` suffix, the mixed list stops being
representable downstream and arm 3 disappears at the class level rather than at one call site.
`trailingPeerId` (`peer-record.ts:133`) is already the helper for reading the trailing peer id, and
libp2p itself does exactly this normalization in `calculateMultiaddrs`
(`dial-queue.js:319-333`) — so this makes our list match what libp2p would have built anyway.
Signature verification runs against the original on-record order and is unaffected; normalization
belongs after it, alongside the existing `parseMultiaddrs` step.

**Then arms 1 and 2**, both inside `dialWake`, with `dialOneSibling` getting the same reporting
treatment.

### Trap — do not "simplify" the candidate loop into one array dial

`dialProtocol` accepts a `Multiaddr[]`, and collapsing the loop into one call looks like the
obvious cleanup. It would silently invert this repo's signaling-first ordering. libp2p sorts any
multi-address dial with `defaultAddressSorter`
(`libp2p/dist/src/connection-manager/address-sorter.js`), whose last two passes are
`circuitRelayAddressesLast` and `loopbackAddressLast` — so a relay address is demoted twice over
and the unreachable direct address is dialed *first*. The per-dial API has no sorter override;
`addressSorter` is connection-manager init only. Keep the explicit loop, or change the sorter
globally and say so.

## What this does NOT claim

**It does not claim the reported intermittent failure is fixed.** It was not reproduced. Four
attempts, all green: the scenario file whole twice (2 051 ms and 14 397 ms for this case), the case
alone via `-t "circuit-relay"` (2 422 ms), and the case with a forced 20 s delay before `pushWake`
to guarantee a reconcile pass overlaps it (22 458 ms). The rate comparison the source ticket asked
for — several full-suite runs at `d3c7c2a` and at HEAD — is **not agent-runnable**: one integration
run is ~969 s, so a meaningful sample is hours. That comparison needs a human or CI.

The leading unproven hypothesis, recorded so the next person does not re-derive it: libp2p's dial
queue **joins** an in-flight dial for the same peer id (`dial-queue.js:97-120`), and the peer id it
extracts from a circuit address is the *destination*, not the relay (`getPeerAddress` uses
`findLast`). Any other component dialing Rx by peer id — the Optimystic cluster/repo clients, FRET,
which is the whole reason `mergePeerAddrs` exists — creates a job whose candidates come from the
**peer store** (which by then holds the blackholing direct address, confirmed by `merged=1` in the
log above) and are re-sorted with circuit-last. A wake dial arriving during that job joins it,
inherits the stall, and then reports its *own* address. That matches the fingerprint exactly but is
not proven. `DEBUG=libp2p:connection-manager*` on a failing whole-suite run would confirm or kill
it.

Arm 1 is what makes the next occurrence self-explaining: once every candidate's failure is carried
into the thrown error, a recurrence names the address that actually failed, and *that* is the point
at which a follow-up ticket can be filed against a real site. Do not file one before then — there
is no site to name yet.

Per the source ticket's own reasoning, this is deliberately **not** folded into
`tickets/.pre-existing-known.md`; that decision still stands.

## TODO

- Normalize `resolvePeerAddrs` output so every returned multiaddr carries the target peer's
  `/p2p/<peerId>` suffix; append it where absent, leave already-suffixed addresses untouched, and
  keep the existing drop-on-unparsable behaviour. Reuse `trailingPeerId` rather than adding a
  fourth peer-id-reading rule.
- Add unit coverage for the normalization: an unsuffixed direct addr gains the suffix, a circuit
  addr ending in `/p2p/<target>` is unchanged, a relay-hop addr ending in `/p2p/<relay>/p2p-circuit`
  gains `/p2p/<target>`, and the signaling-first ordering survives.
- Add a regression test that a sibling whose record mixes suffixed and unsuffixed addresses is
  actually dialed by the reconcile pass — the assertion being `dialed=1`, not merely "no throw".
  `cadre-node-control-cohort.spec.ts` is the existing home.
- Make `dialWake` carry every candidate's failure into the error it throws (an `AggregateError`, or
  one message naming each candidate and its cause). A single-candidate failure should still read as
  it does today.
- Give `dialWake` one budget for the whole call instead of one per candidate, following
  `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS`'s reasoning in `control-cohort.ts:43-64`. State the
  chosen number and why in a doc comment, as that constant does.
- Add a deterministic unit test in `strand-wake-protocol.spec.ts`: two candidates, the first
  failing, and assert the thrown error names **both** — this is the exact misdirection that
  produced the source ticket.
- Apply the same error-carrying treatment to `dialOneSibling`
  (`strand-addr-protocol.ts:352-380`) so a total dial failure is distinguishable from "the peer
  returned no addresses". Keep the best-effort `[]` return; the caller contract does not change.
- Do NOT collapse the candidate loop into a single `dialProtocol(addrs)` call — see the trap above.
- Keep `syntheticDirect` in the push-wake scenario. It is the only coverage of the fall-through
  path. Extend the scenario to assert the resolved list is uniformly suffixed, so arm 3's
  normalization is pinned end-to-end.
- Establish the `/p2p/` suffix expectation at the point addresses enter the system, not only where
  they leave it: `setInviteAddresses` and `network.inviteAddressResolver` currently take arbitrary
  strings. Either normalize on the way in or document the requirement on both, and say which was
  chosen.
- Run `yarn workspace @serfab/cadre-core test` and
  `yarn workspace @serfab/integration-tests test src/scenarios/push-wake-e2e.integration.ts`, plus
  `yarn lint` and `yarn typecheck`. Note in the handoff that the whole-suite intermittent is
  unproven either way — a green push-wake file is not evidence it is gone.
