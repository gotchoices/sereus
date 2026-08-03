description: A browser tab that lost its relay connection used to stay unreachable until the page was reloaded; it now keeps retrying in the background and comes back on its own.
prereq:
files: packages/cadre-core/src/relay-reservation.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/relay-reservation.spec.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/README.md, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

## What shipped

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
poison filter, run one drive, and either rejoin the healthy path (the drive landed
a reservation) or sleep the backoff and double it (2 s → 60 s).

`CadreNode` holds one supervisor instead of the old `driving` counter +
`lastError` string. `reserveRelays()` stops any existing supervisor, starts a new
one, and awaits its `firstAttempt` — so callers keep exactly the old semantics
(resolve once the first attempt settles) and get background retries for free.
`stop()` stops the supervisor before tearing the node down.

`RelayReservationStatus` gains `retrying`, and `RelayReservationState` gains
`retryAtMs: number | null`. Precedence: `none` → `reserved` → `dialing` →
`retrying` → `error`. **`error` now means "nobody is going to try again"** (no
supervisor, or no control node) — the behavioural change most likely to matter to
a reader of the status.

### The non-obvious part: libp2p's poison filter

`ReservationStore` records a peer in `relayFilter` (a cuckoo filter) when a
reservation *request* fails with `DialError` / `UnsupportedProtocolError`, and
nothing on that path ever clears it — the reset lives in `#checkReservationCount`,
which only runs when a reservation is genuinely removed. So a peer that was
briefly not-a-relay stays rejected as `The relay was previously invalid` for the
life of the process. `clearRelayFilterEntry(store, addr)` removes the entry before
every attempt, resolving the peer id straight out of the multiaddr (no dial
needed), failing soft in every direction.

The filter is **not** involved when the relay is simply *down*: our own dial fails
first and never reaches `addRelay`. That is why the plain restart case recovers
even without the un-poisoning, and why the two recovery specs are separate.

## Review findings

Reviewed the implement diff (`27bd477`) against the fix ticket, then the whole of
`relay-reservation.ts`, `cadre-node.ts`'s reservation surface, every web-app site
that reads the relay status, and the three docs the change touches.

### Major — one ticket filed

- **An in-flight drive cannot be cancelled.** `driveRelayReservation` takes no
  `AbortSignal`, so `stop()` (supervisor or `CadreNode`) ends the *next* attempt
  but not the current one: it finishes its dial and then polls the node's
  addresses until its own 10 s timeout. Against a node being torn down that
  produces relay errors in the log that look genuine but are not, and the poll's
  `setTimeout` is not `unref`'d (unlike the supervisor's own retry timer), so it
  may also delay process exit. The implementer flagged this window and asked for
  a second opinion; this is that opinion — it is real, bounded, and needs a
  signal threaded through all three phases of the drive, which is more than a
  review-pass edit. Filed as `backlog/bug-relay-drive-not-cancellable`
  (`repro: static` — the exit-delay half is read from the code, and the ticket
  names the experiment that would confirm it).

### Minor — fixed in this pass

- **A malformed relay address hung `reserveRelays()` forever.** `multiaddr()`
  throws *synchronously*, and `dialRelays` called it inside the `map` callback —
  outside `Promise.allSettled`, so the throw escaped and rejected the whole
  drive, breaking the module's documented never-throws contract. Under the new
  supervisor that rejection escaped `tick()` as an **unhandled rejection** and
  left `firstAttempt` pending forever, so `CadreNode.reserveRelays()` never
  resolved and the web app's `createNode()` hung at startup instead of booting
  solo. A typo'd `VITE_RELAY_ADDR` / `localStorage["relay-addr"]` reaches this
  path. Measured with a throwaway spec before fixing: drive → `threw`,
  `firstAttempt` → `HUNG`. Fixed at the root — the address is now parsed inside
  the dial promise (`dialOne`), so a bad entry is an ordinary settled rejection
  and a good relay later in the list still reserves. `driveOnce` additionally
  catches, so no future contract violation can stall the loop again.
- **The backoff was not reset by a drive that succeeded.** A drive that landed a
  reservation still scheduled the next tick on the *grown* backoff, so after a
  long outage the first liveness check sat up to `maxBackoffMs` (60 s) away —
  a reservation lost again right after recovery would go unnoticed for that whole
  window before anything even tried. `tick()` now re-checks after the drive and
  rejoins the `checkMs` cadence. Anti-vacuity confirmed: with the re-check
  stubbed out the new spec fails with `expected 8000 to be less than 2000`.
- **`CadreNode.stop()` stopped the supervisor after `cleanup()`.** `cleanup()`
  stops the control node partway through, so a tick firing during it would dial
  and then poll a half-torn-down node — exactly what that line's own comment says
  it prevents. Moved ahead of `await this.cleanup()`, matching how `cleanup()`
  already orders `stopRecordRefresh()` before the control node goes away.
- **Stale comment missed by the implement pass.** `cadre-web.ts:373` still said
  an unreachable relay "resolves to `status:'error'`"; it resolves to `retrying`
  now. Rewritten. (The four sites and two docs the fix ticket listed were all
  correctly updated — this was a fifth the ticket did not name.)

### Tripwires — parked in code, not filed

- `clearRelayFilterEntry` silently no-ops for a relay address with no `/p2p/`
  component. Such an address can still be dialed and reserved through (the peer
  id comes off the connection) but can never be un-poisoned, so for that address
  the permanent-poisoning bug returns. No caller supplies one today. `NOTE:` at
  the `peerId === null` branch in `relay-reservation.ts`.

### Checked and found clean, or accepted as-is

