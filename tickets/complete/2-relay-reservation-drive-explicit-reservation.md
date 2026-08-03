description: A browser tab pointed at a relay server never became reachable through it, because the tab waited for the relay to introduce itself in a dialect the relay does not speak. It now asks the relay for a slot directly, and reports a real reason when that fails.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/cadre-core/src/cadre-node.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/README.md, docs/architecture.md, docs/STATUS.md
----

# Complete: reserve on the relay explicitly instead of waiting for libp2p relay discovery

## What shipped

`driveRelayReservation` (`packages/cadre-core/src/relay-reservation.ts`) used to
dial the relay and then *wait* for `@libp2p/circuit-relay-v2`'s relay-discovery
machinery to notice it and reserve. Discovery nominates a peer only once the
relay-hop protocol id shows up in that peer's peer-store protocol list, and that
list is written exclusively by the **identify** handshake — which never completes
here, because cadre nodes speak a per-party identify protocol id
(`/optimystic/control-<partyId>/id/1.0.0`, from `@optimystic/db-p2p`) while the
relay `ops/docker/libp2p-infra` deploys speaks stock `/ipfs/id/1.0.0`. The
connection is fine; nobody ever asked for a reservation; the symptom read as a
timeout.

The drive now asks for the slot itself:

```
driveRelayReservation(node, addrs, {timeoutMs, pollMs})
  └─ dialRelays          → { connected: [{addr, peerId}], error }   (concurrent, deadline-bound)
  └─ requestReservation  → { error, fatal }                          (sequential, list order)
       └─ findCircuitRelayTransport(node)  →  reservationStore | null
       └─ requestOneReservation → store.addRelay(peerId, 'discovered'), deadline-raced
  └─ waitForCircuitReservation                                       (unchanged poll)
```

Failure strings name the cause instead of the clock: missing bare `/p2p-circuit`
listen address, missing `circuitRelayTransport()` (reported at once — nothing can
ever land), peer that is not a relay, dial failure, or the timeout.

Acceptance gate: `test/relay-reservation.spec.ts` → `CadreNode relay reservation
against a live relay` → "reserves through the control node and clears the posture
on stop". That relay runs **stock `identify()`**, so libp2p's discovery provably
cannot nominate it; the spec passing is the proof that the reservation is
requested explicitly. If it regresses to a timeout, the driver went back to
waiting on discovery.

## Review findings

### Verified against libp2p's own source, not just the handoff

Every load-bearing claim in the implement handoff was re-derived from
`node_modules/@libp2p/circuit-relay-v2/dist/src/transport/`, because the whole
change rests on internals:

- **`'discovered'` not `'configured'`** — confirmed. `listener.js` `_onAddRelayPeer`
  returns early unless `details.id === this.reservationId`, and a `configured`
  reservation record carries no `id` at all (`reservation-store.js` only assigns
  one on the `'discovered'` branch). A `configured` reservation would succeed and
  never publish the listen address. Claim holds.
- **One pending reservation per bare `/p2p-circuit` listener** — confirmed.
  `listener.js listen()` calls `reserveRelay()` exactly once for the search shape,
  and `addRelay(_, 'discovered')` throws `HadEnoughRelaysError` when
  `pendingReservations` is empty. Sequential-and-stop-at-first-success is correct.
- **`HadEnoughRelaysError` / `UnsupportedProtocolError` names** — confirmed as
  literal `name` fields on the error classes, so the `switch` in
  `describeReservationFailure` matches for real and is not string-guessing.
- **`addRelay` takes no abort signal** — confirmed; it builds its own
  `AbortSignal.timeout(reservationCompletionTimeout)`. The deadline race is
  necessary, and `Promise.race` does leave the abandoned promise handled.
- **The transport seam** — `CircuitRelayTransport` does expose `reservationStore`
  as a public field, and `findCircuitRelayTransport` fails soft to `null`. The
  duck-type on `{addRelay, hasReservation}` is the only structural risk and no
  other transport in the tree exposes both.

### Major — one, filed

- **A lost reservation is never re-established.** `tickets/backlog/bug-relay-reservation-not-redriven-after-loss`.
  On connection close libp2p returns the freed slot to `pendingReservations`,
  emits `relay:not-enough-relays`, and hands recovery to **relay discovery** —
  the exact path this ticket just proved cannot work for a cadre node against a
  stock-identify relay. Nothing re-runs `driveRelayReservation`. So a relay
  restart or a network blip leaves a browser tab permanently undialable until the
  page is reloaded. This is not a regression from this diff (before it, no
  reservation landed at all) but it is newly *reachable* now that the first
  reservation succeeds, and it directly contradicts what two docstrings promised.
  Chain traced through `reservation-store.js` → `transport/index.js` →
  `discovery.js`; `repro: static`, with the confirming spec spelled out in the
  ticket (fixed-key, fixed-port relay that can be stopped and restarted).

### Minor — three, fixed in this pass

- **Two docstrings claimed a self-heal that cannot happen.**
  `relay-reservation.ts` `resolveRelayReservationState` said "a relay that comes
  back after a failed drive self-heals to `reserved` with no second drive", and
  `cadre-node.ts` `getRelayReservationState` said the same. Reading live makes the
  *status* honest; it does not make the *reservation* return. Both now state that
  the live read is only a precedence rule and that a lost reservation needs a
  fresh drive, pointing at the ticket above.
