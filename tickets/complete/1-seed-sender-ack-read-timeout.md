description: The code that hands a fresh seed to a new peer used to wait forever for that peer's reply and would buffer any amount of data it sent back; it now gives up after a deadline and refuses an oversized reply. Reviewed, deduplicated against the two sibling protocols, and verified against real networking.
prereq:
files: packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/test/control-stream-exchange.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, docs/architecture.md
difficulty: medium
----

## What shipped

`SeedBootstrapService.deliverSeed` — the seed **sender**, which dials a
not-yet-trusted node during onboarding — is now bounded in both time and size, closing
the last unbounded control-stream read surface in `cadre-core`:

- `seedDeliverTimeoutMs` (default 10s, `SeedBootstrapConfig`) bounds the whole exchange:
  dial, write, half-close, ack read. Its abort signal goes into `dialProtocol`, so a
  deadline that fires mid-connect cancels the dial; a deadline that fires after the
  stream is open resets the stream, releasing the ack read.
- The ack is read through the shared `readStreamToEnd` capped at the same 1MB
  `MAX_SEED_SIZE` as the receiver, so a target cannot stream unlimited bytes as a fake ack.
- Ack decoding (`decodeLengthPrefixedFrame` + `JSON.parse`) runs inside the
  reset-on-failure path, so a malformed or non-JSON ack resets the stream rather than
  leaking it.

Public API is unchanged (`deliverSeed(targetMultiaddr, seed): Promise<SeedAckMessage>`);
the knob is config-only, matching the receiver knobs.

**Review added a shared sender primitive.** The implement pass produced a third
copy of the sender exchange (wake and strand-addr already had one each). Both halves now
live in `control-stream.ts` — the module whose stated purpose is exactly this:

- `withDeadline(ms, label, op(signal))` — `withTimeout` with an `AbortController` wired
  into `onTimeout`, so the op receives a signal that is cancelled at the deadline.
- `exchangeFrame(stream, signal, request, readResponse, abortMessage)` — write one frame,
  half-close the write end, read the response, and reset the stream on any failure,
  including a dial that lands after the deadline already fired.

`sendSeed`, `sendWake`, and `sendStrandAddr` now each supply only their dial options,
request object, and response decoder. Behaviour is unchanged except one deliberate
improvement: every reset goes through a single idempotent `abort`, so the deadline
listener and the error path can no longer double-reset the same stream (the untested
double-abort the implement handoff flagged).

## Review findings

**Checked:** the implement diff read cold before the handoff summary; `deliverSeed`/`sendSeed`
against both sibling senders (`strand-wake-protocol.ts`, `strand-addr-protocol.ts`) and the
shared primitives in `control-stream.ts`; resource cleanup on every exit path (success,
decode failure, size cap, deadline-during-dial, deadline-during-read); timer hygiene;
type safety (no new `any`, no non-null assertions); test coverage against happy path, edge,
error, and regression; every doc that mentions seed delivery or the control-stream
primitives (`docs/architecture.md`, `docs/api.md`, `docs/STATUS.md`).

**Major (none filed as tickets).** No correctness defect found in the implement diff. The
bounds hold, the stream is released on every path, and the framing round trip survives —
now proven against real libp2p, not only stream doubles (see Validation).

**Minor — fixed in this pass:**

- *Triplicated sender exchange (DRY).* The diff added a third copy of ~35 lines of
  dial/abort-wiring/write/half-close/read/reset. Extracted to `withDeadline` +
  `exchangeFrame` in `control-stream.ts` and applied to all three senders. Net effect:
  the seed sender is ~50 lines shorter than the implement version and the wake and
  strand-addr senders shrank too.
- *Double abort on the same stream* (flagged as untested in the handoff). Made
  structurally impossible by the single idempotent reset inside `exchangeFrame`, and
  pinned by a test.
- *Implicit ack size cap.* `decodeLengthPrefixedFrame(data)` relied on its default
  `maxLength`; now passes `MAX_SEED_SIZE` explicitly, as the wake path already did.
- *Ack read split out.* The read+decode is now `readSeedAck`, a named single-purpose
  method, rather than inline in the middle of the send path.
- *Test gaps the handoff listed as open.* Added: empty ack (a target that half-closes
  without writing rejects with the framing error rather than a synthetic refusal);
  well-framed-but-non-JSON ack body (rejects, stream reset); dial that completes *after*
  the deadline fired (rejects, and the late stream is still reset — the leak path nothing
  had covered); and a positive assertion that the dial carries `SEED_PROTOCOL` plus a
  live `AbortSignal` and that exactly one framed request is written and half-closed.
- *Docs.* Rewrote the sender-hardening bullet in `docs/architecture.md` to say the three
  senders share the *same code*, not merely the same shape. Updated `withTimeout`'s doc
  comment to point senders at `withDeadline`. `docs/api.md` needed no change (unchanged
  signature); `docs/STATUS.md` has no control-stream hardening section to update.

**Tripwires (recorded, deliberately not ticketed):** none. The one conditional concern
worth naming was already carried in code by the implement pass — the comment on `sendSeed`
explaining why the seed dial does **not** set `runOnLimitedConnection` (a seed is up to
1MB, and this path does not dial relay addresses today). Reviewed and agreed; left as-is.

**Deliberately not changed:**

- *`readResponse`'s own read timeout gets the full budget again* after the dial and write
  already consumed part of it. It is a backstop for the case where an abort does not
  release the read, never the primary bound, and the outer deadline always fires first.
  Documented as such on `exchangeFrame`.
- *Rejection assertions stay loose* (`/timed out/i`) where the outer deadline and the
  inner backstop are a genuine race. The new tests that *can* be exact are exact.

## Validation

- `yarn workspace @serfab/cadre-core test` — **68 files, 1054 passed, 1 skipped**
  (baseline before this pass: 67 files, 1043 passed; +11 tests, no regressions).
- `yarn lint` — exit 0.
- `yarn workspace @serfab/cadre-core typecheck` and `build` — exit 0.
- `yarn workspace @serfab/integration-tests test src/scenarios/deliver-seed-cross-network.integration.ts`
  — **5 passed**, including `e2e: deliverSeed round-trips through service handler on both
  sides` over real libp2p/TCP. This closes the handoff's largest flagged gap: real libp2p
  accepts `{ signal }` as the third `dialProtocol` argument and the round trip works.
- `push-wake-e2e.integration.ts` was **not run**: the suite's build-freshness gate refused
  to start, reporting a stale `dist` in the linked external `../quereus` workspace
  (`C:\projects\quereus`) — an environment condition outside this repo, not a test failure
  and not introduced here. The wake sender's own unit spec (real protocol over a connected
  in-memory stream pair) passes. Re-run that scenario after rebuilding `../quereus`.
- No `tickets/.pre-existing-error.md` written — nothing in this repo failed.
