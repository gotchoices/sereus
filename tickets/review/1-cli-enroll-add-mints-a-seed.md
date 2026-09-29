description: Review the new `cadre enroll add` command, which tells a running owner node to admit a new machine and prints the seed that machine starts with, plus the matching start-up check that refuses a seed minted for a different party.
architecture: docs/architecture.md#enrollment-flow-server-adds-drone
files: packages/cadre-cli/src/commands/enroll-add.ts (new), packages/cadre-cli/src/commands/admin-client.ts (new), packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/enroll-add.spec.ts (new), packages/cadre-cli/package.json, packages/cadre-cli/README.md, docs/architecture.md, packages/cadre-cli/src/server/admin-server.ts (read only — the routes called), packages/cadre-host/src/owner/owner-node-client.ts (read only — the other client of the same channel)
----

# `cadre enroll add`: review handoff

## What landed

An operator using only the CLI can now grow a cadre past one machine:

```
cadre enroll create --output . --name node-b                                   # new machine B
CADRE_STARTUP_TOKEN=… cadre enroll add "$(cat node-b.id)" --admin-port 7070 > node-b.seed   # owner A, already running with --owner --admin-port 7070
cadre start -c cadre.yaml --identity-file node-b.key --pin-owner-key <owner key> --seed "$(cat node-b.seed)"   # B
```

- **`src/commands/admin-client.ts`**: `adminRequest<T>(connection, method, path, body?)`. It unwraps the admin envelope `{ ok, data }` or throws `AdminRequestError` with `kind: 'unreachable' | 'rejected'`, the HTTP status and the envelope code. The fetch function and timeout are fields of `AdminConnection`; the fetch is injectable, the same seam as `status-query.ts`. It carries the `NOTE:` about cadre-host's `OwnerNodeClient` speaking the same envelope.
- **`src/commands/enroll-add.ts`** does the following:
  - Local validation before any request. The peer ID must parse and be Ed25519. Each `--addr` must be a multiaddr with no comma and no trailing `/p2p/` of another peer; the last check reuses cadre-core's `withTrailingPeerId`, the owner's own rule. The port comes from `--admin-port`, falling back to `CADRE_ADMIN_PORT`. The token comes from `--token-file`, falling back to `CADRE_STARTUP_TOKEN`; it is never accepted as a flag value. The timeout defaults to 30000 ms.
  - `mintSeed`: `GET /admin/identity`, which refuses the owner's own peer ID, then `POST /admin/add-drone`.
  - `buildEnrollAddReport`: owner addresses, signer key, and the "neither side can dial" warning.
  - `formatEnrollAddReport`: the stderr text.
  - `describeAdminFailure`: maps each failure to a message naming its fix.
  - Output: the bare seed on stdout (or the `--json` report) via `process.stdout.write`. On failure it sets `process.exitCode = 1`; it never calls `process.exit`.
- **`enroll.ts`** registers `add`. It also rewrites the closing text of `enroll register` and the "Next steps" of `enroll create`, which pointed at a signature flow and at `cadre start --owner`; both now point at `cadre enroll add`.
- **`start.ts`**: `decodeSeedFor(encoded, partyId)` runs right after config resolution, before any store, server or node is created. Start-up fails through the existing `Failed to start cadre node:` path, exit 1, when the seed does not decode, names no party, or names a party other than `controlNetwork.partyId`; the message names both party IDs. The `--seed` help text now names `cadre enroll add`. There is a `NOTE:` at `--seed` about the Windows command-line length limit and adding `--seed-file` if cadres grow to dozens of machines. A seed that decodes but then fails `applySeed` (for example, no pinned owner key) still only prints `✗` and keeps running. That is unchanged and outside this ticket.
- **Docs**:
  - README: a new "Add a Machine to the Cadre" section (the three steps, the owner precondition, the matching party ID, which address setup serves LAN / owner behind NAT / `--addr`, and that re-running is harmless), plus env-table rows for `CADRE_STARTUP_TOKEN` and `CADRE_ADMIN_PORT`.
  - `docs/architecture.md`: the one sentence in "Enrollment Flow: Server Adds Drone". It also has a new `cadre enroll add` bullet in the `@serfab/cadre-cli` component summary, which records why the command goes through the admin channel and the joining side's party check, and the stale "membership is granted by `cadre start --owner`" line there is updated.

## Tests added

`packages/cadre-cli/test/enroll-add.spec.ts`:

