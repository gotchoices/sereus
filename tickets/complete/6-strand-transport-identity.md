description: A device's group-chat connection and its main connection used to announce themselves under the same network name, so a shared relay server delivered messages to the wrong one. Each group connection now derives its own network name. Reviewed and accepted.
prereq:
files: packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/cadre-node.ts (launchStrand ~L2756-2785), packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-transport-key.spec.ts, packages/cadre-core/test/strand-transport-relay.spec.ts, docs/architecture.md, docs/strands.md
difficulty: medium
----

# Complete: per-strand libp2p transport identity

Closes the cause behind https://github.com/gotchoices/sereus/issues/1. A `CadreNode` runs its
control node and each strand node as separate libp2p instances; all of them were handed the
same private key, so they shared one peerId. `@libp2p/circuit-relay-v2` keys reservations and
hop-connects by peerId, so a relay handed relayed streams for one node to the other —
`UnsupportedProtocolError`, then `NoValidAddressesError`, `strandPeers=0`.

## What shipped

- **`strand-transport-key.ts`:** `strandTransportKey(identityKey, strandId)` derives an
  Ed25519 key from `sha256(digest(['sereus.strand-transport-key.v1', <identity seed b64url>,
  strandId]))`. Deterministic (stable peerId across restarts), domain-separated, versioned,
  and keyed on the identity *private* seed so outsiders cannot enumerate a member's strand
  peerIds from public data. Throws on a non-Ed25519 identity key. Deliberately **not**
  exported from the package barrel — `cadre-node.ts` is its only consumer.
- **`cadre-node.ts` `launchStrand`:** passes the derived key to `startStrand` instead of
  `this.identityKey`, deriving only when an identity key is set (unchanged
  undefined-tolerance: libp2p then generates a random per-strand key, still distinct).
- **Control side and all cadre authority untouched.** No wire or schema change; the
  strand-addr RPC simply starts returning genuinely distinct addresses.
- **Docs:** `docs/architecture.md` (strand bootstrap seed + strand isolation),
  `docs/strands.md` (within-party discovery), `strand-addr-protocol.ts` header.
- **devDeps** on `cadre-core` for the relay test: `@libp2p/circuit-relay-v2 ^4.1.3`,
  `@libp2p/identify` pinned exact `4.0.10` (`^4.0.10` resolves to 4.1.11, which wants
  `@libp2p/interface ^3.2.5` and type-clashes with the repo's hoisted 3.1.0; the pin dedupes
  against the tree `@optimystic/db-p2p` already uses — unpin when the libp2p stack is bumped).

## Review findings

### Verified — the "transport only, authority untouched" claim holds

This is the claim the whole change rests on, so it was re-derived from the code rather than
taken from the handoff:

- Every strand-side signature comes from a member/manager keypair
  (`strand-membership-writer.ts` — `memberKeyPair.privateKeyB64` /
  `managerKeyPair.privateKeyB64`), and `StrandDatabase` receives `memberPrivateKey` off the
  control-network strand row. `strand-database.ts` contains **zero** references to the libp2p
  key or peerId. Every `ed25519PublicKeyB64FromPeerId` call site is a control-network path.
- `MemberPeer` rows — the only schema place a peerId is bound to a cadre identity — are never
  written by production code: `strand-member-registry.ts:129-146` explicitly defers supplied
  `peerIds` to the standalone `registerMemberPeer` writer, whose only callers are a test and
  the closed-strand integration scenario. So no persisted row names the old peerId.
- Cross-party strand formation exchanges `cadrePeerAddrs` (control addrs) and a placeholder
  `dbConnectionInfo`; it never assumes a strand peerId.
- Downstream in Optimystic, `libp2p-node-base.ts` feeds the node key into cluster-repo
  threshold signing and cohort-topic participant signing. Both verify against the *same*
  node's peerId-derived public key, so a derived key is self-consistent; neither cross-checks
  a cadre key.
- No peerId allowlist would reject the new identity: the `ops/` relay images set no
  reservation filter, and `cadre-host`'s NAT address-resolver and trust-circle are
  control-side only.

### Verified — derivation and launch-path correctness

- `digest()` from `@optimystic/quereus-plugin-crypto` is a *framed, injective* multi-field
  hash, and `sha256` yields exactly the 32 bytes `generateKeyPairFromSeed('Ed25519', …)`
  requires. Inputs are a fixed domain tag, a fixed-length base64url seed, and the strandId, so
  no two input tuples can frame to the same bytes. Deterministic and one-way as documented.
