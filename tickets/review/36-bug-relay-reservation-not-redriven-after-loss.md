description: A browser tab that lost its relay connection used to stay unreachable until the page was reloaded; it now keeps retrying in the background and comes back on its own.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/README.md, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

## What was wrong, and what landed

A node that cannot accept incoming connections (a browser tab, a machine behind
NAT) becomes dialable by holding a *reservation* on a relay. `CadreNode.reserveRelays()`
obtained one at startup and nothing ever obtained another, so a relay restart or a
connection blip left the tab permanently undialable — only a page reload fixed it.
libp2p's own relay discovery cannot cover for that: it nominates a relay only after
the *identify* handshake writes the relay-hop protocol into the peer store, and
cadre nodes speak a party-namespaced identify protocol the deployed relay never
answers.

`relay-reservation.ts` now carries a **supervisor** — a self-rescheduling loop —
on top of the unchanged single-shot `driveRelayReservation`:

```ts
superviseRelayReservation(node, addrs, opts): RelayReservationSupervisor
// { firstAttempt: Promise<void>; driving; retryAtMs; lastError; stop() }
```

Per tick: reservation held → reset the backoff, clear the error, re-check in
`checkMs` (5 s); otherwise → clear each target relay from the reservation store's
poison filter, run one drive, then sleep the backoff and double it (2 s → 60 s).

`CadreNode` holds one supervisor instead of the old `driving` counter +
`lastError` string. `reserveRelays()` stops any existing supervisor, starts a new
one, and awaits its `firstAttempt` — so callers keep exactly the old semantics
(resolve once the first attempt settles) and get background retries for free.
`stop()` stops the supervisor alongside the existing posture reset.

`RelayReservationStatus` gains `retrying`, and `RelayReservationState` gains
`retryAtMs: number | null`. New precedence: `none` → `reserved` → `dialing` →
`retrying` → `error`. **`error` now means "nobody is going to try again"** (no
supervisor, or no control node) — that is the behavioural change most likely to
matter to a reader of the status.

### The non-obvious part: libp2p's poison filter

`ReservationStore` records a peer in `relayFilter` (a cuckoo filter) when a
reservation *request* fails with `DialError` / `UnsupportedProtocolError`, and
nothing on that path ever clears it — the reset lives in `#checkReservationCount`,
which only runs when a reservation is genuinely removed. So a peer that was
briefly not-a-relay stays rejected as `The relay was previously invalid` for the
life of the process. `clearRelayFilterEntry(store, addr)` removes the entry before
every attempt, resolving the peer id straight out of the multiaddr (no dial
needed). It fails soft in every direction — no `relayFilter`, no `remove`, no peer
id in the addr, malformed addr → "no un-poisoning", never a throw.

Note the filter is **not** involved when the relay is simply *down*: our own dial
fails first and never reaches `addRelay`. That is why the plain restart case
recovers even without the un-poisoning, and why the two recovery specs are
separate.

## How to exercise it

**Automated** — `cd packages/cadre-core && yarn vitest run test/relay-reservation.spec.ts`
(31 tests, ~35 s, all passing). The new ones:

| spec | what it proves |
| --- | --- |
| `gets the reservation back after the relay restarts, with no manual re-drive` | the ticket's actual bug: reserve, stop the relay, wait for the circuit addrs to drain, restart at the SAME peer id + port, assert the addr returns with nothing driving it |
| `recovers after an attempt poisoned the reservation filter` | first attempt hits a live peer that is not a relay (asserted to poison `relayFilter`), that peer is replaced by a real relay at the same identity, supervisor gets through |
| `reports retrying between attempts and reserved once one lands` | the new status, and that a held reservation clears a stale error |
| `stops re-driving once stopped` | `stop()` really stops: a relay appearing 3 s later is ignored; second `stop()` does not throw |

Test-support shape worth knowing: `fixedIdentity()` pairs a generated key with a
port obtained by binding `:0`, reading the assignment and releasing it — a relay
can then be stopped and re-created as the same peer at the same address, which
`startRelay()` (ephemeral key, port 0) cannot do. Ports are never hard-coded
because spec files run in parallel. Supervisor timings in tests are
`checkMs/minBackoffMs: 250, maxBackoffMs: 1_000, timeoutMs: 2_000`.

**Anti-vacuity check I actually ran:** with `unpoisonRelayFilter()` short-circuited,
the poisoned-filter spec fails with `Timed out waiting for the supervisor to
reserve past the poisoned filter`. So `clearRelayFilterEntry` is load-bearing, not
decorative. (The temporary env hook used for that was removed.)

**Manual, in the reference web app** — set `localStorage["relay-addr"]`, load the
tab, watch the Home "Relay" row reach `reserved`; stop the relay and the row goes
`retrying` (amber, same colour as `dialing`), not `error`; restart the relay and it
returns to `reserved` with no reload. *Create invitation* stays refused throughout
the outage, which is correct — a `retrying` node is not dialable.

