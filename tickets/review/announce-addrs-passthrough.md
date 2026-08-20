----
description: A node setting that names the public address a node should tell peers about used to be ignored with a warning saying so; it now works, and a companion setting was added for the more common case of adding an address rather than replacing all of them.
files: packages/cadre-core/src/announce-addrs.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-announce-addrs-warning.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/cadre-core/test/strand-instance-manager-announce-addrs.spec.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/docker/entrypoint.sh, docs/architecture.md
----

# `network.announceAddrs` is wired through; `appendAnnounceAddrs` added alongside it

## What landed

`NetworkConfig.announceAddrs` now reaches libp2p on both node kinds, and a new
`NetworkConfig.appendAnnounceAddrs` sits beside it. Both map onto the
`@optimystic/db-p2p` `NodeOptions` fields of the same names (v0.24.0, already the
declared dependency range), which reach libp2p's `addresses.announce` /
`addresses.appendAnnounce`.

**New module** `packages/cadre-core/src/announce-addrs.ts` — `resolveAnnounceAddrs(network)`
returns the announce fields to spread into `createLibp2pNode` options. One module rather
than the same conditional spread in two places, because the control node
(`cadre-node.ts` `buildControlNodeOptions`) and every strand node
(`strand-instance-manager.ts` `buildStrandRuntime`) need identical treatment. It also
owns the two rules that are easy to get wrong: empty array means unset (key dropped, not
forwarded), and each entry is parsed up front so a typo fails loudly.

**The boot warning narrowed rather than disappeared.** It fires only when a non-empty
`announceAddrs` coexists with a circuit-relay listener, and names `appendAnnounceAddrs`
as the way out. Still exactly one `console.warn` in the library, honouring the existing
NOTE that a *second* one must go through `CadreNodeEvents` instead.

**Docs updated** in `cadre-core/src/types.ts`, `cadre-cli/src/config/types.ts` (both
sites), `docs/architecture.md`, plus two the ticket did not list but that carried the same
stale "not yet applied" claim: `cadre-cli/example.cadre.yaml` and `cadre-cli/README.md`.
No `dist/` was hand-edited.

## Two deviations from the ticket — please scrutinise both

### 1. The ticket's malformed-multiaddr premise was wrong, so validation was added

The ticket said: *"libp2p validates at construction and throws, so a typo becomes a node
that fails to start rather than one that silently misbehaves. Confirm which of the two it
is."* It is neither. Measured with a throwaway spec against a real `createLibp2pNode`
carrying `announceAddrs: ['not-a-multiaddr']`:

- node construction and start **succeeded**;
- `getMultiaddrs()` then threw `InvalidMultiaddrError: String multiaddr must start with "/"`;
- and an **unhandled** `InvalidMultiaddrError` escaped asynchronously — vitest reported it
  as an unhandled error, from the debounced peer-store update libp2p runs on
  `transport:listening`.

Cause, read in `node_modules/libp2p/dist/src/address-manager/index.js`: the constructor
stores announce addrs as raw strings (`announce.map(ma => ma.toString())`) and only parses
them on the first `getAnnounceAddrs()` (`multiaddr(a)`). So forwarding this field without
local validation would have shipped a knob whose typo mode is a node that starts, then
throws out of every address lookup — worse than either option the ticket weighed.

`announce-addrs.ts` therefore parses each entry at resolution time and throws naming the
config field and the offending value, mirroring what `relay-addrs.ts` already does for
`relayAddrs`. **This is scope the ticket did not authorise.** If a reviewer disagrees, the
alternative is to drop `validated()` and instead document the real failure mode — but the
doc comments as written claim "a malformed entry throws at node start", so they would need
to change with it.

### 2. `appendAnnounceAddrs` was made reachable from the CLI, not just from the library

The ticket's item 4 only asked to fix `cadre-cli/src/config/types.ts` doc comments. But the
new warning tells operators to use `appendAnnounceAddrs`, and the CLI is the configuration
surface the ticket's own background names ("settable three ways"). Advice pointing at a
field `cadre.yaml` cannot express is a dead end, so the field was added to both CLI config
types, to `ENV_MAPPINGS` as `CADRE_APPEND_ANNOUNCE_ADDRS` (comma-splitting is automatic —
`loader.ts` splits any var ending `_ADDRS`), to `docker/entrypoint.sh`, and to
`docker/docker-compose.yml`. `start.ts` already passes `config.network` straight through,
so nothing else was needed.

Judgement call, easily reverted if the reviewer wants the CLI surface held back.

## Also worth a reviewer's eye

