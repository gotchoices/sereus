----
description: Make `cadre enroll register` and `cadre status` honest — verify the authority signature locally (no fake "registered" success) and report live runtime state from the running node instead of hardcoded `running:false`.
files: packages/cadre-cli/src/commands/enroll.ts, packages/cadre-cli/src/commands/status.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/index.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/test/admin-server.spec.ts
----

Two `@serfab/cadre-cli` commands present themselves as performing real operations
while their implementations are stubs whose output diverges from actual behavior.
The unifying requirement: **descriptions and emitted messages must match what the
command actually did.** A command that only validates input must not claim a
network operation succeeded, and `status` must reflect the live node when one is
reachable.

Neither command should grow a network-registration path that doesn't exist —
registration is authority-driven (the running authority node self-registers and
authorizes peers via `SeedBootstrapService.authorizePeer`, wired through
`cadre start --authority`; see `tickets/implement/authority-self-registration-cadrepeer.md`).
So `enroll register` becomes an honest **offline validation** command, and
`status` becomes an honest **live query** of the running node's health endpoint.

---

## Part A — `cadre enroll register`: real signature verification, honest messaging

Current behavior (`packages/cadre-cli/src/commands/enroll.ts:50-106`): the action
prints "Registering peer with control network...", instantiates an
`EnrollmentService` it never uses, runs meaningless checks (non-empty +
`length >= 10`), then prints "✓ Registration data format is valid" with guidance
that the authority must submit the registration. An operator who passes any
strings of length ≥ 10 sees a green check and reasonably believes the peer is
enrolled. Nothing was verified or registered.

### Design

Keep the command local (it has no control-network connection) but make its one
real job — checking that the supplied signature is a valid authority signature
over the peer ID — actually happen, using the **same digest/scheme** that
`SeedBootstrapService.authorizePeer` uses to *produce* that signature
(`packages/cadre-core/src/seed-bootstrap.ts:186-195`):

```
peerIdDigest = digest(peerId, 'sha256', 'utf8', 'base64url')
signature    = sign(peerIdDigest, authorityPrivateKey, 'ed25519', 'base64url'×3)
```

Verification is the mirror (cf. seed signature verify at `seed-bootstrap.ts:471-478`):

```
verify(digest(peerId,'sha256','utf8','base64url'), signature, authorityPublicKey,
       'ed25519', 'base64url', 'base64url', 'base64url')  // → boolean
```

**DRY the digest:** the digest construction is currently inlined in `authorizePeer`.
Factor it into a shared, exported cadre-core helper so the producer and the new
verifier can never drift apart. Add a small module
`packages/cadre-core/src/peer-authorization.ts` exporting:

- `peerAuthorizationDigest(peerId: string): string` — the canonical
  `digest(peerId, 'sha256', 'utf8', 'base64url')`.
- `verifyPeerAuthorization(peerId: string, authorityPublicKey: string, signature: string): boolean`
  — returns whether `signature` is a valid authority signature over `peerId`.
  Must not throw on malformed base64url / bad key — catch and return `false`
  (callers want a boolean, not an exception). Log at debug on the catch.

Refactor `authorizePeer` to sign over `peerAuthorizationDigest(peerId)` (same
bytes as today — verify the produced signature is byte-identical). Re-export both
helpers from `packages/cadre-core/src/index.ts` (Enrollment / Seed Bootstrap area).

Then rewrite the `register` action (`enroll.ts`):

- **Description:** change `'Register a peer with the control network (requires authority signature)'`
  to honest copy, e.g.
  `'Verify an authority-signed peer authorization (offline check — does not contact the control network or register the peer)'`.
- Drop the `'Registering peer with control network...'` opening line and the
  unused `EnrollmentService` instantiation.
- Validate inputs *meaningfully* (replace the `length >= 10` theatre):
  - `peerId` parses via `peerIdFromString` (already a dep via `@libp2p/peer-id`);
    on failure → `✗ Invalid peer ID` + exit 1.
  - require ≥1 bootstrap node (keep) — but frame it as advisory metadata, not a
    registration prerequisite.
  - `authorityKey` / `signature` non-empty (the real check is the verify below).
