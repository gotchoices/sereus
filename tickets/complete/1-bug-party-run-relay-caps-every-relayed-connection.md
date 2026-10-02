description: When one of a party's own machines relays traffic for a machine that cannot be reached directly, it used to cut every relayed connection off after 128 KB or two minutes, so database syncs and chat histories sent that way died partway through. Party-run relays now forward without that cap, as the dedicated relay already did, and the setting is configurable and logged at start.
files: packages/cadre-core/src/relay-server.ts (new), packages/cadre-core/src/types.ts (NetworkConfig.relayServerInit), packages/cadre-core/src/cadre-node.ts (relayServer field, constructor, buildControlNodeOptions, logRelayServerSettings, admitInboundControlConnection), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime), packages/cadre-core/src/membership-connection-gater.ts (UnauthorizedReservationBudget, MAX_UNAUTHORIZED_RELAY_RESERVATIONS comment), packages/cadre-core/src/index.ts, packages/cadre-core/test/relay-server.spec.ts (new), packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-cluster-size.spec.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts (comment only), docs/architecture.md
repro: static
----

Field report: gotchoices/sereus#19. Phones that reached their cohort through a party-run relay logged 320 `TransferLimitError`s in one run, which showed up as missing blocks and stalled catch-up.

## What was wrong

`@libp2p/circuit-relay-v2` defaults its server to `reservations.applyDefaultLimit: true`, which puts `Limit { data: 128 KiB, duration: 2 min }` on every reservation. libp2p marks each connection relayed under it "limited" and resets it at either limit. db-p2p's database protocols also refuse a limited connection outright. The dedicated relays (`ops/docker/libp2p-infra`, `startDedicatedRelay`) already turned the limit off. cadre-core never passed `relayServerInit`, so every party-run relay (any `CadreNode` with its relay server on, which by default means every storage-profile machine) got libp2p's cap and libp2p's 15-slot reservation store.

## What changed

- **`relay-server.ts` (new): `resolveRelayServer(network, profile)`** returns `{ enabled, init }`. Both node builders call it: `CadreNode` resolves it once in the constructor into a `relayServer` field, and `buildStrandRuntime` calls it per build. That replaces `CadreNode.relayServerEnabled()` and the strand side's hand copy of the same expression.
  - `enabled`: `network.enableRelay ?? profile === 'storage'` (unchanged rule).
  - `init`: the party-run defaults `reservations: { applyDefaultLimit: false, maxReservations: 128, reservationTtl: 2 h }`, with `network.relayServerInit` merged over them. `reservations` is merged key by key and other top-level keys are taken as given. A key set to `undefined` counts as unset.
  - Constants `PARTY_RELAY_MAX_RESERVATIONS` (128, with the sizing arithmetic in its doc comment) and `PARTY_RELAY_RESERVATION_TTL_MS` are exported from `index.ts` along with the resolver and its types.
- **`NetworkConfig.relayServerInit?: CircuitRelayServerInit`**, documented in `types.ts` (defaults, merge semantics, the unplaced-peer tradeoff, reaches control + every strand node) and in the `docs/architecture.md` NetworkConfig block. Not mapped into cadre-cli's `cadre.yaml` or environment variables, which the ticket left out of scope.
- **Both builders pass `relayServerInit` only when the server is enabled.**
- **Unauthorized-reservation budget TTL comes from the resolved init.** `UNAUTHORIZED_RESERVATION_TTL_MS` and its "mirror, not a live coupling" NOTE are gone, and so is its public export. `UnauthorizedReservationBudget`'s default TTL is now `PARTY_RELAY_RESERVATION_TTL_MS`, and `CadreNode` passes `relayServer.init.reservations.reservationTtl`. `budget.cap` is now public readonly so the start log can print it.
- **Start log:** `CadreNode.start()` makes one `sereus:cadre:node` debug line when the server is on: `Relay server on: applyDefaultLimit=… maxReservations=… reservationTtl=…ms unauthorizedCap=…`. There is no line per strand.
- **Docs:** `docs/architecture.md` has the NetworkConfig entry, a sentence in the connection-gate bullet ("relay-reservation seam": a granted slot is uncapped, so an unplaced peer is bounded by count and 2 h lifetime), and a paragraph after the ops-container relay paragraph. `membership-connection-gater.ts`'s seam doc and the `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` NOTE are updated to the new store default.