- **The reservation loop's list-ordering behaviour had no test.** The handoff
  flagged this: only "dead dial + live relay" was covered, which exercises the
  *dial* loop. Added `moves past a connected non-relay to reserve on a real relay
  later in the list` — the first peer connects fine and then rejects the hop
  request, so the reservation loop has to continue and discard that error. Passes;
  spec file now 24/24.
- No third source-hygiene fix was needed — see below.

### Tripwires — one parked

- `packages/cadre-core/src/relay-reservation.ts`, `NOTE:` on
  `describeReservationFailure`: libp2p adds a peer to the reservation store's
  `relayFilter` when a request fails with `DialError` or
  `UnsupportedProtocolError`, and the failure path never resets that filter (only
  an actual reservation *removal* does, via `#checkReservationCount`). A second
  drive against the same relay in the same process therefore reports
  `ListenError: The relay was previously invalid` regardless of whether the relay
  recovered. Harmless today — every caller drives once at startup — but it is a
  direct hazard for the re-drive ticket, so it is also called out in that ticket's
  body.
- The implementer's own tripwire (a rejected reservation still burns the rest of
  the deadline polling) was re-read and left as-is: the reasoning is sound and the
  `NOTE:` is at the right site.

### Checked and clean — nothing found

- **Error handling / resource cleanup.** Both `setTimeout`s are cleared in
  `finally`; `nodeTransports` catches and logs rather than throwing;
  `driveRelayReservation` still cannot throw. No swallowed exception without a log.
- **Type safety.** No `any`. The three `as` casts (`Libp2pComponentsLike`, the
  `reservationStore` probe, the `PromiseSettledResult` element type) are each
  narrow and guarded by a runtime check or by structural compatibility.
- **Error precedence.** `attempt.error ?? dialError ?? timeout` was traced through
  every combination of dead / non-relay / live entries in the addr list; a
  reservation that lands still wins over any earlier error, and a repeat drive
  after success short-circuits on `hasReservation` before any misleading
  `HadEnoughRelaysError` translation can surface.
- **Source hygiene.** `relay-reservation.ts` is 483 lines (`wc -l`), roughly half
  of it the explanatory header and per-function rationale that this module exists
  to carry; every function is short and single-purpose (`dialRelays`,
  `connectedRelays`, `firstDialError`, `requestReservation`,
  `requestOneReservation`, `describeReservationFailure`,
  `waitForCircuitReservation`). No split warranted, no comment block standing in
  for a function.
- **Docs.** Every file the diff touched was re-read, plus a repo-wide grep for the
  stale claims it was meant to remove (`relay discovery`, `search mode`,
  `reserved.*unreachable`, `relay-search-listener-cannot-discover-stock-relay`).
  `docs/architecture.md`, `docs/STATUS.md`, `packages/reference-app-web/README.md`
  and the two source comments all reflect the new reality. The single surviving
  reference to the old fix ticket is in `tickets/complete/` — an archive, left
  alone.
- **Security.** Nothing to report, with a reason: the diff adds no trust boundary,
  parses no untrusted input, and grants no new capability — it asks a relay the
  operator already configured for a forwarding slot, over libp2p's own
  authenticated connection.
- **Performance.** Nothing beyond the already-parked polling tripwire; the drive
  is bounded by one shared deadline and the dials stayed concurrent.

### Gaps deliberately left open

Carried forward from the handoff, re-checked and still accurate:

- **No end-to-end run against the deployed relay.** All of this is loopback libp2p
  inside vitest. "Reservation lands" is proven; "traffic flows" is not, and will
  not be until the relayed-traffic limits work lands.
- **The `requestOneReservation` deadline race is untested.** It needs a relay that
  accepts TCP and then goes silent on the hop stream; nothing stands one up.
- **Strand nodes still have no driver** — `backlog/strand-network-nat-relay-reachability`.
  The function stayed node-agnostic (bare `Libp2p`) so that ticket can reuse it.
- **Reference-app-web was not run in a browser.** Only its comment and README
  changed.

### Pre-existing failures

5 failures in `control-revocation-reissue.spec.ts` and
`control-revocation-replay.spec.ts` (quereus DML/constraint machinery — a `UNIQUE`
error and a `context.OwnerKey isn't a column` error where a `CHECK` failure was
expected). Already listed in `tickets/.pre-existing-known.md` under blocked ticket
`10-revocation-reissue-same-pk-update-unique-collision`. Not re-reported, not
skipped, not touched.

## Validation run

- `packages/cadre-core`: `npx vitest run test/relay-reservation.spec.ts` →
  **24/24 pass** (~25 s), including the spec added in this pass.
- `packages/cadre-core`: `npx tsc -p tsconfig.typecheck.json --noEmit` → clean.
- Root: `npx eslint .` → clean.
- Root: `yarn build` → all workspaces built (only the pre-existing vite
  dynamic/static import chunking warnings from the linked `optimystic`/`Fret`
  workspaces).
- `packages/cadre-core`: full `npx vitest run` → 87 files passed / 2 failed,
  **1437 passed / 5 failed / 1 skipped** — the 5 being the known pre-existing
  revocation failures above.
