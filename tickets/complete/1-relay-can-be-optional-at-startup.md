description: A node that is told to use a forwarding server can now be configured to boot even when that server is unreachable, instead of always refusing to start — what phones and browser tabs need, since they have to start with no network. Servers keep the old refuse-to-start behaviour by default.
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/test/cadre-node-relay-optional.spec.ts, packages/cadre-core/test/cadre-node-relay-boot-failure.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/test/relay-test-addrs.ts, packages/reference-app-web/src/lib/cadre-web.ts, docs/architecture.md
difficulty: easy
----

# `network.relayAddrs` got an optional posture

## What landed

`NetworkConfig.requireRelay?: boolean` (`packages/cadre-core/src/types.ts`), default `true`, read in exactly one place: `CadreNode.driveControlRelayReservation` (`cadre-node.ts`, the last step of `start()`). When the first relay-reservation attempt settles at anything other than `reserved` and `requireRelay === false`, the status is logged and `start()` carries on; the default posture still throws `RelayReservationFailedError` from the same line it always did.

Everything else about the reservation machinery is unchanged at both postures:

- the bare `/p2p-circuit` search listener is still added from `relayAddrs` (`resolveListenAddrs`), so a tolerated start still has somewhere for a later reservation to land;
- `reserveRelays` still starts its retry supervisor on the standard backoff (2 s doubling to 60 s), so a tolerated node becomes dialable on its own when the relay appears;
- a malformed `relayAddrs` entry still throws at config resolution, and a hand-written `<relay>/p2p-circuit` entry in `listenAddrs` is still rejected on the control node;
- strand nodes never read the field — they were already fail-soft over `relayAddrs`;
- `cleanup()` (which both `stop()` and a failed `start()` funnel through) already stopped the supervisor and cleared the posture, so a tolerated-but-unreserved node leaves nothing dialing after `stop()`.

`start()` still WAITS for the first attempt at either posture — up to the drive's 10 s timeout against a relay that hangs rather than refuses. `requireRelay: false` buys a node that boots, not a node that boots fast; that cost is now stated on the field.

The consumer is ticket `phone-becomes-reachable-through-a-relay`, which is what puts the field on a real phone config.

## Review findings

**Checked.** The implement diff read first, before the handoff summary. The field's single read site and the preserved default branch; the validation half (`relayCircuitAddrs`) and the listen-set derivation, both untouched by the posture; supervisor lifecycle across `stop()`, a failed `start()` and a later `reserveRelays()`; what a tolerated node publishes in its own `CadrePeer` row when the reservation lands after boot; the `cadre-cli` config path; every doc and comment in the tree that states the old fail-fast contract; the ticket's own list of edge cases against the tests actually written. Ran `yarn lint` (clean, repo-wide), `yarn workspace @serfab/cadre-core typecheck` (clean) and `yarn workspace @serfab/cadre-core test` (131 files, 2136 passed, 1 skipped — the skip is pre-existing and unrelated).

**Major: none.** The one behavioural question worth chasing resolved itself. A tolerated node publishes its first `CadrePeer` row without a `/p2p-circuit` address, since the reservation has not landed yet — but `startRecordRefresh`'s `self:peer:update` listener is wired ~1 s after `start()` and republishes on exactly the address change a late reservation produces, so the node does not stay unreachable in the directory. The comment at that site claimed a relay-only node's addresses stop changing inside `start()`; that is now only true at the default posture, so it says which case is which.

**Minor, fixed in this pass.**