### Deviations from the ticket's design (for the reviewer to accept or push back on)

- **No separate `reservationTtlMs` field.** Cadre now sets `reservationTtl` explicitly in its defaults, so `init.reservations.reservationTtl` is always defined, and the resolved-init type (`ResolvedRelayReservations`) makes the three defaulted keys required. That removes the need to mirror libp2p's unexported `DEFAULT_MAX_RESERVATION_TTL`. The cost is that cadre pins 2 h and will not follow libp2p if libp2p changes its default. That is deliberate: the budget has to agree with the server, and now cadre owns both values.
- **`relayServerEnabled()` became a field resolved in the constructor.** This assumes `config.network` and `config.profile` are not mutated after construction. Nothing in the repo does that (checked with grep).

## Tests added

- `packages/cadre-core/test/relay-server.spec.ts`: one table-driven case over the merge. The rows are: no override (limit off, 128, 2 h); only `maxReservations` (limit stays off); `applyDefaultLimit: true` (cap back on); `reservationTtl` reaches the resolved TTL; an `undefined` key counts as unset; other top-level keys pass through.
- `cadre-node-control-node-options.spec.ts` → `describe('relay')`: a storage-profile node's options carry `relayServerInit.reservations.applyDefaultLimit === false`, and a relay-disabled node's options have no `relayServerInit`. This fails before the fix.
- `strand-instance-manager-cluster-size.spec.ts`: the strand node gets `relay: true` and an init with `applyDefaultLimit: false` plus the caller's `maxReservations: 20` merged in. This fails before the fix.
- `relay-only-control-addr.integration.ts` case 1, wire check: after link 4, B dials C's circuit address through A with `{ force: true }` and asserts `conn.limits` is `undefined`. **I checked that it bites:** with `applyDefaultLimit` flipped to `true` in the built `dist/relay-server.js`, it fails with `relayed connection B→C through party-run relay A is flagged limited: expected { bytes: 130413n, seconds: 120000 } to be undefined`. `force` is required. Without it, B's `dial` hands back the direct connection C opened to B after reading B's row, because libp2p skips a limited connection when it returns an existing one. An earlier draft without `force` therefore passed against a capped relay, and passing with the fix depended on which connection existed first. The comment at the site explains this.

## Validation run

- `yarn workspace @serfab/cadre-core build`, then `typecheck`: clean.
- `yarn workspace @serfab/cadre-core test`: 144 files, 2335 passed, 1 skipped.
- `yarn workspace @serfab/integration-tests typecheck`: clean.
- `yarn lint`: clean. It took about 9 minutes on this machine, which was under load.
- `relay-only-control-addr` (5/5) and `blind-relay-phone-to-phone-e2e` (2/2), both in the foreground against the rebuilt dist.

## Known gaps / things to look at

- **The field setup was not rerun** (two Android emulators + two Node peers). The wire check proves libp2p honours the init on a loopback party, which is the mechanism behind the report, but not the reporter's exact topology.
- **Unauthorized cap vs. store size is still checked by hand.** An embedder who sets `relayServerInit.reservations.maxReservations` at or below `unauthorizedRelayReservationCap` (default 8) gets no warning, and unplaceable peers could then fill the store. The NOTE on `MAX_UNAUTHORIZED_RELAY_RESERVATIONS` says this. A start-time warning in `logRelayServerSettings` would be cheap if the reviewer wants one.
- **Strand nodes' relay servers also get the 128-slot store.** Strand nodes reserve on the control node's relay addresses (`strand-network-config.ts`), so a strand node's own server rarely holds reservations. A larger limit on an idle store costs nothing, and the ticket asked for one init for both.
- **The start log line is not tested** (logging only).
- **Human step after release:** reply on gotchoices/sereus#19. The maintainer approves the post; the implementer does not post it. Carry this forward into the complete/ ticket.

## Review findings

