description: A node now remembers a relay that refuses its "let this workspace's identity in" request (a public relay such as relay.sereus.org always does) and stops sending that request when starting or joining a shared workspace, saving a round trip per start (GitHub #49, second point).
architecture: docs/strands.md#relay-willingness
files: packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/delegate-admission.spec.ts, docs/strands.md, docs/architecture.md
----

# Remember which relays refuse the strand-addr protocol — review handoff

## What changed

**Background.** Before a strand node starts, its control node sends a *delegate announcement* (a strand-addr request, `/sereus/strand-addr/1.0.0`, carrying the strand node's peer id) to every circuit relay it uses, so a party-run relay's membership gate will admit that peer id. A dedicated relay (`ops/docker/libp2p-infra`, relay.sereus.org) has no gate and does not serve the protocol; its negotiation always fails with libp2p's `UnsupportedProtocolError`. Before this change that refusal looked like `unreachable`, cost two negotiations (peer id, then address fallback), and was repeated on every strand founding, attach, resume and wake.

**`strand-addr-protocol.ts`.** New outcome `'unsupported'` in `StrandAddrOutcome`. `dialOneSibling` matches the error by `name === 'UnsupportedProtocolError'` and returns `unsupported` at once, without trying the remaining targets (they reach the same responder). Every other failure still falls through to the next target. `siblingAnswered` is unchanged, so a sibling that refuses (older build) still gets the retry interval.

**`delegate-admission.ts`.** Two pure helpers beside `dueRelayAnnounces`:
- `recordRelayRefusals(refusing, relayPeerIds, outcomes)`: `unsupported` adds; `answered` / `empty` / `unavailable` remove; `unreachable` or absent leaves the entry as it was. Reads only the given relay ids, so a sibling asked in the same pass is never recorded.
- `relaysNotRefusing(relays, refusing)`: the filter.

**`cadre-node.ts`.**
- New `relaysRefusingStrandAddr: Set<string>` beside `delegateAnnounceAt`, cleared in `cleanup()`. Its doc comment explains what it holds, why a refusal means "dedicated relay", and why the re-drive hook ignores it.
- `recordDelegateAnnounces` now takes the pass's `outcomes` and records both the throttle timestamps and the refusals. It is the one helper all three announce sites (`resolveSiblingSeed`, `announceDelegateToDueRelays`, `announceDelegateToRelay`) go through.
- `circuitRelayTargets()` now filters out remembered relays. Its only callers are `resolveSiblingSeed` (founding/resume/wake) and `refreshDelegateGrants` (periodic), both announcement paths.
- `announceDelegateToRelay` (the reservation supervisor's `beforeRedrive` hook) does **not** consult the set and still asks every relay. A party-run relay registers its strand-addr handler late in its own `start()`, so it can refuse during bring-up; the hook's next reply clears the entry. Worst case for that relay: one lost reservation attempt and recovery on the first re-drive (2 s backoff).
- `resolveSiblingSeed` was restructured to early-return when it has no targets, so it can read `outcomes`.
- Doc comments that described the dedicated-relay result as "`unreachable` — harmless" are updated (`resolveCohortSeed`, `recordDelegateAnnounces`, `announceDelegateToRelay`).

**Docs.** `docs/strands.md` → "Relay willingness": one sub-bullet. `docs/architecture.md`: the re-drive paragraph now says `unsupported` and points to the skip. The strand-addr outcome list there also named a non-existent `refused` outcome; it now lists `unsupported`.

## Tests added

- `strand-addr-protocol.spec.ts` → `collectStrandAddrs` → "reports a refused protocol negotiation as unsupported without trying the address fallback": the ticket's reproduction inverted. A `dialProtocol` that throws `UnsupportedProtocolError` for a relay target with an address fallback reports `unsupported` and is dialed once.
- `delegate-admission.spec.ts` → `recordRelayRefusals`: a refusal is remembered, a sibling's refusal is not, `unreachable` leaves the entry, each reply status (`answered`, `empty`, `unavailable`) clears it, and `relaysNotRefusing` drops the remembered relay.

No `CadreNode`-level test: the wiring is three call sites through one helper. No test checks that the re-drive hook keeps asking remembered relays. That rule lives only in the doc comment and in the hook not calling `circuitRelayTargets()`.

## Validation run

- `yarn workspace @serfab/cadre-core typecheck`: clean.
- `yarn workspace @serfab/cadre-core test`: 177 files, 2478 passed, 1 skipped.
- `yarn lint`: clean.
- **Trace check (done).** Built cadre-core's dist, then ran
  `REATTACH_SYNC_MEASURE=1 REATTACH_ARMS=reattach-kept REATTACH_DELAY_MS=0 DEBUG='sereus:cadre:strand-addr' yarn workspace @serfab/integration-tests exec vitest run strand-reattach-first-sync-measure`
  (about 22 s). This scenario has a dedicated loopback relay, and party B attaches the same strand twice on one `CadreNode` (attach, `stopStrand`, attach). The log shows `Strand-addr refused by <relay> via <relay>` once for A's founding and once for B's first attach, each with a single target and no address fallback. B's second attach logs no strand-addr dial to the relay. The scenario passed. Log: `tickets/.logs/strand-addr-asks-relays-that-do-not-serve-it.trace.log`. It has no "before" baseline, because the old build was not run.

## Known gaps for the reviewer

- **The first start still pays one negotiation per node process.** The set is in memory only and is cleared on stop. A phone that cold-starts the app pays the refusal once per launch (now one negotiation, not two). Persisting the set would remove that cost, but a remembered party-run relay would then outlive a relay upgrade. Not done; the ticket did not ask for it.
- **A party-run relay caught mid-start is skipped by later foundings until a re-drive clears it.** Every strand founded in that window loses its first reservation attempt through that relay and recovers on the 2 s re-drive. This is the accepted cost described in the set's doc comment. No scenario covers it; `debt-strand-relay-redrive-on-party-run-relay-unscenarioed` (backlog) already names the same bring-up window.
- The periodic refresh (`refreshDelegateGrants`) skips a remembered relay entirely. For a dedicated relay that changes nothing (it needs no grant). For a party-run relay wrongly remembered while holding a live reservation, the refresh would not renew its grant. The grant only matters when the reservation re-dials, and that goes through the re-drive hook, which asks and clears the entry.
- `docs/architecture.md`'s outcome list said `refused` before this change. That outcome never existed in code; this change corrects it.
