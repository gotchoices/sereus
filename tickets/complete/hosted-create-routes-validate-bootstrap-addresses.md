description: The two services that start a node for someone now check the list of peer addresses the new node is told to dial, so a mistyped or undialable address comes back as a clear error instead of a node that quietly fails later on someone else's machine.
files: packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/README.md, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts, packages/cadre-host/src/server/routes/provision-request-validation.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/README.md, docs/cadre-host.md, docs/architecture.md
----

# `bootstrapNodes` validated at both hosted-create boundaries

`POST /containers` (cadre-provider) and `POST /grants` (cadre-host) each run their
**whole** request body through one validator that returns the typed request object.
A field can now only reach a spawned child by having been through that function;
adding a field to `CreateContainerRequest` / `DonationProvisionRequest` without
validating it stops compiling.

## The address rule (identical on both sides)

An entry is accepted when it is a string, trims to non-empty, parses as a multiaddr,
carries at least one `/p2p/<peerId>` component, every such component decodes via
`peerIdFromString`, **and the address names somewhere to reach the peer** (at least
one component that is not `p2p` or `p2p-circuit`). Anything else is a 400 naming the
offending entry (`INVALID_REQUEST` on the provider, `invalid_request` on the host),
with nothing provisioned.

Each clause is a different node failure the caller would otherwise never be told
about: unparsable kills the child at boot; no `/p2p/` is silently dropped by
`@libp2p/bootstrap` so the node comes up alone; a truncated peer id throws inside the
child; and an address of nothing but peer ids has no transport to dial, so the node
holds a bootstrap peer it can never reach. Reachability is deliberately not checked,
and neither is *which* transport: the child's transport set is the embedder's choice
(`NetworkConfig.transports`), invisible from the boundary, so a partial address like
`/ip4/1.2.3.4/p2p/<peerId>` is accepted and left to the child.

The two copies (`cadre-provider/src/server/bootstrap-node-validation.ts`,
`cadre-host/src/server/routes/bootstrap-node-validation.ts`) are kept identical by
hand — each package's `__tests__/bootstrap-node-validation.test.ts` pins its own copy
to the same accept/reject table, and each module comment points at the other.

## Also validated at the same boundary

