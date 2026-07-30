---
description: Added automated tests proving that a cadre node's configuration (identity, storage, listen addresses, relay behaviour, etc.) actually reaches the underlying peer-to-peer networking layer, so a wiring mistake now fails a test instead of surfacing as a mysterious runtime problem.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts
---

# Test coverage: control-network node options

## What landed

`CadreNode.buildControlNodeOptions()` (`packages/cadre-core/src/cadre-node.ts:919`) is the
private, pure config→options mapping `createControlNode` hands to `createLibp2pNode`. It reads
only `this.config` and `this.identityKey`, so it is assertable without starting a real libp2p
node, opening a database, or touching the filesystem.

- New spec file `packages/cadre-core/test/cadre-node-control-node-options.spec.ts` gives that
  seam its own home, with a header comment explaining why it stays a pure unit test and which
  sibling specs own the semantics it deliberately does not re-test.
- The four pre-existing assertions (`clusterSize`, `clusterPolicy.allowDownsize`,
  `clusterPolicy.assumedClusterSize`, `networkName`) moved out of the tail of
  `cadre-node-control-replication.spec.ts`; that block and its now-unused imports
  (`createLibp2pNode` type import, `CONTROL_REPLICATION_BREADTH`, `DEFAULT_STRAND_CLUSTER_SIZE`)
  are gone from the replication spec.
- Every remaining option the mapping sets is now covered: `port`, `bootstrapNodes` (populated
  and empty), `storage` (factory called once with the literal `'control'`, instance
  passthrough, absent), `fretProfile` / `arachnode.enableRingZulu` (both profiles),
  `relay` (profile default both ways plus explicit override winning in each direction — proves
  `??` not `||`), `listenAddrs` (including the empty-array React Native case, asserted via
  `'listenAddrs' in options`), `transports`, the omission of both when `network` is absent
  entirely, `clusterPolicy.sizeTolerance`, `privateKey` (omitted on the ephemeral path,
  forwarded by identity for both `config.privateKey` and a keyStore-resolved key, stable across
  repeated calls), per-call object freshness, `connectionGater`, and `authorizeInboundStream`.
- Doc comment on `buildControlNodeOptions` now names the new spec file.

Production behaviour is unchanged; this was a test-only ticket apart from that doc-comment line
and one cosmetic consistency fix noted below.

## Review findings

### Checked

- **The implement diff, read before the handoff summary** — the one-line source doc-comment
  change, the 305-line new spec, and the 54-line deletion from the replication spec.
- **Every field the mapping sets, against every assertion in the spec.** All fourteen are
  covered; the plan ticket's table has no unclaimed row.
- **The deleted block's imports really were unused in the replication spec** — that spec
  typechecks and passes unchanged.
- **The sibling-ownership claims in the new file's header.**
  `membership-connection-gater.spec.ts`, `control-stream-authorization.spec.ts` and
  `cadre-node-identity.spec.ts` all exist and do own what the header defers to them.
- **The "dead fields" claim.** `NetworkConfig.announceAddrs` / `relayAddrs` are declared
  (`packages/cadre-core/src/types.ts:144-145`) and plumbed from cadre-cli env vars, but read
  nowhere — leaving them unasserted is correct, and
  `backlog/bug-cadre-network-announce-relay-addrs-ignored` exists as claimed.
- **Docs.** Nothing under `docs/` or any package README names either spec file or
  `buildControlNodeOptions`; the only cross-reference is the source doc comment, which the
  implementer updated correctly. No doc drift to repair.
- **The handoff's own stated gaps.** Both are now discharged — see *Validation*.

### Found and fixed in this pass (minor)

- **The membership admission wiring had no test at this seam.** The composed `connectionGater`
  carries `admitInbound: (id) => this.admitInboundControlConnection(id)` — the single most
  load-bearing wire in the mapping — and nothing exercised it. The existing gater tests only
  proved a gater is installed, that it is composed rather than passed through, and that a
  *caller's* non-inbound hook survives; a delegate wired to the wrong method would have passed
  all three. `membership-connection-gater.spec.ts` cannot catch it either, because it tests the
  factory with an injected policy. Added `routes the composed inbound-encrypted hook back into
  this node`: drives `denyInboundEncryptedConnection` on a bare node and asserts "not denied",
  symmetric with the `authorizeInboundStream` test that was already there. Policy still belongs
  to the gater's own spec.
- **A rationale comment was dropped in the move.** The original block explained *why* the
  breadth needs its own guard (nothing else fails if the constant stops being passed, and a
  narrower cohort reintroduces the never-converging read-repair case). Restored, trimmed, on
  the `cluster replication breadth` describe.
- **`cadre-node.ts:949` read `this.config.profile` while `profile` was already destructured**
  eleven lines above. Cosmetic inconsistency in the file under review; now uses the local.
  Behaviour-identical and covered by the profile tests.

### Major findings

None. No new tickets filed — the mapping has no unasserted branch left, and nothing in the diff
points at a defect in the production code it covers.

### Tripwires

None recorded. The candidates considered were the private-method casts (a rename would surface
as a runtime `TypeError` rather than a compile error) and the `createConfig` duplication across
the two spec files — the first is the repo-wide pattern for these specs and flagging it only
here would be noise, the second was explicitly settled in the plan ticket. Neither is a
"fine now, becomes work if X" condition.

## Validation

- `yarn workspace @serfab/cadre-core test` — **75 files, 1191 passed, 1 skipped**, exit 0. The
  skip is the known win32 `skipIf` in `key-store.spec.ts:231`. This closes the handoff's gap 1:
  the new spec had never been executed (the sibling `../quereus` build that blocked the
  implement run has since been repaired by the triage pass in `462b23b`). Touched and
  neighbouring specs also confirmed green in isolation — the new file, the trimmed replication
  spec, `membership-connection-gater`, `control-stream-authorization` and `cadre-node-identity`:
  105 passed.
- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn lint` (repo root) — exit 0, no output. This closes the handoff's gap 2.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` is absent (consumed by the
  earlier triage) and nothing new was written.
