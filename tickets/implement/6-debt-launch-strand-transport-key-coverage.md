description: Add a test proving that when a device joins a group chat, that group connection really does announce itself under its own network name instead of reusing the device's main one.
prereq:
files: packages/cadre-core/src/cadre-node.ts (launchStrand ~L3161-3212), packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts (injection pattern to copy), packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts (new — already drafted, see below)
difficulty: easy
----

# Cover the strand-launch wiring, not just the key helper

A cadre node runs its control connection and each strand it participates in as separate
libp2p nodes. They used to share one network identity (peerId), which broke relayed
connections; `launchStrand` (`cadre-node.ts` ~L3161) now derives a distinct per-strand key via
`strandTransportKey` before handing it to `StrandInstanceManager.startStrand`.

`strandTransportKey` itself is well covered (`test/strand-transport-key.spec.ts`) and the relay
collision it cures is pinned on loopback libp2p nodes (`test/strand-transport-relay.spec.ts`).
What was missing is the **wiring in between**: that `launchStrand` actually derives the key and
passes it through, so a future edit reintroducing `privateKey: this.identityKey` would go
unnoticed.

## Status: draft already written and passing — verify and hand off

`packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts` has already been written in the
working tree (uncommitted) using the injection pattern from
`test/cadre-node-strand-seed.spec.ts`: construct a `CadreNode`, assign the private `identityKey`
field and a fake `strandManager` (records the `StartStrandConfig` its `startStrand` receives)
through `as unknown as {...}` casts, then invoke the private `launchStrand` method directly.
`controlNode`/`controlDatabase` are left unset (`resolveCohortSeed` returns an empty seed in that
state) and `hibernationManager.trackStrand` no-ops while the manager isn't running, so nothing
else needs stubbing.

It asserts the four cases below and currently passes (`yarn vitest run
test/cadre-node-strand-launch-key.spec.ts` — 4/4) with `yarn eslint
packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts` (run from repo root) clean.

## Expected behavior asserted

- Launching a strand hands `startStrand` a private key whose peerId is **not** the control
  node's peerId.
- That key equals `strandTransportKey(identityKey, strandId)` — i.e. it is the derived key,
  not some freshly generated one (which would also be distinct but would lose peerId
  stability across restarts) — checked via `.raw` byte equality.
- Launching two different strands on the same node yields two different keys.
- With no identity key configured, no key is passed through (`privateKey: undefined`), so
  libp2p generates its own (still distinct per node).

## Edge cases & interactions

- Two strands launched sequentially on the same node must not collide or reuse cached state
  between the two `launchStrand` calls (covered).
- The no-identity-key path is a real production path (nodes without `keyStore`/`privateKey`
  configured) — must not be skipped, not just an unreachable defensive branch (covered).
- `resolveCohortSeed`'s early-return when `controlNode`/`controlDatabase` are unset must not be
  confused with a stub that changes what key gets passed — the key derivation happens before
  seed resolution in `launchStrand`, independent of that short-circuit (verify this ordering
  still holds by reading current `launchStrand` source before treating the test as final).

## TODO

- Re-run `yarn vitest run test/cadre-node-strand-launch-key.spec.ts` from
  `packages/cadre-core` and `yarn eslint packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts`
  from repo root to confirm still green (nothing else in this ticket's file list should have
  changed underneath it, but re-verify rather than trust the draft).
- Run the full `packages/cadre-core` suite once (`yarn vitest run`) to confirm no interaction
  with other specs (shared `debug` namespaces, port usage, etc.) — the new spec was only run in
  isolation so far.
- If everything is green, hand off to `review/` with a `## Review findings` summary; no source
  changes are expected, only the new test file.