- `buildEnrollAddReport › lists owner addresses, and warns only when neither side has anything to dial`: owner with addresses → listed, no warning. Owner with none and no `--addr` → one warning naming `appendAnnounceAddrs` and `--addr`. The same seed with `--addr` given → no warning. The new machine's own (non-owner) address is not counted as an owner address.
- `describeAdminFailure › <case>` (four `it.each` rows): each case runs through the real `mintSeed` → `adminRequest` with a stub fetch. A transport rejection (ECONNREFUSED on `cause`) → message includes `--admin-port 7070`. A 401 `not_authorized` → names `CADRE_STARTUP_TOKEN`. A 503 `not_ready` → says `--owner`. An unrecognised `internal` code → `[internal]: <message>` passed through.

Nothing else was added: the admin route, `addDrone` and `applySeed` already have coverage, and the start-up party check is one comparison.

## Validation run

- `yarn workspace @serfab/cadre-cli build` and `typecheck` both pass; `yarn lint` is clean. `yarn workspace @serfab/cadre-cli test`: 17 files, 241 tests, all pass.
- The `@serfab/cadre-core` `dist` was stale against an already-committed `src/fs-atomic.ts` change, and the stale-build guard refused to run. cadre-core is in this repo, not a sibling, so I rebuilt it (`yarn workspace @serfab/cadre-core build`).
- **Manual loopback check: done, 13/13 checks passed.** The script is in the session scratchpad, not committed. It ran real `dist/bin/cadre.js` children: owner A with `--owner --admin-port <random> --startup-token-file`, joiner B, both on `/ip4/127.0.0.1/tcp/0` with file storage and separate directories. Observed:
  - Wrong port → `No admin channel answered on 127.0.0.1:<port> (fetch failed: connect ECONNREFUSED …). Start the owner node with --owner --admin-port <port> …`, exit 1.
  - Wrong token → the token message, exit 1. Owner's own ID → refused, exit 1. `--addr …/p2p/<owner id>` → refused locally, exit 1. No token → usage error, exit 1.
  - `enroll add … --token-file <file A wrote>` → exit 0 in about 1.4 s, including Node start-up. Stdout, read through a pipe, was exactly one line: a 724-character seed that decodes to the right party. Stderr showed the owner key and A's one `127.0.0.1` address.
  - `--json` re-run for the same peer → a valid report and exit 0 (the re-run is harmless).
  - `cadre start --seed <seed>` with a config naming another party → `Failed to start cadre node: --seed was minted for party X, but this node's config names party Y …`, exit 1. `--seed not-a-seed` → `does not decode`, exit 1.
  - B started with `--pin-owner-key <signerKey> --seed <seed>` → `✓ Seed applied: 1 peers added`. A's `GET /admin/authorized-members` listed B. A's `GET /admin/strands` reported `controlConnections=1`, so the running owner's membership gate admitted B. That is the reason this command goes through the admin channel.
  - Scratch directories were left in the session scratchpad, outside the repo. They hold no `node_modules` or junctions.

## Where I departed from the ticket, and why

- **`connection: close` is not sent.** The ticket said to send it only if keep-alive sockets delay exit. I measured a fetch-only child process against a loopback HTTP server: it exited in 77 ms with the header and 71 ms without, and the server saw `keep-alive` on the second. Node's fetch does not hold the process open, so the header would have come with a false comment.
- **`adminRequest` signature**: the ticket specified `(endpoint, method, path, body?, fetchImpl?, timeoutMs?)`; I used `(connection, method, path, body?)` with the fetch and timeout inside `AdminConnection`, to avoid two trailing optional positional parameters after an optional body.
- **`buildEnrollAddReport(minted, peerId, addrsGiven)`** takes the party ID from the seed, not from `/admin/identity`. The two are the same value, but the seed's is what the joiner's new start-up check compares against. `/admin/identity` is still called first, for the connectivity and token check and the self refusal.

## Things for the reviewer to look at

- **Port precedence is inconsistent between commands.** `enroll add` prefers `--admin-port` over `CADRE_ADMIN_PORT`, as the ticket specified. `cadre start` (pre-existing) prefers the env var over the flag. Both are documented in the README env table. Decide whether that is worth aligning.
- **The `--addr` path, where the owner dials out, was not exercised end to end.** Only its local validation and its effect on the warning are covered. The README says the owner dials on its next control-cohort reconcile pass (`DEFAULT_CONTROL_COHORT_RECONCILE_MS`, 15 s), because the admin route does not call `reconcileControlCohort()` after `addDrone`.
- **Token file handling** strips exactly one trailing `\n` / `\r\n`, so a hand-written file works and a file written by `--startup-token-file` is read verbatim. The env token is used untrimmed, to match how `cadre start` reads it.
- **Under `--json`, warnings appear only in the `warnings` field**; nothing is echoed to stderr.
- `EnrollAddError` is thrown from the input checks and from the self refusal. `describeAdminFailure` passes its message through unchanged.