- Call `verifyPeerAuthorization(peerId, authorityKey, signature)`:
  - **valid** → `✓ Authority signature is valid for this peer ID`, then a clearly
    deferring message: this command **only verified the signature** and did **not**
    register anything; the peer becomes a member when the running authority node
    authorizes it (it self-registers / authorizes peers; an operator on the
    authority node runs `cadre start --authority`). Exit 0.
  - **invalid** → `✗ Authority signature does not match this peer ID (peer is NOT authorized)`
    + exit 1.
- No output may imply the local peer is now registered/enrolled.

`--bootstrap` / `--config` may remain as accepted options (useful context echoed
back), but must not be described or printed as if they caused a registration.

### Tests (Part A)

Prefer testing the **pure helper** in cadre-core (no `process.exit`/console
plumbing): add `packages/cadre-core/test/peer-authorization.spec.ts`:

- Round-trip: generate an ed25519 authority keypair (reuse the crypto primitives
  from `@optimystic/quereus-plugin-crypto` the way `seed-bootstrap.spec.ts` does,
  or `authorityKeyFromLibp2p`), sign `peerAuthorizationDigest(peerId)`, assert
  `verifyPeerAuthorization(peerId, pub, sig) === true`.
- Wrong peerId / wrong authority key / tampered signature → `false`.
- Malformed base64url signature / garbage key → `false` (does not throw).
- Regression: a signature produced by `SeedBootstrapService.authorizePeer`'s path
  verifies true under `verifyPeerAuthorization` (proves the shared digest didn't
  drift). The existing `seed-bootstrap.spec.ts` authorize/round-trip assertions
  must still pass unchanged.

A light CLI smoke test is optional given commander's `process.exit`; the helper
test carries the correctness load.

---

## Part B — `cadre status`: query the live node, distinguish config from runtime

Current behavior (`packages/cadre-cli/src/commands/status.ts`): loads the config
file and reports static fields, with runtime hardcoded `running: false`,
`peerId: null`, `strands: []` (`:32-36,50`). Run against a live systemd/Docker
cadre node it still prints "running: false" and an empty strand list,
contradicting the node's actual state.

### Design

The running node already exposes everything needed, unauthenticated, on the
health server's `/status` endpoint (`packages/cadre-cli/src/server/health.ts:256-259`),
which returns the full `HealthStatus` (`health.ts:17-40`): `status`, `peerId`,
`multiaddrs`, and `node.{ running, partyId, profile, strands{total,active,idle,hibernating} }`.
That is the right live source — no bearer token needed (unlike the admin channel,
which is loopback + `CADRE_STARTUP_TOKEN`). The admin channel may be a later
enhancement; the health endpoint satisfies the ticket's requirement.

Rework `status` to:

- **Resolve the health endpoint.** Add options mirroring `start.ts`'s resolution
  (`start.ts:162`): `--health-port <port>` (default `8080`, env `CADRE_HEALTH_PORT`)
  and `--health-host <host>` (default `localhost`). URL = `http://<host>:<port>/status`.