Provider: `partyId` (non-blank string, stored trimmed), `profile` (enum — previously
forwarded unchecked), `strandFilter` (string), `resources` (object; string
`memoryLimit`/`cpuLimit`, finite `storageQuotaBytes` — limit *formats* stay
`DockerOrchestrator`'s business), `tags` (object of strings), and a non-object body
(previously a 500). Host: `partyId` (now trimmed), `ownerKeys` container shape,
`profile`. The Ed25519 rule for `ownerKeys` deliberately stays in
`DonationService.provision`, which the respawn path also reaches.

Dependencies added: `@multiformats/multiaddr@^12.5.1` + `@libp2p/peer-id@^6.0.4`
(provider), `@multiformats/multiaddr@^12.5.1` (host). No workspace deps, no libp2p
networking stack.

## Review findings

### Fixed in this pass

- **The rule accepted an address that names only peer ids.** `/p2p/<peerId>` — and
  `/p2p/<relay>/p2p-circuit/p2p/<target>` — parses, carries a decodable peer id, and
  survives `@libp2p/bootstrap`'s filter, so it was accepted; libp2p then finds no
  transport for it and the dial fails with no valid addresses. That is precisely the
  quiet "node comes up and never joins" failure the ticket exists to prevent, left
  open in a narrower form. Added a fourth clause to both copies (at least one
  component that is neither `p2p` nor `p2p-circuit`), plus two rows in each package's
  accept/reject table — one rejecting both no-location shapes, one **accepting**
  `/ip4/1.2.3.4/p2p/<peerId>` so the deliberate transport-agnosticism is pinned rather
  than assumed — plus the shape in each route-level "provisions nothing" sweep, and
  the clause in both docs. This does not affect the real-network scenarios: they build
  addresses from a listening node's `getMultiaddrs()`, which always carry a location.
- **`packages/cadre-provider/README.md` was left stale.** It carries a full
  subsection on the `pinnedOwnerKeys` rule and said nothing about `bootstrapNodes`,
  and its two `POST /containers` examples used `"bootstrapNodes":["..."]`, which the
  new rule answers 400. Added a section covering the address rule and the other body
  checks, with a valid example.
- **`packages/cadre-host/README.md` step 4** said "bootstrap addresses" with no
  shape; now says what a valid one looks like and that a bad one is refused before
  anything is spawned.
- **The fixture the handoff flagged and left behind.**
  `packages/cadre-host/src/__tests__/orchestrator.test.ts` (2 sites) used
  `/ip4/127.0.0.1/tcp/4001` — below the validated boundary, so it passed, but it
  taught a shape that was never dialable. Now a real peer id, like the rest.

### Checked, nothing to fix

- **The two claims the handoff rests on, both re-verified.** `@libp2p/bootstrap`'s
  constructor does map `multiaddr()` over the list before filtering and calls
  `peerIdFromString` unguarded (read at
  `../optimystic/packages/db-p2p/node_modules/@libp2p/bootstrap/dist/src/index.js:53-80`).
  The `P2P.matches` probe returns `true` for *every* address tried — including
  `/ip4/1.2.3.4/tcp/4001` with no `/p2p/` component at all — so the matcher clause is
  a strict no-op and the decision not to add `@multiformats/multiaddr-matcher` is
  sounder than the handoff argued.
- **The two copies are still identical.** Re-ran the strip-and-diff command from the
  handoff after every edit: byte-identical modulo comments and the `debug` namespace.
- **Boundary coverage.** `bootstrapNodes` enters these two packages at no other route
  (grep over both `src/` trees); every field of `CreateContainerRequest` and
  `DonationProvisionRequest` is now constructed by the validator. The respawn path
  replays a persisted record and is deliberately not re-validated — a record written
  before this change stays respawnable, which is the same call `provision` already
  makes for `ownerKeys`.
- **Duplication (DRY), considered and not filed.** ~95 lines of rule duplicated
  across two packages. Deliberate and documented in-module: cadre-provider declares
  no `workspace:` dependencies, the same reason `owner-key-validation.ts` restates
  cadre-core's Ed25519 rule. Moving the rule into cadre-core would not reduce the copy
  count (provider still could not import it), so there is no higher rung to climb
  here; the per-package tripwire tests are the mitigation. The general "two hand-synced
  copies" class already has a ticket for another pair
  (`backlog/debt-ice-config-two-hand-synced-copies`).
- **Test-server cleanup, considered and not filed.** The new route suites call
  `server.stop()` at the end of each test rather than in `afterEach`, so a failing
  assertion leaks a server. That is the existing house style in this directory
  (`create-container-owner-keys.test.ts`, `shutdown-after.test.ts`), the servers
  listen on port 0 under a mock orchestrator, and no run hangs. Changing it here alone
  would make the file inconsistent with its neighbours.
- **Comment-to-code ratio, considered and kept.** Each copy is ~74 lines of module
  header over ~95 lines of code. The header is what makes the rule reviewable — it
  records `@libp2p/bootstrap` behaviour that is not visible from this repo — and it
  matches the shape of `owner-key-validation.ts`. Trimmed only where the new clause
  made a sentence wrong.
- **The docs paragraphs are enormous run-ons.** `docs/architecture.md` § "Delivery and
  trust are separate gates" is now a single ~400-word paragraph, and
  `docs/cadre-host.md`'s new paragraph is similar. Pre-existing style in both files;
  not restructured as part of this ticket.

### Not covered, and why

- **No test proves a good address produces a node that actually joins.** The two
  scenarios that would (`provider-seed-accepted.integration.ts`,
  `cadre-host-node-donation.integration.ts`) are real-network and long, and were not
  run — the same deferral the implementer made. What was verified statically is that
  both build their addresses with `withPeerId(...)` over a live node's
  `getMultiaddrs()`, so every clause of the rule, including the one added in review,
  is satisfied by construction.
- **The 192-character echo cap boundary is untested**; only that a 5000-character
  value is capped.
- **No tripwires filed.** The one residual gap worth parking — an address this
  validator accepts that the child still cannot dial — was closed as a real defect
  above rather than parked, and the remainder (which transport the child supports) is
  not knowable at this boundary and is stated in the module comment as such.
- **No new tickets filed.** Every finding was either a few lines at a named site or an
  already-documented deliberate tradeoff; nothing left a class of defect behind.

## Validation

`yarn workspace @serfab/cadre-provider typecheck` + `test` (28 files, 222 tests),
`yarn workspace @serfab/cadre-host typecheck` + `test` (67 files, 626 passed /
4 pre-existing skips), `yarn lint` — all green. No pre-existing failures surfaced.

**Build order note:** cadre-host's stale-build guard covers cadre-provider's `dist`,
so editing cadre-provider `src/` fails cadre-host's suite until
`yarn workspace @serfab/cadre-provider build` is run. Not obvious from either
package's own config.

**Environment note (not a code finding):** `yarn install` reports
`YN0009: cpu-features@npm:0.0.10 couldn't be built successfully` — an optional native
dependency of `ssh2` → `dockerode` needing an MSVC toolchain this Windows box lacks.
Install completes and all suites pass. Pre-existing, not caused by this work.
