description: The two services that start a node for someone now check the list of peer addresses the new node is told to dial, so a mistyped address comes back as a clear error instead of a node that quietly fails later on someone else's machine.
files: packages/cadre-provider/src/server/bootstrap-node-validation.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-host/src/server/routes/bootstrap-node-validation.ts, packages/cadre-host/src/server/routes/provision-request-validation.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/__tests__/bootstrap-node-validation.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, docs/cadre-host.md, docs/architecture.md
difficulty: medium
----

# Review: `bootstrapNodes` validated at both hosted-create boundaries

Both create routes now run their **whole** request body through one validator that
returns the typed request object, rather than a stack of inline `if`s. A field can
now only reach a spawned child by having been through that function.

## What landed

**New modules (4).**

| file | what it owns |
| --- | --- |
| `cadre-provider/src/server/bootstrap-node-validation.ts` | the address rule |
| `cadre-provider/src/server/create-request-validation.ts` | whole `POST /containers` body → `CreateContainerRequest` |
| `cadre-host/src/server/routes/bootstrap-node-validation.ts` | the address rule (identical copy) |
| `cadre-host/src/server/routes/provision-request-validation.ts` | whole `POST /grants` body → `DonationProvisionRequest` |

**The address rule** (identical on both sides). An entry is accepted when it is a
string, trims to non-empty, parses as a multiaddr, carries at least one
`/p2p/<peerId>` component, and **every** such component decodes via
`peerIdFromString`. Anything else is a 400 naming the offending entry
(`INVALID_REQUEST` on the provider, `invalid_request` on the host), nothing
provisioned.

The peer id is read as `getComponents().filter(c => c.code === CODE_P2P)` — the
same access `@libp2p/bootstrap` uses (verified against its installed source at
`../optimystic/packages/db-p2p/node_modules/@libp2p/bootstrap/dist/src/index.js:62-79`)
— not the deprecated `getPeerId()`, which TypeScript flags in multiaddr 12.5.1.

Two deliberate deviations from the ticket, both **stricter than** and compatible
with what bootstrap does; both are worth a reviewer's eye:

- **Every `/p2p/` component must decode, not just the last.** Bootstrap only reads
  the last one. So a relayed `…/p2p/<junk-relay>/p2p-circuit/p2p/<good-target>` is
  rejected here and would be accepted by bootstrap (and then fail to dial). Argued
  in the module comment as "an address naming an undecodable relay is not dialable
  either" — reasonable, but it is a judgement call, not a derivation.
- **`@multiformats/multiaddr-matcher` was NOT added.** Bootstrap's filter is
  `P2P.matches(ma) && has a p2p component`. I probed `P2P.matches` directly against
  the installed matcher: it returns `true` for every address carrying a `/p2p/`
  component, including `/p2p/<id>` with no transport at all. So the peer-id clause
  already subsumes it and the third dependency buys nothing. **If a reviewer
  doubts this, the probe is one command** — see "How to re-verify" below.

**Dependencies.** `@multiformats/multiaddr@^12.5.1` + `@libp2p/peer-id@^6.0.4` on
cadre-provider; `@multiformats/multiaddr@^12.5.1` on cadre-host (which already had
`@libp2p/peer-id`). The ticket's dependency argument holds up: no workspace deps
added, no libp2p networking stack, no quereus, no optimystic — so the reason
`owner-key-validation.ts` gives for restating cadre-core's rule locally is
untouched, and cadre-provider's `vitest.config.ts` note about needing no
stale-build guard stays true.

## Scope I went beyond the ticket on — check these first

The ticket's TODO listed `partyId` / `bootstrapNodes` / owner-key / `profile`. I
also folded in `strandFilter`, `resources` and `tags`, because the stated design
goal was "a field that reaches the spawn path has necessarily been through the
validator" and leaving three fields unchecked would have re-created the same hole
one layer down. These are **type** checks only, not format checks:

- `strandFilter` must be a string (it becomes `CADRE_STRAND_FILTER` verbatim).
- `resources` must be an object; `memoryLimit`/`cpuLimit` strings,
  `storageQuotaBytes` a finite number. The *format* of `"512M"` / `"0.5"` is still
  `DockerOrchestrator.parseMemoryLimit`/`parseCpuLimit`'s business — deliberately
  not duplicated here.
- `tags` must be an object whose values are all strings.

**Three user-visible behaviour changes that are not strictly "validate addresses":**

- **`partyId` is now trimmed** on both sides (was passed verbatim on the provider,
  and the host did a bare `.length === 0` with no trim). A whitespace-only
  `partyId` is now a 400 on both. Trimming is a real change to what gets written
  into `CADRE_PARTY_ID` / the child's `cadre.json` — no-op for any sane value, but
  it *is* a change.
- **The provider now rejects an unknown `profile`.** It previously did
  `body.profile ?? 'storage'` with no check, so `profile: 'archive'` was forwarded
  into `CADRE_PROFILE`. The host already had this check.
- **A non-object body is now a 400** on the provider (`request body must be a JSON
  object`). It previously reached `body.partyId` on `undefined` and would have
  been a 500.

Say so if any of these should be reverted to keep the diff to the ticket's letter.

## What I deliberately did NOT do

- **The host's `ownerKeys` Ed25519 rule stays in `DonationService.provision`,** not
  in the new route validator. The service is also reached by the *respawn* path,
  which replays a persisted record rather than an HTTP body, so moving the crypto
  rule up to the route would have left respawn unchecked. The route validator owns
  only the container shape (present, non-empty, all strings) that the service's
  rule assumes. Reasoning is written into `provision-request-validation.ts`'s
  module comment — worth a reviewer agreeing or disagreeing explicitly.
