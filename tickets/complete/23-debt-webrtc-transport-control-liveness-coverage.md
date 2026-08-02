---
description: Tests now boot a node configured with the same peer-to-peer connection types the phone and browser apps ship, and prove its own-settings reads and writes still answer promptly. Reviewed and completed — the tests were confirmed to genuinely exercise those connection types rather than quietly falling back to the old ones.
files: packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/package.json, yarn.lock, docs/STATUS.md
difficulty: medium
---

# Complete: WebRTC transports in the control-database liveness suite

`@serfab/cadre-core`'s control-database liveness spec runs the two reference apps' real transport
lists. Four cases inside `describe('stress and transport shapes (transaction profile)')`: the
browser list (`webSockets`/`circuitRelay`/`webRTC`/`webRTCDirect`), the phone list (same without
`webRTCDirect`), a grinding-dial-pass case over 3 siblings, and a `stop()`-mid-dial case. Siblings
are recorded at the address shapes those transports actually claim — `…/p2p-circuit/webrtc/…` and
`…/webrtc-direct/certhash/…` — on RFC 5737 TEST-NET-1 (`192.0.2.0/24`, guaranteed unrouted).
`@libp2p/webrtc` is pinned at `6.0.14` in `devDependencies`, matching both apps exactly.

## Review findings

### Checked and clean

- **Transport lists match the apps.** `reference-app-web/src/lib/cadre-web.ts:334-339` and
  `reference-app-rn/src/cadre-phone.ts:254-265` — browser has all four, phone omits
  `webRTCDirect`. Version pin `6.0.14` identical across `cadre-core`, `reference-app-web`,
  `reference-app-rn`.
- **Blast radius.** `git status` shows only the spec, `package.json`, `yarn.lock` in the implement
  commit — no reference app, no `CadreNode` source. `yarn.lock` delta is one line.
- **Address-band collision.** 51–56 vs the existing 1/2/3/11/12/13/21/31/41 — no overlap. (Moot
  anyway: every case gets a fresh `partyId` and fresh `MemoryRawStorage`.)
- **Type safety.** The `as unknown as TransportFactory` bridge is the narrowest thing that
  typechecks; it mirrors the identical bridge both reference apps already carry, and the alias is
  local. No `any`. `yarn workspace @serfab/cadre-core run typecheck` exits 0.
- **Resource cleanup.** The vitest process exits on its own after every run — no native
  `RTCPeerConnection` outliving the suite.

### The anti-vacuity question — falsified three ways, guard holds

This was the ticket's central risk: a test that *lists* `webRTC()` and then dials a `/ws` address.

- **Deleted `webRTC()` from `browserTransports()`** → the browser case fails with the relayed
  address routing to `null` instead of `@libp2p/webrtc`. The guard bites, and it bites on the
  routing assertion, not merely on timing.
- **Timing corroborates.** Both WebRTC liveness cases run 10.3 s — the full js-libp2p dial timeout,
  identical to the blackhole cases. The dials genuinely hang rather than failing fast, so the
  WebRTC path is being entered, not short-circuited.
- **Dial-queue identity** (see below) independently proves the WebRTC transport ran.

### Found and fixed in this pass

- **`WEBRTC_CERTHASH`'s justification was factually wrong.** The comment claimed the value "must be
  syntactically valid, because `multiaddr()` throws on a malformed certhash and `parseMultiaddrs`
  then silently DROPS the address". Measured: `multiaddr()` does not validate the certhash at all —
  `u!!!bad!!!` and even the un-prefixed `notmultibase` parse and round-trip cleanly; only an *empty*
  certhash fails, and then with an unrelated `UnknownProtocolError` about the following segment.
  Confirmed end-to-end by substituting a junk certhash and watching the browser case still pass.
  The *value* is fine (it decodes to a well-formed 34-byte `0x12 0x20 …` sha2-256 multihash) — only
  the reasoning was wrong, and it was wrong in the dangerous direction: it implied a safety net that
  does not exist. Comment rewritten to say the routing assertion is the *only* thing standing
  between a wrong address and a vacuous case.