- *Two of the ticket's own listed interactions had no test.* Added to `cadre-node-relay-optional.spec.ts`: `reserves on its own once the relay it named finally comes up` (a relay started at a pre-reserved port and pre-generated key AFTER the node booted against it; asserts the posture moves `retrying` → `reserved` and the control node gains a `/p2p-circuit` address with nobody calling `reserveRelays`), and `hands the reservation over to a later reserveRelays() call` (the boot supervisor must be replaced, not joined by a second loop over one pending reservation slot). The first is the feature's actual promise and nothing covered it end to end at the `CadreNode` level.
- *`docs/architecture.md` was left self-contradictory.* The prose under "Why `relayAddrs` no longer builds a `<relay>/p2p/<relayPeerId>/p2p-circuit` listen address" still asserted the unconditional two-place fail-fast contract, and the `CadreNodeConfig` reference block further down still said a first attempt that lands nothing "means the node does not come up" and did not list the new field at all. Both corrected; `requireRelay` added to the reference block.
- *`relay-reservation.ts`'s module header* still described exactly two postures (config = fail-fast, `reserveRelays()` = fail-soft). Now names the third.
- *`reference-app-web/src/lib/cadre-web.ts`* gave "`relayAddrs` makes a failed first attempt FATAL to `start()`" as its reason for deliberately not setting `relayAddrs` — the reason this ticket removed — and pointed at `tickets/plan/phone-reachable-for-strand-invitations`, a path that no longer exists. Comment corrected and re-pointed at the live ticket slug. No behaviour change to the web app: whether the tab switches to `relayAddrs` + `requireRelay: false` is its own decision, and the phone takes that route first.
- *The `requireRelay` doc comment* did not say `start()` still waits out the first attempt. It does now, with the cost named.
- *Test duplication.* The new `requireRelay: true` case in `cadre-node-relay-boot-failure.spec.ts` re-declared a whole node-config literal directly below the helper that builds it; the optional spec re-declared it again for the malformed case; `deadRelayAddr` existed in three spec files and `freePort` in two. Both helpers now take the varying part, and the address primitives moved to `packages/cadre-core/test/relay-test-addrs.ts` (`deadRelayAddr`, `blackholeRelayAddr`, `freePort`), imported by `relay-reservation.spec.ts`, `cadre-node-relay-boot-failure.spec.ts` and `cadre-node-relay-optional.spec.ts`.

**Considered and not filed.**

- *Should a tolerated failure be a `console.warn` rather than a `debug` log?* The implementer asked. No: `warnIfAnnounceAddrsDiscardRelay` in `cadre-node.ts` carries an explicit decision that it is the library's only direct `console.*` and that a second one should become a `CadreNodeEvents` entry an embedder surfaces, rather than growing a console surface inside a library. The `debug`-level log is the right call, and an embedder that cares reads `getRelayReservationState()`.
- *The 10 s boot cost on the tolerated posture.* `driveRelayReservation` already carries an accepted-tradeoff `NOTE:` explaining that a rejected reservation still polls to the deadline (discovery may land one independently) and naming the revisit condition — "if startup latency on that path ever matters". That decision stands; documented on the new field rather than re-filed.
- *`cadre-cli` does not expose `requireRelay`.* Deliberate per the ticket — an operator-run node wants fail-fast. Its `network` block is passed through to `CadreNode` unchanged, so a config file naming the field would still take effect while being absent from the CLI's own type; that is the general absence of config-file schema validation, already tracked as `debt-cli-config-file-has-no-schema-validation`.
- *The web tab's strand nodes still publish no circuit address of their own.* Pre-existing, untouched by this ticket, and the route that closes it is `phone-becomes-reachable-through-a-relay`. Parked as the corrected comment at the site instead of a second ticket for the same route.

**Tripwires: none new.** Both conditional concerns found (the boot-latency cost, and discovery versus an explicit drive) already have `NOTE:` comments at their exact sites; adding more would duplicate them.

## Tests

`yarn lint` (clean), `yarn workspace @serfab/cadre-core typecheck` (clean), `yarn workspace @serfab/cadre-core test` — 131 files, 2136 passed, 1 skipped (pre-existing).

Relay coverage now: `cadre-node-relay-boot-failure.spec.ts` (the default posture throws, leaves nothing running, is retryable, and does the same when `requireRelay: true` is explicit), `cadre-node-relay-optional.spec.ts` (tolerated start, `stop()` teardown, malformed entry still fatal, self-recovery once the relay appears, handover to a later `reserveRelays()`), `cadre-node-control-node-options.spec.ts` (the bare search entry survives the posture).

No integration-level coverage: everything here is `cadre-core` unit-level against a real-but-dead TCP port and a real loopback relay. `blind-relay-phone-to-phone-e2e.integration.ts` exercises the reachable case for this node shape and was not re-run; `phone-becomes-reachable-through-a-relay` is the ticket that puts `requireRelay: false` on a real network.
