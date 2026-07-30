description: Added automated tests proving that a cadre node's configuration (identity, storage, listen addresses, relay behaviour, etc.) actually reaches the underlying peer-to-peer networking layer, so a wiring mistake now fails a test instead of surfacing as a mysterious runtime problem.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts
---

# Test coverage: control-network node options

## What was done

`CadreNode.buildControlNodeOptions()` (`packages/cadre-core/src/cadre-node.ts:919`) is the
private, pure config→options mapping `createControlNode` hands to `createLibp2pNode`. It reads
only `this.config` and `this.identityKey`, so it is testable without starting a real libp2p node,
opening a database, or touching the filesystem.

- Created `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` — a new spec file
  giving this seam its own home, with a header comment explaining the seam and why it stays a
  pure unit test.
- Moved the four pre-existing assertions (`clusterSize`, `clusterPolicy.allowDownsize`,
  `clusterPolicy.assumedClusterSize`, `networkName`) out of
  `cadre-node-control-replication.spec.ts`'s tail `describe('CadreNode control-network node
  options')` block into the new file verbatim, and deleted that block plus its now-unused
  imports (`createLibp2pNode` type import, `CONTROL_REPLICATION_BREADTH`,
  `DEFAULT_STRAND_CLUSTER_SIZE`) from the replication spec. The replication spec keeps its own
  local `createConfig` helper; the new file has its own (two-field factory, not worth sharing).
- Added coverage for every remaining option `buildControlNodeOptions` sets, per the plan ticket's
  table (see "Coverage added" below).
- Updated the doc comment on `buildControlNodeOptions` (`cadre-node.ts:911`) to point at the new
  spec file name instead of the replication spec.
- No production code changed beyond that one doc-comment line — this ticket was test-only.

## Coverage added (new file, `cadre-node-control-node-options.spec.ts`)

- **Cluster replication breadth** (4 moved assertions + new): `clusterSize` fixed at
  `CONTROL_REPLICATION_BREADTH` regardless of `strandClusterSize`; `clusterPolicy.allowDownsize`
  true, `assumedClusterSize` left at Optimystic's default (undefined); `networkName` scoped to
  `control-${partyId}`; `clusterPolicy.sizeTolerance` is `0.5`.
- **Storage**: factory provider called exactly once with the literal `'control'` (asserts the
  argument, not just the pass-through result); instance provider passed through by identity; no
  `storage` config ⇒ `options.storage === undefined`.
- **Profile-derived options**: both directions of `fretProfile` (`'core'`/`'edge'`) and
  `arachnode.enableRingZulu` (`true`/`false`) for `storage` vs `transaction` profiles.
- **Relay**: profile default both ways (`storage` → `true`, `transaction` → `false`), and an
  explicit `network.enableRelay` override winning over each default in both directions (proves
  `??`, not `||`).
- **Network passthrough**: `port` always `0`; `bootstrapNodes` forwarded element-for-element,
  and forwarded as `[]` (not `undefined`) when empty; `listenAddrs` forwarded including the
  empty-array React Native case (`'listenAddrs' in options'` is `true` with value `[]`);
  `transports` forwarded when configured; `transports`/`listenAddrs` both omitted (`in` check)
  when `network` is absent entirely, while `relay`/`connectionGater`/`authorizeInboundStream`
  still resolve correctly.
- **Identity**: ephemeral path (no keyStore, no privateKey) omits `privateKey` from the options
  object entirely (`'privateKey' in options'` is `false`, not `undefined`-valued); `config.privateKey`
  forwarded by identity once resolved; `InMemoryKeyStore`-resolved identity forwarded and stable
  across two `buildControlNodeOptions()` calls (mapping doesn't regenerate per call).
- **Object freshness**: two calls return distinct objects but equal scalar fields (guards against
  a cached mutable object landing in a field).
- **connectionGater**: always present even with no caller gater; composed rather than passed
  through untouched (`options.connectionGater !== callerGater`); a caller-supplied non-inbound
  hook (`denyDialMultiaddr`) is proven to actually run through the composed gater, not just
  reference-equal.
- **authorizeInboundStream**: present, a function, and admits (`true`) on a bare not-yet-started
  node — proves it's bound to `this` and delegates into
  `admitControlPeerUnconditionally`'s `!this._running` baseline. The gate's real policy is
  intentionally not re-tested here (owned by `control-stream-authorization.spec.ts`).

Deliberately **not** covered (by design, per the plan ticket): `NetworkConfig.announceAddrs` /
`relayAddrs` — nothing forwards them today and asserting "ignored" would cement the bug; tracked
by `backlog/bug-cadre-network-announce-relay-addrs-ignored`. Also not re-tested: the connection
gater's internal composition semantics (owned by `membership-connection-gater.spec.ts`) and
identity *resolution* semantics — keyStore-vs-privateKey precedence, first-run generation, corrupt
bytes, the mutually-exclusive error (owned by `cadre-node-identity.spec.ts`).

## Validation

- `yarn workspace @serfab/cadre-core typecheck` — **clean (exit 0)**, including the new spec file.
  This is the only verification this run completed; it does not go through the vitest
  global-setup build-freshness guard, so it does not prove the assertions pass at runtime.
- `yarn workspace @serfab/cadre-core test` — **could not run.** The suite's `global-setup.ts`
  fails up front with a stale-build error for the linked sibling `@quereus/quereus`
  (`C:\projects\quereus`), which currently has uncommitted, non-compiling edits from unrelated
  in-flight work (confirmed: `yarn workspace @quereus/quereus build` there fails on
  `src/runtime/emit/operand-comparator.ts` referencing a not-yet-exported
  `comparisonGroupIndices` from `comparison-coercion.ts`). This is the explicitly accepted
  failure mode documented in `test-harness/build-freshness.ts`'s own comment on
  `checkLinkedTarget` ("a sibling repo's own automation editing mid-run aborts this suite").
  Unrelated to this ticket's diff. Full detail recorded in `tickets/.pre-existing-error.md`.
- `yarn lint` — **not run** (session hit its token budget before reaching this step).

## Gaps for the reviewer

1. **The new spec file has never actually been executed.** Typecheck passing is a real but
   partial signal — it confirms the accessor casts, `IRawStorage`/`ConnectionGater` types, and
   assertion shapes all compile, but not that the assertions' expected values are correct at
   runtime (e.g. the exact `'in' in options` semantics, the composed-gater hook actually firing).
   **Before merging, re-run `yarn workspace @serfab/cadre-core test` once the sibling
   `../quereus` checkout is in a buildable state** (or from a machine without that in-flight
   edit) and confirm the new file's ~25 assertions are green, plus the trimmed
   `cadre-node-control-replication.spec.ts` still passes its remaining (non-moved) suites.
2. `yarn lint` was not run against the two touched/new test files. Worth a pass for the
   project's ESLint flat-config rules (unused-var edge cases, brace-on-case, etc. don't apply
   here, but it's unverified).
