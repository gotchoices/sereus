description: Added `cadre enroll add`, which tells a running owner node to admit a new machine and prints the seed that machine starts with, plus a start-up check on the new machine that refuses a seed minted for a different party.
architecture: docs/architecture.md#enrollment-flow-server-adds-drone
files: packages/cadre-cli/src/commands/enroll-add.ts, packages/cadre-cli/src/commands/admin-client.ts, packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/enroll-add.spec.ts, packages/cadre-cli/package.json, packages/cadre-cli/README.md, docs/architecture.md
----

# `cadre enroll add`: complete

## What shipped

An operator using only the CLI can grow a cadre past one machine:

```
cadre enroll create --output . --name node-b                                                  # new machine B
CADRE_STARTUP_TOKEN=… cadre enroll add "$(cat node-b.id)" --admin-port 7070 > node-b.seed   # owner A, running with --owner --admin-port 7070
cadre start -c cadre.yaml --identity-file node-b.key --pin-owner-key <owner key> --seed "$(cat node-b.seed)"   # B
```

- `src/commands/admin-client.ts`: `adminRequest(connection, method, path, body?)` unwraps the admin channel's `{ ok, data }` envelope or throws `AdminRequestError` (`unreachable` | `rejected`, with HTTP status and envelope code). The fetch function is injectable.
- `src/commands/enroll-add.ts`: validates the peer ID (Ed25519), each `--addr` (multiaddr, no comma, no trailing `/p2p/` of another peer), the port (`--admin-port`, else `CADRE_ADMIN_PORT`), the token (`--token-file`, else `CADRE_STARTUP_TOKEN`; never a flag value) and the timeout before any request. Then `GET /admin/identity` (refusing the owner's own ID) and `POST /admin/add-drone`. The bare seed goes to stdout (or a `--json` report); owner key, owner addresses, the new machine's required party ID and the "neither side can dial" warning go to stderr. Every failure exits 1 with a message naming the fix.
- It goes through the running owner's admin channel, not a second process opening the node's files, so the owner's membership gate learns of the new peer and admits it when it dials in.
- `start.ts`: `decodeSeedFor` decodes `--seed` before anything is created and fails start-up (exit 1) when it does not decode, names no party, or names a party other than `controlNetwork.partyId`.
- `enroll create` and `enroll register` now point at `cadre enroll add` instead of a signature flow / `cadre start --owner`.
- Docs: README "Add a Machine to the Cadre" section and env-table rows for `CADRE_STARTUP_TOKEN` / `CADRE_ADMIN_PORT`; `docs/architecture.md` enrollment-flow sentence and `@serfab/cadre-cli` component bullet.

The implementer ran a manual loopback check with real `dist/bin/cadre.js` processes (owner A plus joiner B): every failure path, a successful mint, a `--json` re-run, the party-mismatch refusal, and B joining with `✓ Seed applied` and appearing in A's authorized members with a live control connection. See `ticket(implement): cli-enroll-add-mints-a-seed`.

## Review findings

Read the full implement diff first, then `admin-server.ts` (the routes called), `CadreNode.addDrone`, `SeedBootstrapService.addDrone` / `authorizePeer`, `retainDialTarget`, the bootstrap-peer store and `start.ts` around the seed.

**Correctness — checked, two doc inaccuracies fixed, no code defects found.**
- The admin contract matches: `/admin/identity` returns `{ peerId, partyId }`, `/admin/add-drone` requires `dronePeerId` string and `droneMultiaddrs` string array, and the error codes the CLI maps (`not_authorized` 401, `not_ready` 503) are the server's. The CLI attaches the admin server only after the node has started, so `not_ready` from the CLI's own server means "seed bootstrap not initialized", i.e. not started with `--owner`; the advice "Restart it with --owner" is correct.
- `decodeSeedFor` runs after config resolution and before any store, server or node; its thrown error goes through the existing `Failed to start cadre node:` path. The cadre-core `NOTE:` it cites (`seed-bootstrap.ts`, `applySeed` never compares party IDs) exists and says what the comment claims.
- **Fixed (README):** "on its next control-cohort reconcile pass" was too strong. `CadreNode.addDrone`'s own doc says a pass already under way when the peer was added does not dial it, so the README now says to allow up to two passes (15 s each by default).
- **Fixed (README):** "Running `enroll add` again … changes nothing but mints a fresh seed" was inaccurate. `authorizePeer` does skip an existing row, but `CadreNode.addDrone` also calls `retainDialTarget`, and the bootstrap-peer store's `record` replaces that peer's addresses. The README now says a re-run with `--addr` replaces the address the owner dials.

**Tests — one added, none cut.**
- Added `decodeSeedFor` rows in `test/enroll-add.spec.ts` (and exported `decodeSeedFor` from `start.ts`): matching party → returned; other party → refusal naming both; no party → refusal; not a seed → refusal. This pins the joining side's party check, which the architecture sentence names and which nothing else enforces (`applySeed` never compares). The implementer had left it to the manual check only.
- Kept `buildEnrollAddReport` (the one real branch in the report: the unreachable warning, and not counting the new machine's own address as an owner's) and the four `describeAdminFailure` rows (they run through real `mintSeed` → `adminRequest` envelope parsing with only the transport stubbed, and each pins an operator-facing fix).

**Port precedence (`--admin-port` vs `CADRE_ADMIN_PORT`) — considered, left as is.** `enroll add` prefers the flag; `cadre start` and `cadre status` prefer the env var, but both of those give the flag a default value, so env-first is the only way their env var can take effect. `enroll add` has no default, so flag-first is possible and is what an operator who typed a port expects. The two differ only when both are set to different values, and the README env-table row states both orders. No ticket.

**Error handling / resource cleanup — checked.** Failures set `process.exitCode` and never call `process.exit`, so the piped seed is not truncated. The abort timer is cleared in `finally`. The per-request timeout covers the fetch up to response headers but not the `res.json()` body read; on a loopback channel returning a few-kilobyte JSON body that is not a practical hang, so no change and no tripwire.

**Type safety / DRY / modularity — checked, nothing to change.** No `any`; envelope data is cast to the route's declared shape at one site. `enroll-add.ts` (308 lines) is decomposed into small named functions. The second client of the admin envelope (cadre-host's `OwnerNodeClient`) is recorded as a `NOTE:` in `admin-client.ts` with its revisit condition (a third client).

**Security — checked.** The token is never accepted as a flag value; the channel is loopback only; the peer ID and addresses are validated locally before the owner signs anything; the owner's own ID is refused.

**Tripwires — none new.** The implementer's `NOTE:` at `--seed` (Windows command-line length limit; add `--seed-file` if cadres reach dozens of machines) stands. Related, and covered by the same revisit: PowerShell 5.1's `>` writes UTF-16, so a `.seed` file made that way on Windows and copied to Linux would not `cat` cleanly. The README's bash examples avoid it.

**Validation.** `yarn workspace @serfab/cadre-cli build` and `typecheck` pass, `yarn lint` exits 0, `yarn workspace @serfab/cadre-cli test`: 17 files, 245 tests, all pass.