Reviewed the diff of `ticket(implement): bug-party-run-relay-caps-every-relayed-connection` before reading the handoff, then checked it against libp2p 4.1.3's server reservation store (`node_modules/@libp2p/circuit-relay-v2/dist/src/server/reservation-store.js`) and the fix-stage policy.

- **Correctness of the fix:** confirmed. `resolveRelayServer` merges `reservations` key by key and drops `undefined` keys. Both build sites pass `relayServerInit` only when the server is on. The unauthorized budget takes its TTL from the resolved init, so the hand-kept mirror is gone. The wire check in `relay-only-control-addr` fails against a capped relay (the implementer ran that check), so it tests the mechanism behind #19.
- **Deviations from the design:** both accepted. Pinning `reservationTtl` to 2 h in cadre's defaults is better than mirroring a libp2p constant that cadre cannot import. Resolving the server once in the constructor is safe because nothing mutates `config.network` or `config.profile` after construction.
- **Docs overstated the bounds on an unplaced peer (minor, fixed).** `types.ts` and `docs/architecture.md` said an unplaced peer was bounded by count *and* the 2 h reservation lifetime. libp2p's `reserve()` resets the timer on every refresh, so a holder that keeps refreshing keeps its slot indefinitely. The lifetime only reclaims abandoned slots. Both texts were reworded to say this.
- **Strand nodes' relay servers have no count budget (tripwire).** Only the control node runs the membership gater's unauthorized-reservation budget. An open strand node's relay server admits any peer that can reach it, up to `maxReservations` (128), and now forwards uncapped. This follows the maintainer's "one init for both" policy, and a strand peer's `/p2p-circuit` search listener can reserve there, so the cap has to be lifted there too. The `types.ts` tradeoff text now says so. A `NOTE:` at the strand build site in `strand-instance-manager.ts` gives the revisit condition (bandwidth abuse through strand relays). No ticket, because this is conditional.
- **Test comment fixed (minor).** The strand spec claimed a NAT'd member's strand traffic crosses a party-run relay "just as its control traffic does". That traffic actually lands on the relay machine's *control* node (strand nodes are given the control node's `relayAddrs`). The comment now names the real reason: strand peers reserve on the strand node's own server.
- **Stale reference (minor, fixed).** `backlog/bug-party-run-relay-drops-a-stranger-dialing-through-it` named the removed `relayServerEnabled`. It now points at `resolveRelayServer` in `relay-server.ts`. No other open ticket, doc or source file refers to the removed symbols.
- **Unauthorized cap vs. store size:** left as the implementer's existing `NOTE:` on `MAX_UNAUTHORIZED_RELAY_RESERVATIONS`. The concern only applies if an embedder shrinks the store to about 8, and no embedder does that today. No start-time warning added.
- **Tests:** kept all four. The control-node and strand cases both fail before the fix. The resolver table pins a merge with real branching. The wire check is the only proof that libp2p honours the init. Nothing cut: none of them restates a constant or verifies a mock. The `reservationTtl` row is close to the `maxReservations` row, but it costs one table row.
- **Type safety / hygiene:** no `any`. `definedEntries` does one checked cast. The new `relay-server.ts` is 98 lines, with comments that give reasons rather than restating code. The start log is a single debug line and is untested, which is fine for logging.
- **Resource cleanup / error handling:** no new resources or error paths. The resolver is pure.
- **Not covered:** the reporter's field setup (two Android emulators + two Node peers) was not rerun. The integration scenarios were not rerun in this pass either: every change in this pass is a comment or doc edit, and the implementer ran `relay-only-control-addr` (5/5) and `blind-relay-phone-to-phone-e2e` (2/2) against the same code.

Validation in this pass: `yarn workspace @serfab/cadre-core build` and `typecheck` both clean. `yarn workspace @serfab/cadre-core test`: 144 files, 2335 passed, 1 skipped. `eslint` on every touched source and test file: clean. The full `yarn lint` was not rerun because it takes about 9 minutes and the only new edits are comments.

## Human follow-up

- After release, reply on gotchoices/sereus#19. The maintainer approves the post; agents do not post it.
