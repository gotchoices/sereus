---
description: Root-cause of the ~15 % browser dial:fail rate in Tier 2 e2e isn't reservation lifetime — `@libp2p/circuit-relay-v2`'s reservation TTL defaults to 2 hours, far longer than a 60 s run. The real cap is the **per-relayed-connection** `defaultDurationLimit: 2 min` and `defaultDataLimit: 128 KiB` that the relay server applies to every connection it forwards (see `node_modules/@libp2p/circuit-relay-v2/dist/src/constants.js:29-31`). Once a service-peer↔browser-peer connection through a relay hits 128 KiB of cumulative bytes (or 2 min wall-clock), the relay resets the stream and subsequent dials over the same circuit fail until a fresh circuit is established. The reference-peer service nodes instantiate `circuitRelayServer()` with no init (`libp2p-node-base.ts:223`), so these tight defaults are in effect. Fix: thread a relay-server init through `NodeOptions` and disable the default limits (`applyDefaultLimit: false`) on reference-peer service nodes, then enrich `protocol-client` `dial:fail` logging with the libp2p error code/message so the next regression is diagnosable from the trace alone.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, ../optimystic/packages/reference-peer/src/cli.ts, packages/reference-app-web/src/lib/optimystic.ts
---

## Architecture

### What's actually happening

`@libp2p/circuit-relay-v2`'s `ServerReservationStore` (in `node_modules/@libp2p/circuit-relay-v2/dist/src/server/reservation-store.js`) does this on every reservation:

```js
this.applyDefaultLimit = init.applyDefaultLimit !== false;  // default true
this.defaultDurationLimit = init.defaultDurationLimit ?? DEFAULT_DURATION_LIMIT;  // 2 min
this.defaultDataLimit = init.defaultDataLimit ?? DEFAULT_DATA_LIMIT;  // 128 KiB
// ...
if (this.applyDefaultLimit) {
    checkedLimit = limit ?? { data: this.defaultDataLimit, duration: this.defaultDurationLimit };
}
```

So every reservation issued by a reference-peer service node carries a `Limit { data: 128 KiB, duration: 2 min }`. The relay enforces this **per relayed connection**, not per-reservation. Once any single circuit-relay tunnel between two peers hits either cap, the relay resets the underlying stream — the reservation itself stays valid (TTL is 7,200,000 ms = 2 h), but the existing circuit is dead. Re-dialing should open a fresh circuit, which is why some retries succeed and others don't (race against connection-manager cache hits, dial-queue concurrency, etc.).

A Tier 2 e2e run pumps a lot of traffic over each circuit (cluster joins, FRET adverts, repo gets, consensus broadcasts × the ~30-60 s of the spec). 128 KiB is trivially exceeded.

### Two-part fix

1. **Disable the per-connection limit on reference-peer service nodes' relay server.** These are trusted nodes in a local cluster — there's no DoS surface to throttle. Pass `{ reservations: { applyDefaultLimit: false } }` to `circuitRelayServer(...)`. With `applyDefaultLimit: false`, the relay omits the `Limit` field from the reservation and does not enforce duration/data caps on forwarded connections. The 2 h reservation TTL still bounds total reservation lifetime.

2. **Surface dial:fail reason in `protocol-client`.** The existing `log('dial:fail peer=%s protocol=%s ms=%d')` discards `err`. Adding `code` (libp2p tags errors like `ERR_NO_VALID_ADDRESSES`, `ERR_HOP_REQUEST_FAILED`, etc.) and a truncated `message` makes the next regression diagnosable from the e2e trace alone. This is the more important durable change — without it, the next time this shifts, we're back to source-diving.

### Interface changes

```ts
// libp2p-node-base.ts NodeOptions
export type NodeOptions = {
    // ...existing fields...

    /** Enable the circuit-relay-v2 server. */
    relay?: boolean;

    /**
     * Init passed to `circuitRelayServer(...)` when `relay` is enabled.
     * Reference-peer nodes default this to `{ reservations: { applyDefaultLimit: false } }`
     * to lift the upstream 128 KiB / 2 min per-relayed-connection caps that
     * silently reset long-lived service↔browser circuits.
     */
    relayServerInit?: import('@libp2p/circuit-relay-v2').CircuitRelayServerInit;
};
```

`libp2p-node-base.ts:223` becomes:

```ts
...(options.relay ? { relay: circuitRelayServer(options.relayServerInit) } : {}),
```

The reference-peer CLI (`packages/reference-peer/src/cli.ts:355-368`-ish, the `createLibp2pNode` call site) supplies the default:

```ts
const node = await createLibp2pNode({
    // ...
    relay: effectiveRelay,
    relayServerInit: effectiveRelay
        ? { reservations: { applyDefaultLimit: false } }
        : undefined,
    // ...
});
```

`protocol-client.ts:77` becomes (rough shape):

```ts
const errCode = (err as { code?: string })?.code;
const errMsg = err instanceof Error ? err.message : String(err);
const trimmed = errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg;
log('dial:fail peer=%s protocol=%s ms=%d code=%s msg=%s%s',
    peer, protocol, elapsed, errCode ?? 'none', trimmed, cid ? ` cid=${cid}` : '');
```

(The `dial:timeout` branch already throws a typed `DialTimeoutError` and doesn't need this — keep that path unchanged.)

### Integration-test sketch

A new spec under `packages/db-p2p/test/` (e.g. `circuit-relay-long-lived.spec.ts`) that:

- Spins up two relay-server nodes (`relay: true`, `relayServerInit: { reservations: { applyDefaultLimit: false } }`).
- Spins up a "browser-shaped" client node with `listenAddrs: ['/p2p-circuit']` and `webSockets()` only (so it must reserve a relay slot).
- Waits for the reservation to surface in `getMultiaddrs()`.
- For 90 s, every 500 ms, has another peer dial the client through its relay multiaddr and push ~2 KiB of payload through a test protocol.
- Asserts every dial succeeds and that no `Limit`-exceeded reset surfaces.
- A control variant with `applyDefaultLimit: true` (the upstream default) should fail with a stream reset around the ~64-iteration mark, proving the test exercises the right surface.

The full 90 s spec is slow — gate it behind a `@long` mocha tag or only run under `RUN_LONG_TESTS=1` to avoid blowing the standard test budget. Document the env var in the spec's leading comment.

### Acceptance

- `dial:fail` log line includes `code=…` and `msg=…` fields populated from the underlying libp2p error.
- A targeted regression test (above) holds a relayed connection productive for 90 s without the relay resetting it.
- Tier 2 e2e `dial:fail` rate drops below 1 % on a fresh run. (This is the e2e-level acceptance; verify after landing by running the reference-app-web Playwright suite with the same debug trace and counting events in `C:\Temp\tier2-runN.log`.)

### Not in scope

- Client-side reservation auto-renewal. The reservation TTL is 2 h, far longer than any Tier 2 run; this is a non-issue at the current run length. If/when production-shaped runs exceed 2 h, the upstream `ReservationStore` in the transport already attempts re-reservation; verify behavior then.
- Bumping `DEFAULT_MAX_RESERVATION_STORE_SIZE` (15) — the Tier 2 e2e uses 3 service peers and 1 browser; we're nowhere near the cap.

## TODO

- Add `relayServerInit?: CircuitRelayServerInit` to `NodeOptions` in `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:48-132`.
- Thread it through to the `circuitRelayServer(...)` call at `../optimystic/packages/db-p2p/src/libp2p-node-base.ts:223`.
- In `../optimystic/packages/reference-peer/src/cli.ts` (the `createLibp2pNode({...})` block around line 355), pass `relayServerInit: { reservations: { applyDefaultLimit: false } }` when `effectiveRelay` is true. Surface a one-line console log (e.g. `🔁 Circuit-relay limits: disabled (reference-peer trusted)`) for diagnostics.
- Enrich the `dial:fail` log line in `../optimystic/packages/db-p2p/src/protocol-client.ts:77` to include `err.code` and a truncated `err.message`.
- Add `packages/db-p2p/test/circuit-relay-long-lived.spec.ts` per the sketch above. Gate the 90 s loop behind `process.env.RUN_LONG_TESTS === '1'` so the default `yarn workspace @optimystic/db-p2p test` run skips it.
- Run `yarn workspace @optimystic/db-p2p build` and the targeted test (`yarn workspace @optimystic/db-p2p test --grep "circuit-relay-long-lived"` with `RUN_LONG_TESTS=1`).
- Optionally re-run the Tier 2 e2e (`yarn workspace @serfab/reference-app-web test:e2e` or whichever script the prior tickets used) and confirm `dial:fail` rate drops below 1 % across a 60 s spec. If the e2e harness is too expensive to invoke from inside this implement pass, document the manual verification step for the review stage.
- No `optimystic.ts` changes required in the web reference — it consumes the relay-as-client, which is unaffected by the server-side limit knob. Listed in `files:` for context only.
