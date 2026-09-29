description: Add a `cadre enroll add` command that tells a running owner node to admit a new machine and prints the seed that machine starts with, so an operator using only the CLI can grow a cadre past one node.
architecture: docs/architecture.md#enrollment-flow-server-adds-drone
files: packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/enroll-add.ts (new), packages/cadre-cli/src/commands/admin-client.ts (new), packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/admin-server.ts (read only — the route this calls), packages/cadre-cli/src/commands/status-query.ts (precedent for an injectable fetch), packages/cadre-cli/package.json, packages/cadre-cli/README.md, docs/architecture.md, packages/cadre-core/src/seed-bootstrap.ts (read only — `addDrone`, `createSeed`, `queryPeers`), packages/cadre-host/src/owner/owner-node-client.ts (read only — an existing client of the same admin channel)
----

# `cadre enroll add`: admit a machine and print its seed

## The gap

`cadre start --seed <encoded>` consumes a `ControlNetworkSeed` (see "Control Network Seed" in `docs/architecture.md`), but no CLI command produces one. And a seed alone is not enough: the new machine is only let in if the owner has also written a `CadrePeer` row for it. cadre-core already does both in one call — `CadreNode.addDrone({ dronePeerId, droneMultiaddrs })` authorizes the peer, then mints and encodes a seed — and cadre-cli already exposes that call on a running node as `POST /admin/add-drone` on the loopback admin channel (`src/server/admin-server.ts`). cadre-host is the only caller. This ticket adds the CLI verb.

## Decisions (settled — do not reopen)

**The command talks to the running owner node over its admin channel. It does not open the node's state itself.** The other owner-write commands (`strand remove`, `validation-key add`) use `withConnectedNode`, which boots a second `CadreNode` from the same config — same identity, same storage directory. That shape is wrong here, for a reason specific to this operation: the operator adding a second machine has, by definition, a solo owner node already running. A second process would commit the new `CadrePeer` row into the shared files while the running owner never learns of it, so when the new machine dials the owner, the owner's membership gate would still refuse it. Routed through the admin channel, the running owner performs the insert itself, and `addDrone`'s insert notifies the membership gate before the seed is returned. The cost: the owner must be started with `--owner --admin-port <p>` and `CADRE_STARTUP_TOKEN` set. The README states that as the precondition.

**The command does not choose the addresses in the seed.** `createSeed` projects every `CadrePeer` row. The owner's own row is its self-published record (`registerSelf` → `collectSelfAddrs` → the node's advertised libp2p addresses plus any live `/p2p-circuit` relay address). So what a joining machine can dial is whatever the owner advertises. On a LAN that is its listen addresses. Across a NAT the operator must set `network.appendAnnounceAddrs` (a forwarded public address) or configure a relay. The command prints the owner addresses the seed carries so the operator can see which case they are in. The README says so plainly. No private-address heuristic: printing the addresses is enough.

**Name: `cadre enroll add <peerId>`.** It pairs with `cadre enroll create`, which the new machine runs first to get its peer ID. It lives under `enroll` so the onboarding steps sit together. "drone" is internal vocabulary and stays out of the CLI surface.

## Operator flow this enables

```
# new machine B
cadre enroll create --output . --name node-b          # prints B's peer ID, writes node-b.key / node-b.id

# owner machine A (already running: CADRE_STARTUP_TOKEN=… cadre start --owner --admin-port 7070 -c cadre.yaml)
CADRE_STARTUP_TOKEN=… cadre enroll add "$(cat node-b.id)" --admin-port 7070 > node-b.seed
#   stderr names the party ID and owner key B must use, and the owner addresses in the seed

# machine B (config names the same controlNetwork.partyId)
cadre start -c cadre.yaml --identity-file node-b.key --pin-owner-key <owner key> --seed "$(cat node-b.seed)"
```

## Command specification

```
cadre enroll add <peerId>
  --addr <multiaddr>     the new machine's dialable address; repeatable, optional. Given → the owner also
                         dials the new machine (the NAT'd-owner case); omitted → the new machine dials the owner.
  --admin-port <port>    the owner node's admin port; falls back to env CADRE_ADMIN_PORT. Required (one or the other).
  --token-file <path>    file holding the admin bearer token (what `cadre start --startup-token-file` writes);
                         falls back to env CADRE_STARTUP_TOKEN. Never accepted as a flag value (it would show in `ps`).
  --timeout <ms>         per-request timeout, default 30000.
  --json                 structured result on stdout instead of the bare seed.
```

Host is fixed at `127.0.0.1`: the admin channel binds loopback only.

Sequence:

1. Validate locally, before any request. `<peerId>` must parse (`peerIdFromString`) and be `Ed25519` (every identity `enroll create` writes is Ed25519, and the `CadrePeer` row's public key is derived from the ID). Each `--addr` must parse as a multiaddr (`@multiformats/multiaddr`, which you add to `package.json` at cadre-core's `^12.5.1`). It must not contain `,`, because `CadrePeer.Multiaddr` stores a comma-joined list. If it ends in `/p2p/<id>`, that ID must be `<peerId>`. A trailing ID for another peer is refused by name, because the owner would otherwise drop the address silently in `normalizeDialAddrs`. Resolve the port and token; a missing or empty one is a usage error.
2. `GET /admin/identity` → `{ peerId, partyId }`. This checks connectivity and the token before any write, and supplies the party ID for the output. If `<peerId>` equals the owner's own peer ID, refuse: that is the operator pasting the wrong `.id` file.
3. `POST /admin/add-drone` with `{ dronePeerId, droneMultiaddrs }` → `{ seed, encodedSeed }`.
4. Report (below). Success exits 0; every failure exits 1.

### Output

- **stdout:** the encoded seed alone plus a newline, so `> file` and `$(…)` capture exactly what `--seed` takes. Under `--json`, stdout is instead `{ peerId, partyId, signerKey, ownerAddrs, encodedSeed, warnings }`.
- **stderr (human mode only):** what the new machine needs:
  ```
  ✓ Authorized <peerId> to join party <partyId>
    Owner key to pin:  <seed.signerKey>
    Owner addresses in this seed:
      - <addr> …            (or "(none)")
  On the new machine (its config must set controlNetwork.partyId: <partyId>):
    cadre start -c cadre.yaml --identity-file <its key> --pin-owner-key <signerKey> --seed <this seed>
  ```
- **Warning (both modes; in `warnings` under `--json`):** when no `isOwner` peer in the seed has any address AND no `--addr` was given, neither side can dial the other. Say so, and name the two fixes: set `network.appendAnnounceAddrs` / a relay on the owner, or re-run with `--addr`. This is the one real branch in the report.
- **Do not `process.exit` on the success path.** Set `process.exitCode` and return. On Windows and macOS a pipe write is asynchronous, so exiting straight after printing a multi-kilobyte seed into `$(…)` can truncate it (the same hazard the `NOTE` in `subcommand.ts` describes). Confirm the process still exits promptly after the fetch; if keep-alive sockets hold it open, send `connection: close`.

### Errors → operator guidance

The admin envelope is `{ ok: true, data }` / `{ ok: false, error: { code, message } }` (`admin-server.ts` `sendOk` / `sendError`). Map failures to messages that name the fix:

| Failure | Message must say |
| --- | --- |
| transport error (connection refused, timeout) | no admin channel on `127.0.0.1:<port>`; start the owner with `--owner --admin-port <port>` and `CADRE_STARTUP_TOKEN` |
| 401 `not_authorized` | the token does not match the one the owner node was started with |
| 503 `not_ready` | the node is not running as an owner (`addDrone` throws "Seed bootstrap service not initialized") — restart it with `--owner` |
| anything else | the server's `code` and `message` verbatim |

## Module shape

- `src/commands/admin-client.ts`: `adminRequest<T>(endpoint, method, path, body?, fetchImpl?, timeoutMs?)`. It unwraps the envelope or throws an `AdminRequestError` carrying `kind: 'unreachable' | 'rejected'`, the HTTP status and the envelope `code`. The fetch is injectable, the same way `status-query.ts` does it with `FetchLike`. It is a thin client of cadre-cli's own server, so it lives beside it. `// NOTE:` at the top: cadre-host's `OwnerNodeClient` speaks the same envelope; if a third client appears, one of them should become the shared one.
- `src/commands/enroll-add.ts`: the local validation, `buildEnrollAddReport(seed, peerId, partyId, addrsGiven)` (the pure part: owner addresses, signer key, warnings), the error-to-message mapping, and the command action.
- `src/commands/enroll.ts`: `.addCommand(enrollAddCommand)`. Also update `enroll register`'s closing text, which currently says membership is granted by `cadre start --owner`, to point at `cadre enroll add`.

## Joining side: reject a seed for the wrong party (`start.ts`)

`applySeed` never compares `seed.partyId` with the node's configured party (the `NOTE` in `seed-bootstrap.ts` `applySeed`). This command's output makes a mismatch easy to produce: an operator copying a seed onto a machine whose `cadre.yaml` names a different party. Decode `--seed` before `node.start()`. Fail startup (the existing `Failed to start cadre node:` path, exit 1) when it does not decode, or when `seed.partyId` ≠ `config.controlNetwork.partyId`, naming both IDs. Today a bad seed only prints `✗` and the node keeps running as if seeded. A configuration error that is detectable before anything starts should stop it. Update the `--seed` help text to name `cadre enroll add` as the source.

Add a `// NOTE:` at the `--seed` option: the seed rides the command line, and Windows caps a command line near 32K characters. Each seed peer is a few hundred bytes of JSON before base64. If cadres grow to dozens of machines, add a `--seed-file`.