- **Static config summary stays but is clearly labeled "Configuration"** and kept
  distinct from live runtime. Make a missing config **non-fatal**: warn and skip
  the static section, but still attempt the live query (an operator may want
  status against a node whose config isn't on this machine). Today a missing
  config hard-exits (`status.ts:13-19`) — relax that.
- **Attempt the live query** with a short timeout (AbortController; ~2s default,
  overridable via `--timeout <ms>`). Use the global `fetch` (Node ≥18; the
  pattern in `packages/cadre-host/src/authority/authority-node-client.ts:164-171`
  is the reference for try/catch around `fetch`).
  - **Reachable** → a "Runtime (live)" section: `running`, `peerId`, listening
    `multiaddrs`, strand counts (total/active/idle/hibernating), partyId/profile
    from the live node. This is the source of truth.
  - **Unreachable** (ECONNREFUSED / timeout / non-2xx) → a clearly-labeled line
    like `Runtime: no running node reachable at http://localhost:8080/status`
    (optionally hint `cadre start`). Must **not** assert `running: false` as if
    verified — frame it as "could not reach a node," not "node is stopped."
- **`--json`** emits a single object distinguishing the two, e.g.
  `{ config: {...} | null, runtime: { reachable: boolean, url, ...liveFields } }`
  so a machine can tell a live read from a fallback. Exit code: `0` when reachable;
  consider non-zero when unreachable so scripts/`healthcheck` can branch (document
  whichever you pick).

### Tests (Part B)

Extract the testable seam: a pure function that, given a fetch impl (injectable)
and the resolved URL, returns a discriminated result
`{ reachable: true, status: HealthStatus } | { reachable: false, reason }`, plus a
formatter that renders the report object from `(configSummary | null, runtimeResult)`.

Add `packages/cadre-cli/test/status.spec.ts` (vitest, mirrors
`admin-server.spec.ts` style):

- Stub fetch returning a valid `HealthStatus` envelope → result `reachable:true`
  and the rendered/JSON object surfaces `running:true`, the live `peerId`, the
  multiaddrs, and strand counts (proves it no longer hardcodes `false/null/[]`).
- Stub fetch rejecting (simulated ECONNREFUSED) → `reachable:false`; rendered
  output is the clearly-labeled "not reachable" line and JSON `runtime.reachable === false`;
  assert it does **not** emit a bare `running:false`.
- Timeout path (fetch that never resolves before the AbortController fires) →
  `reachable:false`.

---

## Validation

- `cd packages/cadre-core && yarn build && yarn test 2>&1 | tee /tmp/core-test.log`
- `cd packages/cadre-cli && yarn build && yarn test 2>&1 | tee /tmp/cli-test.log`
- `tsc -p tsconfig.build.json --noEmit` in both packages.
- Stream all long-running output with `… 2>&1 | tee` (never silent redirect).
- If a surfaced failure is plainly pre-existing/unrelated to this diff, follow the
  `tickets/.pre-existing-error.md` flow rather than chasing it here.

## Docs

- If `docs/STATUS.md` or `docs/architecture.md` describe `cadre status` /
  `cadre enroll` CLI behavior, update them to state that `status` reads live
  runtime from the health `/status` endpoint and that `enroll register` is an
  offline signature verification (not a network registration).

## TODO

### Phase 1 — shared verifier (cadre-core)
- Add `packages/cadre-core/src/peer-authorization.ts` with `peerAuthorizationDigest`
  and `verifyPeerAuthorization` (catch-and-return-false on malformed input).
- Refactor `SeedBootstrapService.authorizePeer` to sign over
  `peerAuthorizationDigest(peerId)`; confirm the produced signature is unchanged.
- Re-export both from `packages/cadre-core/src/index.ts`.
- Add `packages/cadre-core/test/peer-authorization.spec.ts` (round-trip, wrong
  key/peer/tamper, malformed-no-throw, authorizePeer-compat).

### Phase 2 — enroll register (cadre-cli)
- Rewrite the `register` action: honest description; drop the
  "Registering with control network" line and unused `EnrollmentService`; parse
  peerId via `peerIdFromString`; call `verifyPeerAuthorization`; valid → "signature
  valid" + explicit "not registered / authority node performs registration"
  message (exit 0); invalid → "signature does not match / NOT authorized" (exit 1).

### Phase 3 — status live query (cadre-cli)
- Add `--health-port`/`--health-host`/`--timeout` options (mirror `start.ts` env
  resolution for the port).
- Make missing config non-fatal (warn, skip static section, still query live).
- Add an injectable-fetch helper returning a discriminated reachable result and a
  formatter; wire the action to it; label "Configuration" vs "Runtime (live)";
  unreachable path must not assert `running:false`.
- `--json` emits `{ config, runtime:{ reachable, url, … } }`; pick & document the
  exit code on unreachable.
- Add `packages/cadre-cli/test/status.spec.ts` (reachable / unreachable / timeout).

### Phase 4 — validation & docs
- Build, test, and typecheck cadre-core and cadre-cli (stream with `tee`).
- Update `docs/STATUS.md` / `docs/architecture.md` CLI descriptions if present.
