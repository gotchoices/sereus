description: Raise the @optimystic/* floor to the release that sizes libp2p's per-address dial timeout from linkRoundTripMs, so relayed dials at the supported 3 s round trip stop timing out after 6 s (gotchoices/sereus#13).
files: package.json and packages/*/package.json (@optimystic/* ranges), .release-notes.pending.md
----
# Adopt optimystic's link-sized addressDialTimeout

**Blocked on:** an optimystic release (upstream ticket `fix/1-a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout`, tended by optimystic-ec, cd174d58).

## Why

kjeib measured on #13 that a relayed formation at 1500 ms per-frame delay times out 6.0 s into the dial. The cause is libp2p's fixed per-address `addressDialTimeout` of 6000 ms.
- Optimystic sizes `dialTimeout` and `inboundUpgradeTimeout` from `linkRoundTripMs`, but not this limit.
- Sereus can't pass it through, because optimystic's `connectionManager` option accepts only those two fields.
- With the limit raised to 30 s, the test passed end to end.

Upstream also found two related points:
- Its RPC clients' own dials are capped at 6 s per address as well, because libp2p's dial queue combines the per-address timer with the caller's signal.
- The fix raises optimystic's libp2p range to ^3.3.11.

## TODO

- [ ] When optimystic releases the fix, raise the `@optimystic/*` floors to that version and check that sereus's own libp2p range is compatible with ^3.3.11.
- [ ] Check whether any libp2p node that sereus builds itself (outside optimystic) should set `addressDialTimeout` too. See `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults`.
- [ ] Add a release note for the floor change.
- [ ] Ask kjeib on #13 to re-run 1500 ms without their `node_modules` patch, and close #13 on a pass.