- `launchStrand` is the **only** `startStrand` caller, so no launch path bypasses the
  derivation. `resumeStrand` copies the retained launch config and overrides only
  `bootstrapNodes`/`mode`, so hibernate → wake keeps the same peerId; a
  `stopStrand` → re-launch re-derives the identical key.

### Verified — docs match the new reality

`docs/architecture.md:491` and `:670`, `docs/strands.md:85`, and the `strand-addr-protocol.ts`
header all now state the per-strand transport peerId and that authority stays on the control
key. A sweep for surviving "same peerId" / "shares one peerId" claims across `docs/`, all
package sources, and tests found none. `docs/STATUS.md` and `docs/reference-app-ns.md` were
checked and are still accurate — both talk about the *node identity* key, which is unchanged.
`docs/api.md` carries no module inventory needing an entry.

### Found and dispositioned

- **Test coverage gap (major → filed, not fixed here):** no test asserts that `launchStrand`
  itself hands `startStrand` a key whose peerId differs from the control node's — the wiring
  is a two-line change covered only by reading plus the unit tests on the helper. The existing
  `cadre-node-strand-seed.spec.ts` injection pattern makes this a cheap unit test (fake
  `strandManager`, injected `identityKey`, call the private `launchStrand`). Filed as
  `backlog/debt-launch-strand-transport-key-coverage`. Not fixed inline only because this
  review run hit its token budget mid-way through writing it.
- **Comment duplication (minor, accepted as-is):** the `launchStrand` comment restates part of
  the `strandTransportKey` module doc. Left in place — the call site needs enough context to
  explain why it is not passing `this.identityKey`, and the duplicated portion is two lines.
- **Doc-to-code ratio of `strand-transport-key.ts` (minor, accepted as-is):** ~40 lines of doc
  over 4 lines of body. Judged justified: it carries the bug it fixes, the
  determinism invariant, the secrecy rationale, and a tripwire. Not trimmed.
- **No security, resource-cleanup, or error-handling defects found.** Specifically: the
  derivation logs nothing and leaks no seed material; it adds one sha256 + one Ed25519 keygen
  per launch (negligible); a launch failure inside `handleStrandAdded` is already caught and
  surfaced as `strand:error`; the relay test's nodes are torn down in `afterEach`.

### Tripwires recorded (index — analysis lives at the sites)

- **New this pass:** a non-Ed25519 identity key now fails strand launch outright, where it
  previously started the strand on that key. Nothing reachable today hits it (Ed25519 is
  already required by every control-DB signing path), and the fallback if it ever matters is
  `undefined` — random per-strand key, collision still avoided, peerId stability given up.
  `NOTE:` at the derivation site in `cadre-node.ts` (`launchStrand`).
- Carried from implement: unattested strand transport peerIds — fine while strand nodes keep
  the raw configured gater; if strand-mesh admission control is added, bind via a `MemberPeer`
  row. Noted in the `strandTransportKey` doc comment.
- Carried from implement: control + strand nodes both receive `network.listenAddrs`, so a
  fixed-port config risks `EADDRINUSE`. `NOTE:` at the listen-addr assembly in
  `strand-instance-manager.ts` (`buildStrandRuntime`).

## Validation

- `yarn test` in `packages/cadre-core` re-run during review: **64 files, 974 passed, 1
  skipped** — the skip is the pre-existing `skipIf(win32)` in `key-store.spec.ts`, not a new
  one. No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.
- Lint, typecheck, and build were **not** re-run in this pass (budget); the implement stage
  reported all three clean, and the only source change made during review is a comment
  addition in `cadre-node.ts`.
- **End-to-end strand-over-relay in a real cadre is still unexercised.** The relay test uses
  bare libp2p nodes, not `createLibp2pNode`/`CadreNode`. The real-network integration
  scenarios are red at HEAD for an unrelated pre-existing cause
  (`tickets/.pre-existing-known.md`: `bug-control-db-stale-revision-not-retryable`, and
  `blocked/control-db-convergence-optimystic-p2p`), so a red integration run says nothing
  about this change. Deep per-strand NAT/relay reachability remains tracked in
  `backlog/strand-network-nat-relay-reachability`, which the implement stage updated to record
  that the identity half is now resolved.

## Outward-facing follow-up left for a human

GitHub issue #1 is **not** closed — commenting on a public issue is outward-facing and no
human was available during either run. Suggested close note: fixed by deriving each strand
node's transport peerId from the cadre identity key + strandId (`strandTransportKey`, sha256,
domain-separated, deterministic across restarts). The additive `strandNetwork` config override
proposed on the issue was deliberately not taken: it only helps when a *second* relay exists,
and the collision returns the moment both nodes reserve through one relay — distinct peerIds
cure it at any relay with no added config surface.