**The warning trigger is broader than specified.** The ticket said "`announceAddrs` and
`relayAddrs` both non-empty". As implemented it keys off the *resolved* listen addrs
containing `/p2p-circuit`, which catches `relayAddrs` (folded in by `resolveListenAddrs`)
**and** a hand-written circuit entry in `listenAddrs` — the same reservation by the longer
route, with the same consequence. The message names both fields. If the reviewer prefers
the literal `relayAddrs`-only check, `warnIfAnnounceAddrsDiscardRelay` in `cadre-node.ts`
is the single site.

**The strand path turned out to be assertable without a real node.** The ticket offered an
out ("if it is only reachable through a real node start, say so"). It is not:
`strand-instance-manager-cluster-size.spec.ts` already establishes a mocked
`createLibp2pNode` pattern, and the new
`test/strand-instance-manager-announce-addrs.spec.ts` reuses it. Its double declares its
parameter (unlike the sibling specs') because the absence assertions need the recorded call
indexable.

**The warning spec moved off real node starts.** The old file started a real `CadreNode`
per case. Every case that now needs to warn also needs a relay configured, and libp2p
treats a circuit addr it cannot listen on as fatal — `relay.example.com` does not resolve,
so those starts reject. The matrix therefore runs `warnIfAnnounceAddrsDiscardRelay`
directly on a bare node via the private cast already used in
`cadre-node-control-node-options.spec.ts` (it reads only `this.config.network`, so it is
pure there). **One** test still pays for a real `start()` — asserting both the warning and
the expected rejection — so a refactor that drops the call site is still caught.

## Known gaps — this is a floor, not a finish line

- **Nothing proves a peer actually observes the announced address.** Every assertion stops
  at the config→`createLibp2pNode`-options boundary. That the option then does what the
  docs say is read from upstream source, not exercised. `integration-tests` was not
  touched; a real two-node check ("node announces X, peer's address book shows X") is the
  coverage that does not exist.
- **The warning's premise is source-read, not observed.** Verified precisely — libp2p's
  `getAddressesWithMetadata()` early-returns the announce set when non-empty, skipping
  transport addrs (which carry the `/p2p-circuit` listener), `appendAnnounce`, and observed
  addrs. Line-accurate, but nobody watched a node lose relay reachability.
- **`appendAnnounceAddrs` precedence is likewise unexercised** — "ignored while
  `announceAddrs` is non-empty" is upstream's documented and source-visible behaviour; the
  test only pins that this repo forwards both verbatim without merging.
- **The `entrypoint.sh` change is untested.** No shell-level harness covers that file; the
  new block was written to match the three beside it exactly.
- **Malformed-addr behaviour was measured on the control path only.** The strand spec
  asserts the same throw, but through the mocked `createLibp2pNode` — so it pins this
  repo's validation, not libp2p's reaction.
- The throwaway probe spec used to establish the malformed behaviour was deleted; nothing
  in the tree records that measurement except this handoff and the doc comment in
  `announce-addrs.ts`.

## Use cases to test against

- **Reverse proxy / DNS front (the common one).** `appendAnnounceAddrs:
  ["/dns4/mynode.example.com/tcp/4001"]` with a normal `listenAddrs` — node should advertise
  the public name *and* everything it already advertised. No warning.
- **Replace-everything.** `announceAddrs` with the same value and no relay — advertises only
  that. No warning.
- **The footgun.** `announceAddrs` + `relayAddrs` — one warning naming both fields,
  `/p2p-circuit`, and `appendAnnounceAddrs`; node still starts.
- **Same footgun by the long route.** `announceAddrs` + a `/p2p-circuit` entry written by
  hand into `listenAddrs` — same one warning.
- **Empty means unset.** `announceAddrs: []` alongside a relay — no warning, key absent from
  node options, relay reachability intact.
- **Typo.** `announceAddrs: ["not-a-multiaddr"]` — start fails naming the field and value,
  on the control node and on a strand start alike.
- **Strand inheritance.** Any of the above with strands running — the strand node's options
  carry the same announce fields as the control node's.
- **CLI surface.** `CADRE_APPEND_ANNOUNCE_ADDRS=a,b` splits on commas; the Docker entrypoint
  writes an `appendAnnounceAddrs:` block into the generated `cadre.yaml`.

## Validation run

```
yarn lint                                  # clean
yarn typecheck                             # clean (all workspaces + coverage checks)
yarn build                                 # clean
yarn workspace @serfab/cadre-core test     # 102 files, 1580 passed, 1 skipped
```

The one skipped test is pre-existing and unrelated. No pre-existing failures surfaced, so
no `.pre-existing-error.md` was written.