## Validation run

| command | result |
| --- | --- |
| `packages/cadre-core`: `yarn build` | clean |
| `packages/cadre-core`: `yarn vitest run test/relay-reservation.spec.ts` | 31/31 pass |
| `packages/cadre-core`: `yarn vitest run` (full) | 1488 pass / 5 fail — all 5 pre-existing, see below |
| root: `yarn lint` | clean |
| root: `yarn build` (whole monorepo) | clean |
| `packages/reference-app-web`: `yarn typecheck`, `yarn check:svelte`, `yarn test` | clean / 0 errors / 15 pass |
| `packages/reference-app-web`: `npx playwright test e2e/solo/formation-rbac.spec.ts` | 4/4 pass (the solo `relay: none` badge assertion still holds) |

**Pre-existing failures, not re-reported.** `test/control-revocation-reissue.spec.ts`
(4 tests) and `test/control-revocation-replay.spec.ts` (1 test) fail with
`UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` and
`context.OwnerKey isn't a column`. Both files are already listed in
`tickets/.pre-existing-known.md` against the blocked slug
`10-revocation-reissue-same-pk-update-unique-collision`, with byte-identical
fingerprints. Per the workflow rules I did not file `.pre-existing-error.md` and
did not skip or loosen anything. Nothing in this diff touches SQL or the control
schema.

Note also that `test/global-setup.ts`'s stale-build guard tripped on the external
`../quereus` workspace before any of this could run; I rebuilt it
(`yarn workspace @quereus/quereus build`) to clear the guard. That rebuild is
outside this repo and outside this diff.

## Known gaps — please probe these

- **`stop()` cannot abort a drive already in flight.** `driveRelayReservation`
  takes no `AbortSignal`, so `stop()` clears the timer and discards the result but
  a dial/reservation already running continues to completion (fail-soft, worst case
  a logged dial error against a torn-down node). The `stop()` spec deliberately
  stops *between* attempts to keep the assertion honest. Whether that residual
  window matters for `CadreNode.stop()` is worth a second opinion — it is
  documented on the interface, not fixed.
- **Overlapping `reserveRelays` calls** are last-caller-wins: the previous
  supervisor is stopped, the newest addr list is the truth. The old code's NOTE
  about unioning lists if a second relay source appears still applies and I did not
  implement unioning.
- **`retryAtMs` is reported on `reserved` too** (it is the next liveness check,
  not a retry). I judged that more useful than nulling it, but it is a naming
  mismatch a reviewer may disagree with — `RelayReservationState.retryAtMs` is
  documented as "next scheduled tick", not "next drive".
- **The poison-filter assertion is timing-sensitive by construction.** The
  `expect(relayFilterHas(...)).toBe(true)` runs with no intervening `await` after
  `firstAttempt`, because the next tick (250 ms later) clears the filter. It is
  correct but brittle to anyone inserting an `await` above it. A comment says so.
- **No integration-level coverage.** Everything here is loopback TCP in a unit
  spec. The real-WAN posture (a browser tab against the `ops/docker/libp2p-infra`
  relay actually restarting) is untested, same as before this ticket.
- **libp2p-internals coupling grew.** The module already reached through
  `node.components.transportManager`; it now also names `reservationStore.relayFilter`
  and `Filter.remove`. Both are optional-typed and fail soft, and the poisoned-filter
  spec pins the behaviour — but a libp2p bump is now one more thing to check.

## Tripwires parked in code

- `relay-reservation.ts` → the `NOTE:` in `describeReservationFailure` was stale
  ("if a retry loop is ever added, that filter has to be dealt with first") and now
  points at where the filter is cleared, plus warns any caller that re-drives
  *without* the supervisor that it must handle the filter itself.

## Stale comments corrected

All four sites the fix ticket flagged, plus two docs:

- `relay-reservation.ts` — module header (now names the retry loop),
  `resolveRelayReservationState` docblock (rewritten precedence + the sharpened
  meaning of `error`; the old text named this ticket by its `backlog/` path),
  `describeReservationFailure` NOTE.
- `cadre-node.ts` — `getRelayReservationState()` docblock.
- `packages/reference-app-web/README.md` — the `reserveRelays()` paragraph.
- `docs/architecture.md` — new paragraph in "Reservations are requested
  explicitly, not discovered".
- `docs/STATUS.md` — the relay-reservation spec inventory now lists the recovery
  specs.

## Incidental cleanup

Three copies of the `{ status: 'none', addrs: [], circuitAddrs: [], error: null }`
literal in the web app (`store.svelte.ts` ×2, `diagnostics.svelte.ts`) were about
to need a fourth field each. `noRelayState()` in `cadre-web.ts` already existed as
a factory, so it is now exported and used at all four sites. Behaviour identical —
it was already a factory rather than a shared const precisely because Svelte
proxies the assigned object.
