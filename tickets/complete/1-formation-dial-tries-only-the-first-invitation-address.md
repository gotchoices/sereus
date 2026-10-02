description: A joiner's formation used to dial only the first address in the invitation, so one dead relay failed the join even when the inviter was reachable another way. It now tries every address, and the review corrected how the docs describe the order and the timing.
architecture: docs/architecture.md#strand-formation
files: packages/cadre-core/src/strand-formation-protocol.ts (FormationDialOptions.responderAddrs doc, openFormationStream, parseResponderAddrs, describeAllAddressesFailed, dialFormation), packages/cadre-core/test/strand-solicitation.spec.ts (describe "StrandFormationManager transport: real disclosure + result validation"), docs/architecture.md (Strand Formation, paragraph after the timeouts paragraph), .release-notes.pending.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md
----
# Formation dial tries every invitation address

Found while analysing gotchoices/sereus#25. `CadreNode.createOpenInvitation` puts every address the inviting node has into `invitation.bootstrap`, but `dialFormation` dialed only `responderAddrs[0]`, so a dead first relay failed the join.

## What landed (`ticket(implement): formation-dial-tries-only-the-first-invitation-address`)

- `dialFormation` parses every `responderAddrs` entry (`parseResponderAddrs`). An entry that does not parse is skipped and logged. The function throws `'No responder addresses available for formation'` only when no entry parses.
- `openFormationStream` passes the whole list to one `node.dialProtocol` call. libp2p sorts the list and tries the addresses one after another under the one `dialMs` signal from `withDeadline`, so the deadline ladder (`formationDeadlines`) is unchanged.
- When every address fails, libp2p throws `AggregateError`. `describeAllAddressesFailed` rethrows it as one error that names each address's own failure, with the `AggregateError` as `cause`.
- Test: `'forms through a later bootstrap address when the first is unreachable'` (real libp2p over TCP, a refused `127.0.0.1:1` address listed first). It reproduces the bug and failed at the previous HEAD.

## Review findings

**Checked:** the implement diff, read before the handoff; libp2p 3.1.3's `DialQueue.dialPeer`, `calculateMultiaddrs` and `defaultAddressSorter` in `node_modules/libp2p`; the repo's own multi-address helper `peer-dial.ts` (`tryAddrsInTurn`, `dialPeerAddrs`) and how `strand-wake-protocol.ts` uses it; the only caller (`strand-formation-manager.ts:311`, which passes `invitation.bootstrap`); the docs paragraph, the release note and the blocked ticket `adopt-optimystic-address-dial-timeout`.

**Fixed in this pass:**
- *Address order was described wrongly.* The option doc, the architecture paragraph and the handoff all said libp2p tries "direct before circuit". `defaultAddressSorter` chains stable sorts, and the last sort wins. So the real priority is loopback last, then public before private, and only then circuit after direct. A circuit address through a public relay is therefore tried before a private LAN direct address. That ordering is what makes the common case work: a cadre-host behind NAT that lists its LAN address and a relay address. The `FormationDialOptions.responderAddrs` doc and `docs/architecture.md` now state the actual order.
- *The cost of a hung address was stated only for libp2p 3.1.3.* The implementer's `NOTE:`, the architecture paragraph and the release note all said a hung address spends the whole dial budget. That is true on the lockfile's libp2p 3.1.3. Embedders who install from npm get libp2p 3.3.x, and 3.3.x cuts each address off at `addressDialTimeout` (6 s by default). The release note is written for those embedders, so it was wrong for its readers. All three now name both cases.
- *Interaction with the pending libp2p 3.3 adoption.* Optimystic's upcoming `addressDialTimeout = max(6000, 5L)` (L is the declared link round trip) is 17.5 s at the default declaration. `dialMs` is 19.5 s, so after a hung first address the next address gets about 2 s, which is too short for a relayed dial. I added this as a TODO item on `blocked/adopt-optimystic-address-dial-timeout`, where the decision about libp2p 3.3 is already waiting, rather than filing a new ticket.

**Considered and kept as implemented:**
- *Using the shared `tryAddrsInTurn` (`peer-dial.ts`) instead of libp2p's multi-address dial.* That module documents libp2p's multi-address dial as the approach to avoid, so this needed a decision. I kept libp2p's dial. The helper's advantage is a time limit per address, and formation cannot use that without making `dialMs` larger than one relayed dial, which changes the session ladder. That decision belongs to the blocked item above. Without per-address limits, the helper would only add `directBeforeRelayed`, which keeps the caller's order. Because `getMultiaddrs()` returns libp2p's raw address order, that would put a host's unroutable LAN address ahead of its public relay circuit, which is worse than libp2p's public-before-private sort. Once per-address limits are adopted, libp2p 3.3's own `addressDialTimeout` also applies to this single-call dial, which `tryAddrsInTurn` would not use.
- *Mixed peer ids.* A list that mixes peer ids is refused by libp2p (`'Multiaddrs must all have the same peer id…'`). This adds no attack surface: whoever writes the invitation already chooses which peer gets dialed.
- *`AggregateError` on React Native (Hermes).* Hermes has `AggregateError` (it shipped with `Promise.any`), and libp2p itself constructs it on that path. Not an issue.
- *Late-stream cleanup.* The callback is now `async`, and the `void pending.then(...)` handler that resets a stream arriving after the deadline is still attached before the await. Correct.

**Tests:** I kept the one new real-libp2p test. It reproduces the defect, and its addresses are all loopback, so the sorter keeps the dead address first and the test does exercise the fallback. I added no test for the error restatement because it is message formatting. I cut nothing: the mock-node `dialFormation` tests were not changed by this ticket.

**Tripwire:** a hung address still costs the whole budget on libp2p 3.1.3, or one `addressDialTimeout` on 3.3+. This is recorded in the updated `NOTE:` at `openFormationStream` and as the TODO item on the blocked ticket.

**Validation:**
- `yarn workspace @serfab/cadre-core test`: 147 files, 2344 passed, 1 skipped (the skip was already there).
- `yarn lint`: clean.
- `npx tsc --noEmit` in `packages/cadre-core` fails, but not because of this ticket. The errors are in `cadre-node.ts` and `strand-instance-manager.ts`: `@libp2p/interface` types from `../optimystic/packages/db-p2p/node_modules` (version 3.3.0) do not match sereus's copy. `../optimystic` has uncommitted `package.json` edits in all its packages right now, which looks like its move to libp2p 3.3. The implementer's type check passed on the same sereus code about 10 minutes earlier. That repository is read-only for this project and mid-edit, so I did not file this as a sereus defect. It is the type split the blocked ticket predicts, and it will need attention once optimystic commits or releases that change.