## Docs

- `packages/cadre-cli/README.md`: a new "Add a Machine to the Cadre" section under Usage, after "Enroll New Peers". It covers the three-step flow above, the owner precondition (`--owner --admin-port` + `CADRE_STARTUP_TOKEN`), and the joiner's matching `controlNetwork.partyId`. It states which case each address setup serves: listen addresses work on a LAN; across a NAT, set `network.appendAnnounceAddrs` to a forwarded address, use a relay, or pass `--addr` so the owner dials out. It notes that re-running for the same peer is harmless and just mints a fresh seed. The ticket's interim "say it cannot be done" note is moot, since the command lands here.
- `docs/architecture.md` → "Enrollment Flow: Server Adds Drone": one sentence saying that from the CLI this flow is `cadre enroll add` on the owner, which drives `POST /admin/add-drone`, followed by `cadre start --seed --pin-owner-key` on the new machine. Do not restate the flow.

## Edge cases & interactions

- **Owner is solo (zero control connections)**: the normal case for this command. The `CadrePeer` insert commits local-only, and the write-while-alone queue re-issues it when the new machine connects. Nothing to add. Verify by inspection (`noteControlWrite` in `CadreNode.addDrone`).
- **Peer already authorized**: `insertCadrePeer` is idempotent on a present row, so re-running mints a fresh seed and changes nothing else. Verify by inspection; README line.
- **Own peer ID passed**: refused after `GET /admin/identity`. Verify by inspection.
- **Owner not started with `--owner`**: 503 → the `--owner` hint. Covered by the error-mapping test.
- **No admin channel / wrong port / wrong token / missing token file**: the unreachable and 401 rows, and the local usage error. Covered by the error-mapping test (the local usage error by inspection).
- **Malformed `--addr`, comma in `--addr`, `/p2p/` suffix naming another peer**: refused locally before any request. Verify by inspection. Each is a single guard.
- **Non-Ed25519 or unparsable peer ID**: refused locally. Verify by inspection.
- **Seed with no owner address and no `--addr`**: warning. Covered by the report test.
- **Piped stdout**: no `process.exit` on success. Verify by inspection, plus the manual run below.
- **Joiner config names another party / seed does not decode**: startup fails, naming both party IDs. Verify by inspection. It is a single comparison in `start.ts`.
- **Admin route's own validation** (`dronePeerId` required, `droneMultiaddrs` a string array): already pinned in `test/admin-server.spec.ts` → "add-drone route". Do not duplicate it.

## Tests

Two, in one new `test/enroll-add.spec.ts`. Nothing else: the admin route, `addDrone` and `applySeed` already have their own coverage.

- `buildEnrollAddReport`: a seed whose owner peer has addresses → `ownerAddrs` lists them, no warning. A seed whose owner peers have none, with `addrsGiven = false` → the unreachable warning. The same seed with `addrsGiven = true` → no warning.
- The error mapping: against a stub fetch, a transport rejection, a 401 envelope and a 503 `not_ready` envelope each yield a message containing their fix (`--admin-port`, token, `--owner`), and an unrecognised code passes its message through.

## Manual check (do it if it fits one foreground shell command; otherwise say so in the handoff)

Run two nodes on loopback with separate config files and state directories and `listenAddrs: ['/ip4/127.0.0.1/tcp/0']`. Start owner A with `--owner --admin-port` and a token. Run `cadre enroll create` for B, then `cadre enroll add` against A, then start B with `--seed --pin-owner-key`. Confirm B logs `Seed applied` and A's `GET /admin/authorized-members` lists B. Kill both, and remove the scratch directories non-recursively as `docs/testing.md` → "Scratch worktrees and clones" requires. Record the outcome in the review handoff.

## TODO

- Add `@multiformats/multiaddr` to `packages/cadre-cli/package.json` (`^12.5.1`), then `yarn install`.
- Write `src/commands/admin-client.ts` (envelope unwrap, `AdminRequestError`, injectable fetch, timeout).
- Write `src/commands/enroll-add.ts` (local validation, identity pre-check and self refusal, add-drone call, `buildEnrollAddReport`, error mapping, stdout/stderr/`--json` output, `process.exitCode` rather than `process.exit`).
- Register it in `src/commands/enroll.ts`; update `enroll register`'s closing text.
- `start.ts`: decode `--seed` before `node.start()`, fail startup on a decode failure or party mismatch, update the `--seed` help text, add the command-line-length `NOTE`.
- `test/enroll-add.spec.ts` with the two tests above.
- README "Add a Machine to the Cadre" section; one sentence in `docs/architecture.md` → "Enrollment Flow: Server Adds Drone".
- `yarn workspace @serfab/cadre-cli build`, its tests, `yarn lint`.
- Manual loopback check if practical; record the result either way.
