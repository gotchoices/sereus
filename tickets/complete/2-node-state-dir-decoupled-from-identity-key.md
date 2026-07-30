description: A node only kept its durable notes — which group members to dial, which owners it trusts — when its key happened to be stored in one particular format; that gap is closed so every node the CLI runs keeps those notes on disk regardless of its identity source.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/config/loader.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/contrib/cadre-node.service, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/README.md, packages/cadre-cli/test/protobuf-identity.spec.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-core/src/types.ts, docs/architecture.md, docs/cadre-host.md
---

# What landed

`ResolvedConfig` gained an always-set `nodeStateDir: string`
(`packages/cadre-cli/src/config/types.ts`), resolved once in `resolveConfig`
(`loader.ts:279-286`) with precedence: `CADRE_NODE_STATE_DIR` env >
`nodeState.dir` in the config file > the directory containing the config file.

`start.ts:142-159` now opens `FileTrustedOwnerStore` and
`FileBootstrapPeerStore` from `config.nodeStateDir` **unconditionally**.
Previously both were gated on `config.identityProtobufKeyFile` being set, so a
node configured with `identity.keyFile` or `identity.privateKeyHex` fell back to
in-memory stores and forgot its retained dial addresses and its trusted-owner
anchor on every restart. `identityProtobufKeyFile` is gone from
`ResolvedConfig`; nothing else read it.

Accepted relocation (flagged in the originating ticket, unchanged by this
review): `cadre-host`'s **owner** node's stores move from `<dataDir>/` (beside
`identity.key`) to `<dataDir>/orchestrator/owner/` (where its `cadre.json` is
written). That directory persists across owner restarts, and the owner
re-establishes its anchor itself (genesis key + operator pins), so the effect is
a one-time cold start. No migration, per "no backwards compat yet". Donated
nodes are unaffected in location — their `identity.key` and `cadre.json` already
share one workdir.

# Review findings

## Checked

Read the implement diff (`7179e55`) before the handoff summary. Traced
`nodeStateDir` from `resolveConfig` through `start.ts` into
`FileTrustedOwnerStore.open` / `FileBootstrapPeerStore.open` /
`writeFileAtomically`, and audited every deployment that runs `cadre-cli start`
for whether the resulting directory is writable and durable: the systemd unit +
install script (`contrib/`), the Docker image entrypoint
(`packages/cadre-cli/docker/entrypoint.sh`), `cadre-host`'s
`HostProcessOrchestrator` (owner + donated children), and `cadre-provider`'s
`DockerOrchestrator`. Also swept for stale claims about where these files live,
across `docs/` and cadre-core source comments, and ran lint + the cli and host
suites.

## Major — fixed in this pass

**The shipped systemd deployment could not write its node state at all.**
`contrib/cadre-node.service` hardens with `ProtectSystem=strict`,
`ReadOnlyPaths=/etc/cadre`, `ReadWritePaths=/var/lib/cadre`, and the install
script puts the config at `/etc/cadre/cadre.yaml` (root-owned dir, 755) while
the service runs as user `cadre`. With the state directory defaulting to the
config file's directory, both stores resolved to a read-only `/etc/cadre`. This
was *created* by this change: that install uses `identity.keyFile`, so before
the gate was removed no store opened and nothing was written. The failure is
deterministic, not a corner case — `initializeTrustedOwnerStore`
(`cadre-node.ts:797`) **awaits** `trust()`, so a node started with
`--pin-owner-key` / `CADRE_OWNER_KEYS` would have failed `start()` outright on
`EACCES`/`EROFS`, and one without pins would have failed on the first seed
(`seed-bootstrap.ts:796`, also awaited).
Fixed by adding `Environment="CADRE_NODE_STATE_DIR=/var/lib/cadre"` to the unit
file — beside the `ReadOnlyPaths` line that makes it necessary — so the state
lands in the writable, service-user-owned data directory that is already the
backup unit. Documented the knob in `example.cadre.yaml` (commented block) and
added the env var to the README's variable table.

Other deployments were verified fine and left alone: Docker resolves to
`/data/` (the volume, writable — and now durable where it previously was not);
`cadre-host` children resolve to their own workdir; `cadre-provider` containers
resolve to the image's working directory (writable layer, no volume — a
pre-existing durability gap for provider-hosted nodes, unchanged here).

**Manager-process env var could collapse all children into one state
directory.** `HostProcessOrchestrator.launchChild` spreads `...process.env` into
each child's environment and pins only a handful of vars, so a
`CADRE_NODE_STATE_DIR` set on the manager would override every child's config
and point owner + donated nodes at one directory. Same-party children there
would snapshot-clobber each other's `trusted-owners.<partyId>.json` /
`bootstrap-peers.<partyId>.json` (the single-writer limit already documented in
`FileBootstrapPeerStore`'s class comment). Fixed by pinning
`CADRE_NODE_STATE_DIR: workdir` among the fixed per-child vars — the same value
the cli would derive by default, stated explicitly so inheritance cannot change
it.

## Major — filed as a ticket

`tickets/backlog/debt-host-child-env-inheritance.md`: the inheritance problem
above is generic, not specific to the new var. `CADRE_PARTY_ID`,
`CADRE_STORAGE_PATH`, and `CADRE_IDENTITY_PROTOBUF` set on the manager likewise
override every child's per-child config file (wrong party, shared storage,
shared peer id). Pre-existing and wider than this ticket, so filed rather than
fixed here.

## Minor — fixed in this pass

Stale location claims, all now saying "the node's state directory": module and
interface comments in `packages/cadre-core/src/bootstrap-peer-store-file.ts`,
`bootstrap-peer-store.ts`, `trusted-owner-store-file.ts`,
`trusted-owner-store.ts`, and both `CadreNodeConfig` store fields in
`types.ts` — six sites that still read "next to the identity key", the exact
coupling this ticket removed. `docs/architecture.md:339` carries the same phrase
in the trusted-owner-anchor bullet and is corrected too. README gained a "Node
State" column in the Data Locations table plus a note that it must be writable
and belongs in backups.

Test gap closed: added `lets CADRE_NODE_STATE_DIR override an explicit
nodeState.dir` — the precedence the systemd unit now depends on, previously
asserted only for env-alone and file-alone.

## Tripwires

None recorded. The one candidate — that a relative `nodeState.dir` resolves
against the process working directory rather than the config file's directory —
is not conditional and not new: every path-shaped field in this config
(`storage.path`, `identity.keyFile`) behaves identically, so singling this one
out would misrepresent it as special. All shipped deployments pass absolute
paths.

## Deliberately not filed

No test asserts that `cadre-host`'s **owner** node's store files land in
`<dataDir>/orchestrator/owner/`, so a location regression there would not be
caught (the implementer flagged this). Left as-is: the owner and donated nodes
share one `launchChild` path, and
`packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts:264`
already asserts on the presence of `bootstrap-peers.*.json` /
`trusted-owners.*.json` in a child's workdir — a duplicate owner-side assertion
would cover the same mechanism at higher cost.

`nodeState.dir` is not validated beyond `path.resolve`. Consistent with every
other path field in this config; not a gap introduced here.

# Testing

- `yarn workspace @serfab/cadre-cli test` — 99 passed / 8 files (98 before this
  review's added case).
- `yarn workspace @serfab/cadre-host test` — 465 passed, 4 skipped (pre-existing
  skips, outside this diff).
- `yarn lint` — clean, exit 0.

Not run: the `cadre-host` donation integration test (real-network,
out-of-band). The systemd unit change is a declarative env line and is not
exercisable in CI.