- **Concurrency and lifecycle.** Only one timer can ever be pending (`tick` nulls
  it before running, and `schedule` is reached only from `tick`); `stop()` is
  idempotent and short-circuits `schedule`; `settleFirst` is guarded; the
  `firstAttempt` promise is assigned before `tick()` starts, and `settleFirst()`
  runs in the same synchronous block as the scheduling that follows it, so a
  caller resuming from `await firstAttempt` always sees `retryAtMs` set — that is
  why a failed first attempt reports `retrying`, not `error`.
- **Timer cleanup.** The retry timer is `unref`'d with an optional chain for
  browsers/RN. The one non-`unref`'d timer is inside the drive; that is the
  filed ticket above, not a separate finding.
- **Status consumers.** Every site that branches on the status string was read:
  `Home.svelte` (`relayReady`, the `.relay-retrying` CSS rule the diff adds),
  `Diagnostics.svelte`, `cadre-web.ts`'s invitation guard, `store.svelte.ts`'s
  transition log. No unhandled `retrying`. `Diagnostics.svelte` renders the error
  string in red while `retrying` — accepted: that string is *why* it is retrying,
  and the status badge itself stays neutral. No other package (cadre-cli,
  cadre-host, reference-app-rn) reads relay status.
- **`retryAtMs` reported on `reserved`.** The implementer flagged the naming as
  debatable. Accepted: it is documented on the field as "next scheduled tick",
  the alternative (nulling it) loses information, and no consumer misreads it.
- **File size.** `relay-reservation.ts` is 818 lines (`wc -l`), 6th of 58 files in
  `packages/cadre-core/src` and well under `cadre-node.ts` (4781). Much of it is
  the module header explaining the libp2p seams. Splitting the drive from the
  supervisor would duplicate that shared context for no gain; not filed.
- **libp2p-internals coupling.** Grew from `components.transportManager` to also
  name `reservationStore.relayFilter` / `Filter.remove`. Both optional-typed,
  both fail soft, and the poisoned-filter spec pins the behaviour so a libp2p
  bump fails loudly rather than silently. Accepted as the implementer described.
- **Docs.** Read every file the change touches plus the ones it should have.
  `docs/architecture.md`, `packages/reference-app-web/README.md` and the
  `relay-reservation.ts` / `cadre-node.ts` docblocks all match the new reality.
  `docs/STATUS.md`'s spec inventory was extended in this pass to cover the four
  specs added here.
- **Empty categories.** No security findings (this path handles no secrets and
  adds no new trust decision). No SQL and no control-schema changes, so nothing
  for the lowercase-reserved-words rule. No `any`, no inline `import()`, no eaten
  exceptions after the `driveOnce` catch (which logs).

### Test coverage added

Four specs on top of the implementer's four, all in
`packages/cadre-core/test/relay-reservation.spec.ts`:

| spec | proves |
| --- | --- |
| `reports a malformed addr instead of throwing out of the drive` | the never-throws contract holds for an unparseable address |
| `still reserves on a good relay when another addr is malformed` | one bad entry does not cost the reservation on a live relay |
| `settles the first attempt on a malformed addr rather than hanging` | the startup `await` resolves, and the status is `retrying` |
| `drops back to the liveness cadence as soon as an attempt lands…` | the backoff reset (fails at `8000 < 2000` without the fix) |

## Validation run

| command | result |
| --- | --- |
| root: `yarn lint` | clean |
| root: `yarn build` (whole monorepo) | clean |
| `packages/cadre-core`: `yarn vitest run test/relay-reservation.spec.ts` | 35/35 pass |
| `packages/cadre-core`: `yarn vitest run` (full, twice) | run 2: 1492 pass / 5 fail — the 5 known pre-existing |
| `packages/reference-app-web`: `yarn typecheck`, `yarn check:svelte`, `yarn test` | clean / 0 errors / 15 pass |
| `packages/reference-app-web`: `npx playwright test e2e/solo/formation-rbac.spec.ts` | 4/4 pass |

**Pre-existing failures, not re-reported.** `test/control-revocation-reissue.spec.ts`
(4 tests) and `test/control-revocation-replay.spec.ts` (1 test) fail with
`UNIQUE constraint failed: Revocation.TableName, Revocation.StampId` and
`context.OwnerKey isn't a column`. Both files are listed in
`tickets/.pre-existing-known.md` against the blocked slug
`10-revocation-reissue-same-pk-update-unique-collision`, with byte-identical
fingerprints. No `.pre-existing-error.md` written; nothing skipped or loosened.

**One flake observed, deliberately not filed.** The first full-suite run also
failed `test/device-token-registry.spec.ts` ("registers a self-signed token…")
with `Block default/CadrePeer is unavailable (peers-unreachable)`. It passes
alone (13/13) and passed in the second full run, so it is contention under the
91-file parallel suite rather than a defect. Filing it would send the triage pass
after a green test; recording it here instead. If it recurs it deserves a ticket.

`test/global-setup.ts`'s stale-build guard tripped on the external `../quereus`
workspace before the suite could run; rebuilt it
(`yarn workspace @quereus/quereus build`) to clear the guard, same as the
implement pass. That rebuild is outside this repo.

## Known gaps carried forward

- **Overlapping `reserveRelays` calls** are last-caller-wins: the previous
  supervisor is stopped, the newest addr list is the truth. Unioning lists if a
  second relay source ever appears is still unimplemented and still noted in the
  code.
- **No integration-level coverage.** Everything here is loopback TCP in a unit
  spec. The real-WAN posture (a browser tab against the `ops/docker/libp2p-infra`
  relay actually restarting) is untested, as it was before this ticket.
- **The poison-filter assertion is timing-sensitive by construction** — the
  `relayFilterHas` check runs with no intervening `await` because the next tick
  clears the filter 250 ms later. Correct, but brittle to anyone inserting an
  `await` above it. A comment says so.