- **No new tripwire `NOTE:`s were filed.** I went looking for one (a residual gap
  where bootstrap drops an address this validator accepts) and the `P2P.matches`
  probe closed it, so there was nothing conditional left to park. If you find one I
  missed, that is a real gap in this handoff.

## Testing — and where the floor is

Green: `yarn workspace @serfab/cadre-provider test` (28 files, 220 tests),
`yarn workspace @serfab/cadre-host test` (67 files, 624 passed / 4 pre-existing
skips), both `typecheck`s, `yarn lint` (clean, and re-run directly against the six
new/changed files to confirm they are actually in eslint's scope — `eslint .` is
quiet on success, which is easy to mistake for "didn't run"). No pre-existing
failures surfaced, so no `.pre-existing-error.md` was written.

**New tests.** Each package has a `bootstrap-node-validation.test.ts` pinning its
copy to the same accept/reject table — the manual tripwire, since neither package
can see the other's rule:

- accepts: a good address (returned trimmed), several across transports
  (`/ip4/…/tcp/…`, `/dns4/…/tcp/443/wss/…`), a fully-good relayed address
- rejects: absent, `[]`, non-array, non-string element, blank/whitespace,
  `'not-an-address'`, `'42'`, `'bootstrap.example:4001'`, valid-multiaddr-with-no-`/p2p/`,
  `/p2p/12D3KooReq` (undecodable), relayed-with-junk-relay
- asserts the message **names the bad entry** when only one of three is bad, and
  that an over-long junk value is echo-capped rather than logged whole

Route-level, both sides: a bad entry → 400 naming it, and a sweep of all six
unusable shapes asserting **nothing was provisioned** afterwards (provider: the
container list is empty; host: `GET /grants` returns an empty list).

**Known gaps in my own testing — treat these as the floor, not the ceiling:**

- **No test proves a good address still produces a node that actually joins.** The
  scenarios that would (`provider-seed-accepted.integration.ts`,
  `cadre-host-node-donation.integration.ts`) build their addresses with real peer
  ids via `withPeerId(...)`, so they should pass unchanged — but they are
  real-network and long, and **I did not run them.** That is the single biggest
  unverified claim in this handoff.
- **Nothing enforces that the two copies stay identical.** The host copy was
  generated from the provider copy and then had its prose adjusted (different
  package, different downstream — the host writes JSON into the child's
  `cadre.json`, so the comma-join argument for requiring multiaddrs applies to the
  provider's env-var path only, and the host comment says so). The *code* is
  identical; only the two test tables and the two pointer comments keep it that
  way. I confirmed it at hand-off — stripping comments/blank lines and the `debug`
  namespace from both files leaves a byte-identical diff — but nothing in CI does,
  so re-confirm after any edit:

  ```bash
  strip() { sed -e 's|^\s*\*.*||' -e 's|^\s*/\*\*.*||' -e 's|^\s*//.*||' "$1"     | grep -v "^\s*$" | grep -v "const log = debug"; }
  diff <(strip packages/cadre-provider/src/server/bootstrap-node-validation.ts)        <(strip packages/cadre-host/src/server/routes/bootstrap-node-validation.ts)
  ```
- **The echo cap is 192 chars** (vs 64 for owner keys) because a legitimate relayed
  address runs ~150. I did not test the boundary, only that a 5000-char value gets
  capped.

## Fixtures updated

Provider `'/ip4/127.0.0.1/tcp/4001'` → real peer id in `auth-scope-enforcement`,
`container-token-redaction` (3), `create-container-owner-keys`, `shutdown-after` (6).
Host `'…/p2p/12D3KooReq'` → real peer id in `grants-route`, `donation-service`,
`donation-supervisor`, `fake-orchestrator`. Peer used throughout:
`12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp` (verified to decode).

The host service/supervisor fixtures did not *have* to change (the validator is at
the route boundary, below which nothing checks) — I changed them anyway, per the
ticket, so no fixture in the tree teaches the wrong shape.

**One left behind, on purpose:** `packages/cadre-host/src/__tests__/orchestrator.test.ts`
still uses `'/ip4/127.0.0.1/tcp/4001'` (2 sites). It drives the orchestrator
directly, below the validated boundary, so it passes — but it is a fixture that
was never dialable. Not in the ticket's list; flagging rather than silently
widening the diff.

## Docs

`docs/cadre-host.md` (after the two trust rules) and `docs/architecture.md`
(§ Provider Integration, the `pinnedOwnerKeys` paragraph) now state the rule, the
three distinct node failures each clause prevents, and that the two copies are
kept in step by hand.

## How to re-verify the two claims this rests on

```bash
# 1. What @libp2p/bootstrap actually does with the list (the whole premise):
sed -n '55,85p' ../optimystic/packages/db-p2p/node_modules/@libp2p/bootstrap/dist/src/index.js

# 2. That P2P.matches adds nothing over "has a /p2p/ component"
#    (the reason multiaddr-matcher was not added as a third dependency):
cd ../optimystic/packages/db-p2p && node --input-type=module -e "
import { P2P } from '@multiformats/multiaddr-matcher';
import { multiaddr } from '@multiformats/multiaddr';
const P='12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';
for (const a of ['/ip4/1.2.3.4/tcp/4001/p2p/'+P, '/ip4/1.2.3.4/p2p/'+P, '/p2p/'+P])
  console.log(P2P.matches(multiaddr(a)), a);
"
```

## Environment note (not a code finding)

`yarn install` reported `YN0009: cpu-features@npm:0.0.10 couldn't be built
successfully`. It is an optional native dependency of `ssh2` → `dockerode`, it
needs an MSVC toolchain this Windows box does not have, and it was only rebuilt
because adding a dependency invalidated the tree. Install completed, all suites
pass. Pre-existing environment condition, not caused by this ticket and not worth
a ticket.
