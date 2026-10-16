description: A node now remembers a relay that refuses its "let this workspace's identity in" request (a public relay such as relay.sereus.org always does) and stops sending that request when starting or joining a shared workspace, saving a round trip per start (GitHub #49, second point).
architecture: docs/strands.md#relay-willingness
files: packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/delegate-admission.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/delegate-admission.spec.ts, docs/strands.md, docs/architecture.md
----

# Remember which relays refuse the strand-addr protocol

## What landed

Implemented in `ticket(implement): strand-addr-asks-relays-that-do-not-serve-it`.

- `strand-addr-protocol.ts`: new outcome `unsupported`. When libp2p reports `UnsupportedProtocolError` (matched by error name), `dialOneSibling` returns `unsupported` at once instead of trying the address fallback, so a dedicated relay costs one negotiation instead of two. A sibling that refuses still gets the one-minute retry, because `siblingAnswered` counts only `answered` / `empty`.
- `delegate-admission.ts`: two pure helpers. `recordRelayRefusals` adds a relay on `unsupported`, removes it on any reply (`answered`, `empty`, `unavailable`), and leaves it unchanged on `unreachable`. `relaysNotRefusing` filters the list.
- `cadre-node.ts`: an in-memory set `relaysRefusingStrandAddr`, cleared in `cleanup()`. All three announce sites update it through `recordDelegateAnnounces`. `circuitRelayTargets()` filters out remembered relays, so the founding/resume/wake pass and the periodic grant refresh skip them. The reservation supervisor's re-drive hook (`announceDelegateToRelay`) still asks every relay, and a reply clears the entry. This covers a party-run relay, which refuses the protocol until it registers its handler late in `start()`. Confirmed: the handler is registered in `CadreNode.start` after `createControlNode()`.
- Docs: `docs/strands.md` (Relay willingness) and `docs/architecture.md` (re-drive paragraph and outcome list).

Trace check by the implementer: in `strand-reattach-first-sync-measure`, the first attach logs one refused negotiation against the loopback dedicated relay, with no address fallback. The second attach on the same node sends no strand-addr request to the relay.

## Review findings

**Checked:**
- The implement diff, read in full: the protocol client, both helpers, all three announce sites, `cleanup()`, the two callers of `circuitRelayTargets()` (`resolveSiblingSeed` and `refreshDelegateGrants`), and the restructured early return in `resolveSiblingSeed`.
- Whether a party-run relay that does not yet count us as a member could be wrongly remembered. It cannot. `control-protocol-guard.ts` wraps the handler returned by `registrar.getHandler`, so the guard resets the stream *after* multistream negotiation succeeds. The asker sees `unreachable`, never `UnsupportedProtocolError`.
- That `unsupported` is handled wherever `StrandAddrOutcome` is consumed: `siblingAnswered` and `recordRelayRefusals` are the only two consumers.
- Tests: the `strand-addr-protocol.spec.ts` case reproduces the bug (one dial, `unsupported`), and the `recordRelayRefusals` case covers a helper with real branching. Both pass this project's test bar and were kept. No test was cut.
- `yarn workspace @serfab/cadre-core typecheck`: clean. `yarn lint`: clean. `yarn workspace @serfab/cadre-core test`: 177 files, 2478 passed, 1 skipped.

**Found and fixed inline:**
- `docs/architecture.md`, sibling refresh paragraph ("Into the strand's address book, and kept warm"): this paragraph still named the non-existent outcome `refused` in the retry list. The implementer had fixed the same mistake in the outcome list but missed this one. It now says `unsupported`.

**Considered, no action (with reason):**
- **Race between concurrent passes.** A founding pass's `unsupported` can be recorded after a concurrent re-drive's reply has cleared the entry. The outcome is the same as the accepted bring-up cost (the relay is skipped until the next re-drive clears it), so no new behaviour arises. No tripwire was added, because the doc comment on the set already describes that cost.
- **Party-run relay that is also a connected sibling.** If such a relay is remembered while it is still starting, later founding passes still ask it as a sibling and pass the delegate peer id, so its grant is delivered. The entry is only cleared by the re-drive hook, because sibling replies are not read as relay replies. The only effect is a stale set entry, with no lost grant. No action.
- **In-memory only.** The set is lost on process restart, so a cold start pays one negotiation per dedicated relay. The implementer listed this as a known gap, and it stays as designed because persisting the set would outlive a relay upgrade. The ticket did not ask for persistence.
- **No `CadreNode`-level test that the re-drive hook ignores the set.** That rule is stated in the set's doc comment and is structural: the hook never calls `circuitRelayTargets()`. The bring-up window is already tracked as unscenarioed by `debt-strand-relay-redrive-on-party-run-relay-unscenarioed` (backlog). Nothing new filed.
- **Error handling, resource cleanup, type safety:** no findings. The set is cleared in `cleanup()`. The new outcome is a closed union member, so a future consumer that switches over the union is checked by the compiler.

**Tickets filed:** none. **Tripwires added:** none.
