# Manual bootstrap tests

Two simple scripts demonstrate a responder (listener) and an initiator (dialer) using the Sereus bootstrap protocol over libp2p.

Prerequisites:
- Node 20+ (libp2p 2.x)
- Yarn install at workspace root: `yarn install`
- Option A: Run with ts-node (recommended for quick trials)
  - Use `npx ts-node` (no global install required)
- Option B: Build to JS and run with node
  - Build: `yarn workspace @sereus/bootstrap build`
  - Then run compiled JS (you would need to copy or re-point these scripts; Option A is simpler).

## 1) Start the responder (listener)

From the repo root (or within `sereus/bootstrap`):

```bash
npx ts-node sereus/bootstrap/test/manual/bootstrap-listen.ts
```

This will print multiaddrs the responder is listening on, for example:

```
Responder listening on: /ip4/127.0.0.1/tcp/52743
```

Copy one address to pass to the dialer.

## 2) Run the initiator (dialer)

In a second terminal:

```bash
npx ts-node sereus/bootstrap/test/manual/bootstrap-dial.ts /ip4/127.0.0.1/tcp/52743
```

It will attempt a bootstrap with a responderCreates token and print the result on success:

```
Bootstrap result: { strand: { strandId: 'str-...', createdBy: 'responder' }, dbConnectionInfo: { ... } }
```

Notes:
- If you prefer, you can add `/p2p/<peerId>` to the address, but for local tests the bare TCP multiaddr is sufficient.
- If your environment doesn’t have `ts-node`, install it or use `tsx`, or build with `yarn workspace @sereus/bootstrap build` and run equivalent compiled scripts.