- **Closed the dial-queue identity gap the implementer flagged as open.** The handoff noted the
  `stop()`-mid-dial case asserted queue *depth*, not *identity*, and invited closing it if cheap. It
  is cheap. Instrumenting the queue showed it holds exactly two entries: the sibling, and **the
  relay hop out of the sibling's `…/p2p-circuit/webrtc/…` address**. That second entry exists only
  because `@libp2p/webrtc` claimed the address, decapsulated `/webrtc` and re-dialed the signalling
  leg — no other configured transport produces it. The case now waits on the relay hop appearing
  (new `dialQueuePeerIds` helper, `relayPeerId` added to `WebRtcPeer`) rather than on
  `length > 0`, and additionally asserts the sibling's own dial is in flight. The existing
  `passSettled` escape is preserved, so a CI network that answers TEST-NET-1 still passes.
  Also confirmed by instrumentation that `passSettled` was `false` at the wait's exit — the dial
  really was in flight, the case was never passing by falling through.
- **`docs/STATUS.md:793-794` was stale.** It still read "WebRTC-in-the-transport-set is deferred —
  see backlog `debt-webrtc-transport-control-liveness-coverage`" after that work landed. Replaced
  with what actually ships, including the anti-vacuity mechanism and the one shape still uncovered.
- **Transport-list drift.** The two lists are a hand-copy of the apps' and nothing enforces they
  stay in step (`cadre-core` cannot import from a package that depends on it). Added a `NOTE:` at
  the site saying to update them when an app changes, and to export from a shared place if they
  start diverging faster than the file tracks.

### Noted, deliberately not changed

- **The apps' permissive `connectionGater` is not copied.** It exists to un-block the *browser's*
  default refusal to dial insecure/loopback addresses; node's default gater does not refuse
  TEST-NET-1, so copying it would change nothing. Documented at the site.
- **The phone case asserts routing on an address not on the sibling's record.** Deliberate and
  correct — recording it would only exercise libp2p's address filter. The `null` assertion is about
  the transport list, which is exactly what distinguishes the phone shape from the browser one.
- **No timing assertions, transaction profile only, non-listening posture only.** All three are
  the implementer's stated design, all three are right: timing assertions would break on a CI
  network that answers TEST-NET-1, and the `transaction`/`storage` split is already exercised by the
  departed/blackhole cases.

### Categories with nothing to report

- **New tickets filed: none.** No finding was major. The two real defects (a wrong comment, a stale
  doc) and the one open gap (queue identity) were all fixable inline within this pass, and were.
- **Tripwires newly parked: none.** The implementer's two — file size and the `node-datachannel`
  native binding — are correctly sited and still accurate; the file-size one had its measured count
  refreshed 750 → 791. The transport-drift `NOTE:` added above is the only new one.
- **Blocked items: none.** Nothing here needs a human decision or an out-of-repo dependency.

### Still uncovered (unchanged from the handoff, and correctly so)

The browser app's **listening** posture (`listenAddrs: ['/p2p-circuit', '/webrtc']`) only applies
when the tab holds a relay reservation, which needs a live relay to reserve against. That is an
integration-suite shape, not a unit one, and remains uncovered. Now recorded in `docs/STATUS.md`
rather than only in a ticket.

## Validation

- `yarn workspace @serfab/cadre-core run typecheck` — exit 0.
- `yarn lint` — exit 0.
- `yarn workspace @serfab/cadre-core run test control-database-offline-peers --reporter=verbose` —
  **13 passed / 13**, 169 s. The `stop()`-mid-dial WebRTC case moved 129 ms → 194 ms, the cost of
  waiting for the relay hop instead of any queue entry.
- `yarn workspace @serfab/cadre-core run test` (whole package) — **1390 passed, 5 failed, 1
  skipped** across 86 files. All 5 failures are the already-tracked entry in
  `tickets/.pre-existing-known.md` (`10-revocation-reissue-same-pk-update-unique-collision`,
  blocked): `control-revocation-reissue.spec.ts` (4) and `control-revocation-replay.spec.ts` (1).
  Not re-reported, not skipped, nothing touched.
- `yarn dep-check` — exit 0. knip flags no unused/unlisted dependency for `cadre-core`; only the
  pre-existing unused-files/unused-exports noise. `check-dep-ranges` passes.

Note for whoever runs this next: the stale-build guard tripped on `@quereus/quereus` **twice** mid-
review (that tree is being edited concurrently), each time cleared by
`yarn workspace @quereus/quereus build` in `C:\projects\quereus` as the guard instructs. Nothing in
this repo was reverted or rebuilt.
