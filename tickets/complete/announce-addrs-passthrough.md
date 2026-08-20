description: A node setting that names the public address a node should tell peers about used to be ignored with a warning saying so; it now works, and a companion setting was added for the more common case of adding an address rather than replacing all of them.
files: packages/cadre-core/src/announce-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/announce-addrs.spec.ts, packages/cadre-core/test/cadre-node-announce-addrs-warning.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-announce-addrs.spec.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/docker/entrypoint.sh, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-provider/src/service/container-env.ts, docs/architecture.md
----

# `network.announceAddrs` is wired through; `appendAnnounceAddrs` added alongside it

## What landed

`NetworkConfig.announceAddrs` now reaches libp2p on both node kinds, and a new
`NetworkConfig.appendAnnounceAddrs` sits beside it. Both map onto the
`@optimystic/db-p2p` `NodeOptions` fields of the same names, which reach libp2p's
`addresses.announce` / `addresses.appendAnnounce`.

A new module `packages/cadre-core/src/announce-addrs.ts` owns the translation for both
the control node (`cadre-node.ts`) and every strand node (`strand-instance-manager.ts`),
plus the two rules that are easy to get wrong: an empty array means unset (key dropped,
not forwarded), and every entry is checked up front so a bad one fails loudly at start.

The old boot warning narrowed rather than disappeared: it fires only when a non-empty
`announceAddrs` coexists with a circuit-relay listener, and names `appendAnnounceAddrs`
as the way out. Still exactly one `console.warn` in the library.

`appendAnnounceAddrs` was also made reachable from the CLI — `cadre.yaml`,
`CADRE_APPEND_ANNOUNCE_ADDRS`, the Docker entrypoint and compose file — since the new
warning tells operators to use a field that would otherwise have no configuration
surface. Docs updated in `cadre-core/src/types.ts`, both `cadre-cli/src/config/types.ts`
sites, `docs/architecture.md`, `cadre-cli/example.cadre.yaml` and `cadre-cli/README.md`.

## Review findings

The implement-stage diff (`047db26`) was read before the handoff summary.

### Upstream premises — independently re-verified, all confirmed

The handoff rests three claims on reading upstream source rather than observing
behaviour, and its two acknowledged deviations from the original ticket both depend on
them. Each was re-checked against the installed packages:

- **libp2p does not validate announce addrs at construction.** `AddressManager`'s
  constructor stores `announce.map(ma => ma.toString())`; `getAnnounceAddrs()` parses
  with `multiaddr(a)` on every call. Confirmed at
  `node_modules/libp2p/dist/src/address-manager/index.js:59` and `:110`. So the ticket's
  original premise ("libp2p throws at construction, a typo is a node that will not
  start") was indeed wrong, and adding local validation — the first deviation — was the
  right call. Kept.
- **A non-empty announce set replaces everything.** `getAddressesWithMetadata()`
  early-returns the announce set when it is non-empty, never reaching transport addrs,
  `appendAnnounce`, observed addrs or IP/DNS mappings. Confirmed at `:255-268`. This is
  what the narrowed warning is about, and what makes finding 1 below serious.
- **`@optimystic/db-p2p@0.24.0` forwards both fields.** `libp2p-node-base.js:206-208`
  spreads them into `addresses.announce` / `addresses.appendAnnounce`. Confirmed against
  the resolved dependency, which is a `link:` to the sibling workspace.

The second deviation — adding `appendAnnounceAddrs` to the CLI surface rather than only
fixing its doc comments — was also kept. A warning that recommends a field an operator
cannot set is a dead end, and the wiring is mechanical (`ENV_MAPPINGS`, and `loader.ts`
already comma-splits any var ending `_ADDRS`, trimming and dropping empties).

### Found and fixed in this pass (minor)

1. **A blank announce entry passed validation and silently unadvertised the node.**
   `multiaddr('')` and `multiaddr('/')` both *parse* — each yields a component-less
   multiaddr that stringifies to `/` — so `announceAddrs: [""]` survived the new
   `validated()` check, reached libp2p as a **non-empty** announce set, and by the
   replacement rule above became the node's only advertised address. Measured directly
   against `@multiformats/multiaddr`. The env-var and Docker-entrypoint routes both drop
   empty entries already, but a hand-written or templated `cadre.yaml` whose address
   variable went unsubstituted produces exactly this and is the realistic way in.
   `announce-addrs.ts` now rejects any entry with zero multiaddr components, alongside
   one that fails to parse; the module doc and `NetworkConfig` doc comments now
   distinguish an empty *array* (means unset) from an empty *entry* (rejected).

2. **A comment in `strand-instance-manager.ts` asserted the opposite of the truth.** The
   new announce block claimed the control and strand nodes are "fine while the two differ
   only by port (both bind port 0)". They do not both bind port 0 — the pre-existing
   `NOTE:` six lines above says a fixed `listenAddrs` port has them race for it — and
   differing by port is precisely what makes an announce address carrying a port wrong
   for the strand node. Replaced with an accurate `NOTE:` that states the real
   consequence, why it is currently unreachable, and where it is tracked.

3. **The boot warning was called outside `start()`'s `try`.**
   `warnIfAnnounceAddrsDiscardRelay` calls `resolveListenAddrs`, which throws on a
   malformed `relayAddrs` entry — so with `announceAddrs` set, that one failure escaped
   without the `log(...)` and `cleanup()` every other start failure gets. Harmless today
   (nothing has been installed that early, so `cleanup()` is a no-op) but an asymmetry
   with no upside. Moved inside the `try`, still ahead of any libp2p bring-up.

4. **The new module had no direct unit spec** while its sibling `relay-addrs.ts` has one
   with 19 tests — the two consumers' specs pin what a node's *options* carry, not the
   module's own rules. Added `packages/cadre-core/test/announce-addrs.spec.ts` (20 tests)
   over both exported functions: entry order and duplicates preserved, entries forwarded
   verbatim rather than normalized, empty-array-vs-blank-entry (the finding-1 regression,
   both fields, both `''` and `'/'`), a bad entry at a non-first position, leading
   whitespace, and an agreement check between `replacesAdvertisedAddrs` and
   `resolveAnnounceAddrs` so the warning and the forwarding cannot drift on what "set"
   means.

### Found and filed (major)

5. **A strand node's addresses are the control node's, verbatim.** A strand node is built
   from the same `network` block as the control node, so it inherits both the addresses it
   binds and now the addresses it advertises. Neither is right for a second node on one
   machine: a fixed `listenAddrs` port has the strand node try to bind a port the control
   node already holds, and a public announce address carrying a port has every strand node
   advertise the *control* node's address — with `announceAddrs` that bad address is the
   only one it publishes, so the strand node becomes undialable. The second half is latent
   rather than live (the bind collision stops the node first) but it is latent behind
   exactly the fix the first half needs, so the two must be solved together.
   `tickets/backlog/strand-network-nat-relay-reachability.md` already claims that site and
   already owns "what addresses does a strand node have and publish", so this was appended
   there as an arm rather than filed as a new ticket. A `NOTE:` at the code site points
   at it.

### Recorded as tripwires, not tickets

6. **Neither managed runtime can pass an announce address to a child node.**
   `cadre-provider`'s `buildNodeEnv` is a closed list, and `cadre-host` scrubs every
   `CADRE_*` var from the parent env while building `extraEnv` only from
   `pinnedOwnerKeys`. So a tenant or managed node advertises only the port assigned to it,
   and the new warning's advice is unactionable there. Genuinely conditional — fine while
   those nodes are reached at their published port or through a relay, and if it ever does
   matter, *who* supplies the address is a design question (the provider knows the port
   mapping; the tenant knows the DNS name), not a mechanical passthrough. `NOTE:` at both
   sites.

### Checked, nothing found

- **Config surfaces.** Swept every place `listenAddrs` appears for a mirror that needed
  the new field: `ENV_MAPPINGS`, `loader.ts` (`_ADDRS` split trims and drops empties),
  `entrypoint.sh` (new block matches the three beside it; `set -e` not `set -u`, so an
  unset var is fine), `docker-compose.yml`, `start.ts` (passes `config.network` straight
  through), `loader.ts:319` (passes the whole `network` block, no key whitelist to update).
  No other yaml or env surface mirrors these fields.
- **Stale docs.** Grepped the tree for the old "not yet applied" / "not yet supported" /
  `announce-addrs-option` claims. The only survivors are a completed-ticket archive and
  the warning spec's assertion that the string does *not* come back. `cadre-core/README.md`
  shows a `network` block but never mentioned this field, so it had nothing stale to fix.
- **Error-path placement in the strand manager.** `resolveAnnounceAddrs` is evaluated
  inside `buildStrandRuntime`'s `try`, so a rejected entry gets the existing
  `releaseRuntime` cleanup. (`resolveListenAddrs` sits outside it — pre-existing, not
  touched.)

### Considered and deliberately not filed

- **The one real-`start()` test dials `relay.example.com`.** It touches DNS and TCP inside
  a unit suite on a 30 s budget. Kept as written: the `failed to be listened on` arm of its
  regex is libp2p's transport-manager message for a circuit addr it cannot listen on, which
  is the outcome regardless of how DNS resolves, and this test is the only thing pinning
  that `start()` still calls the warning at all.
- **`listenAddrs` gets no validation** while `announceAddrs` and `relayAddrs` both do.
  Real, but pre-existing and outside this diff.
- **Announce entries are not deduplicated** the way `relayCircuitAddrs` dedupes relay
  entries. libp2p puts them in a `Set` anyway, and forwarding the operator's list verbatim
  is intentional and now pinned by a test.

### Gaps still open

Carried forward from the handoff, unchanged — none were closed in this pass:

- Nothing proves a *peer* observes the announced address. Every assertion stops at the
  config → `createLibp2pNode`-options boundary; `integration-tests` was not touched. A real
  two-node check ("node announces X, peer's address book shows X") is the coverage that
  does not exist.
- `appendAnnounceAddrs` precedence under a non-empty `announceAddrs` is upstream-verified
  by source only; the local tests pin that this repo forwards both verbatim without merging.
- The `entrypoint.sh` change has no shell-level harness.

## Validation

```
yarn lint                                   # clean
yarn typecheck                              # clean (all workspaces + coverage checks)
yarn build                                  # clean
yarn workspace @serfab/cadre-core test      # 103 files, 1600 passed, 1 skipped
yarn workspace @serfab/cadre-cli test       # 16 files, 210 passed
yarn workspace @serfab/cadre-host test      # 65 files, 601 passed, 4 skipped
yarn workspace @serfab/cadre-provider test  # 27 files, 201 passed
```

The one skipped cadre-core test is pre-existing and unrelated. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written. An editor-only TypeScript hint about
an unread `cfg` property at `host-process-orchestrator.ts:136` is pre-existing, untouched
by this diff, and not flagged by `yarn lint` or `yarn typecheck`.
