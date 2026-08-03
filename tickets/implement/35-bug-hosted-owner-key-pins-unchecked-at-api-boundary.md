----
description: When someone asks a hosting service to run a node for them and mistypes one of the trusted keys they supply, the request is accepted as successful and the node then silently fails to start, instead of the mistake being reported back right away.
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/package.json, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-core/src/ed25519-key.ts
difficulty: medium
repro: verified
----

# Validate owner-key pins where the caller supplies them, not after the node is spawned

## What a "pinned owner key" is

A node that will join someone else's party must be told up front whose signed
join-instructions (a *seed*) it may trust. That list is supplied as **pinned owner
keys**: base64url-encoded Ed25519 public keys, reaching the node as the
`CADRE_OWNER_KEYS` environment variable.

Two services accept that list from a caller over the network and hand it to a node
they spawn on the caller's behalf. Neither checks that the strings are actually
shaped like keys:

- **`cadre-provider`** — `POST /containers` accepts `pinnedOwnerKeys` in the body
  (`validatePinnedOwnerKeys` in `packages/cadre-provider/src/server/routes.ts:50`).
- **`cadre-host`** — `DonationService.provision` accepts
  `DonationProvisionRequest.ownerKeys`
  (`packages/cadre-host/src/donation/donation-service.ts:229`) and forwards them
  straight to the orchestrator.

`cadre-cli start` *does* check, and now rejects a malformed entry outright
(`validatePinnedOwnerKeys` in `packages/cadre-cli/src/commands/start.ts:63`, backed
by `requireEd25519PublicKeyB64`). So the failure exists — it has just moved to the
worst possible place: after the caller was told the request succeeded.

## Reproduction (verified)

A throwaway vitest case against the real provider server (Fastify `inject`,
`MockOrchestrator`, memory store) posting

```json
{ "partyId": "party-1",
  "bootstrapNodes": ["/ip4/127.0.0.1/tcp/4001"],
  "pinnedOwnerKeys": ["this-is-not-a-key"] }
```

returns **201 Created**. `"this-is-not-a-key"` is 17 characters of otherwise-valid
base64url alphabet, so it decodes to nothing (`Unexpected end of data`) and the
spawned node throws at boot. The caller sees a created container and learns about
the typo, if ever, from container status — never from a 400 naming the bad key.
(The temp test was deleted after observing; recreate it as a real assertion below.)

The cadre-host arm is the same defect read off the code: `provisionLocked` writes the
donation record (`donation-service.ts:259`, consuming a grant quota slot) and then
calls `orchestrator.createContainer` with `pinnedOwnerKeys: request.ownerKeys`
(`:271`) — no shape check anywhere on the way in. The child then dies at startup and
the donation is marked `error` with the child's message.

## Expected behavior

A caller that supplies a badly-shaped owner key is told so **by the call that
supplied it**, before anything is provisioned:

- `POST /containers` → `400 INVALID_REQUEST`, message naming which key is bad,
  alongside the existing "must be an array of strings" check. No container record,
  no orchestrator call.
- `DonationService.provision` → `DonationError('invalid_request', …)`, which
  `packages/cadre-host/src/server/error-handler.ts` already maps to 400. Thrown
  before the grant is validated, before the record is written, and before any
  workdir or port is taken.

Both apply the same rule as the node itself — **base64url, decodes to exactly 32
bytes** — so anything the boundary accepts is something the node can start with.
Curve membership stays out of scope in both places, exactly as at the node
(`requireEd25519PublicKeyB64`'s docstring says why).

## Decision: how the provider gets the rule

`@serfab/cadre-provider` does not depend on `@serfab/cadre-core`, and its route
docstring calls that deliberate. Two options were weighed:

**A — add the workspace dependency, reuse `requireEd25519PublicKeyB64`.** One
definition, zero drift. But: cadre-provider today declares six light runtime deps
(fastify, dockerode, commander, js-yaml, nanoid, debug) and **zero** `workspace:`
deps. Depending on cadre-core drags libp2p + quereus + optimystic into a thin
Docker-host service's install closure, and it trips the note at the top of
`packages/cadre-provider/vitest.config.ts`: that package is the one with no
stale-build guard *precisely because* it has no `workspace:`/`link:` deps, so
adding one obliges a `test/global-setup.ts` + build-targets spec as well.

**B — restate the rule locally in the provider, over `uint8arrays`.** Chosen.
`uint8arrays` is already the monorepo's base64url codec (it is what
`requireEd25519PublicKeyB64` itself uses), is dependency-light and browser-safe, and
is not a workspace dep — so the vitest note stays true. Cost is roughly a dozen
duplicated lines.

Drift is contained by (a) a comment at each definition naming the other, and (b) a
provider test that asserts the same accept/reject table as
`packages/cadre-core/test/ed25519-key.spec.ts`, so a divergence shows up as a test
failure rather than as silence. The rule itself is fixed by Ed25519 (a public key is
32 bytes, always), not by our code, so it is about as stable as duplication gets.

`cadre-host` already depends on `@serfab/cadre-core`, so its arm imports
`requireEd25519PublicKeyB64` directly — no duplication there.

Observed decoder behavior, for whoever writes the tests:

| value | result |
| --- | --- |
| `'A'.repeat(43)` | 32 bytes — valid |
| `'A'.repeat(43) + '=='` | 32 bytes — padding tolerated |
| `'k'.repeat(44)` | 33 bytes — rejected on length |
| `'owner-key-1'`, `'key-1'`, `'this-is-not-a-key'` | throws `Unexpected end of data` |
| `'not base64!!'`, `'abc$def'`, `'has+slash/and=pad'` | throws `Non-base64url character` |

## Deliberate behavior change: a blank string entry

`ContainerService`'s `normalizePinnedOwnerKeys`
(`packages/cadre-provider/src/service/container-service.ts:43`) currently *tolerates*
`['']` — it trims, drops empties, and its docstring justifies that as "`[""]`, which
the CLI parses back to trust-nobody, is recorded as no keys at all".

Validating at the route reverses that for route-originated requests: a blank entry
now gets a 400 (`requireEd25519PublicKeyB64` rejects blanks with its own message).
That is the right call — a caller who sends `[""]` made a mistake; a caller who
genuinely wants to trust nobody omits the field, which stays valid and stays a 201.
Keep `normalizePinnedOwnerKeys` as-is (it still guards direct `ContainerService`
callers) and update its docstring to say the route now rejects blanks ahead of it.

No emptiness rule is being added anywhere it does not already exist: `POST /grants`
keeps its "ownerKeys is required, non-empty" check, `POST /containers` keeps
accepting an absent field and an empty array.

## Test fixtures that will start failing

Several tests pin placeholder strings that this validation rejects. They sit
*above* the boundary and must be given real 32-byte base64url values:

- `packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts`
  — `'owner-key-1'`, `'owner-key-2'`.
- `packages/cadre-host/src/donation/__tests__/donation-service.test.ts` — the
  `baseRequest` helper (`:92`) plus the `pinnedOwnerKeys` expectations at `:114`,
  `:453`, `:863`, `:906`, `:946`.
- `packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts` — `:81`,
  and `['k']` at `:281` / `:301`.
- `packages/cadre-host/src/server/__tests__/grants-route.test.ts` — `:64`.

These sit *below* the boundary and need **no** change (they call
`ContainerService` / the orchestrator directly, which are not validation sites):
`packages/cadre-provider/src/service/__tests__/container-owner-keys.test.ts`,
`container-env.test.ts`, `docker-orchestrator-push.test.ts`,
`packages/cadre-host/src/__tests__/orchestrator-pin-keys.test.ts`.

Both integration scenarios already derive real keys via
`ed25519KeyPairFromLibp2p(...).publicKeyB64` — `cadre-host-node-donation.integration.ts:89`
and `provider-seed-accepted.integration.ts:199,325` — so they need no change.

## Not in scope

`DonationService.respawn` replays `donation.ownerKeys` off a record written before
this change. Do **not** validate there: a stored record that predates the boundary
check would become permanently un-respawnable, and the pins are already inside the
trust boundary at that point. Boundary validation is the point of this ticket.

## Note for the implementer

`packages/cadre-host/src/donation/donation-service.ts` is also named in
`plan/36.2-debt-failed-provision-strands-workdir`, and
`packages/cadre-provider/src/service/container-service.ts` in
`plan/36.1-debt-cadre-provider-stuck-provisioning-quota`. Different sites in those
files (spawn-failure cleanup and a reap sweep, versus this ticket's request-entry
guard), so no conflict is expected — but check the tree before editing.

## TODO

### Phase 1 — cadre-provider (`POST /containers`)

- Add `uint8arrays` (`^5.1.0`, matching cadre-core) to
  `packages/cadre-provider/package.json` dependencies.
- In `packages/cadre-provider/src/server/routes.ts`, extend
  `validatePinnedOwnerKeys` to check each entry: trim, reject blank, base64url-decode,
  require 32 bytes. Return the trimmed values so the request carries exactly what was
  validated. Cap the rejected value echoed in the message the way
  `describeRejected` does in `packages/cadre-core/src/ed25519-key.ts` (a caller must
  not be able to turn one junk string into a megabyte of log line).
- Replace the route docstring's "the provider does not depend on
  `@serfab/cadre-core`" paragraph and its `NOTE:` pointing at the backlog slug with
  the decision recorded above: rule restated locally, over `uint8arrays`, to keep the
  package free of `workspace:` deps; cross-reference
  `requireEd25519PublicKeyB64` as the definition to keep in step.
- Add the reciprocal cross-reference comment on `requireEd25519PublicKeyB64` in
  `packages/cadre-core/src/ed25519-key.ts`, naming the provider copy.
- Update the `normalizePinnedOwnerKeys` docstring in
  `packages/cadre-provider/src/service/container-service.ts` — the route now rejects
  blanks before they reach it; the filter stays as a guard for direct callers.

### Phase 2 — cadre-provider tests

- In `create-container-owner-keys.test.ts`: swap the placeholder pins for real
  32-byte base64url values (a small local helper that builds distinct ones beats
  magic literals), then add cases for a malformed key → 400 `INVALID_REQUEST` with
  the bad value named in the message, a blank-string entry → 400, and no container
  provisioned on either (mirror the existing "does not provision" test).
- Add the accept/reject table above as a direct unit test of the provider's
  validator, matching `packages/cadre-core/test/ed25519-key.spec.ts` — this is the
  drift alarm the decision above depends on.
- Run `yarn workspace @serfab/cadre-provider test` and `… typecheck`.

### Phase 3 — cadre-host (`DonationService.provision`)

- Validate `request.ownerKeys` at the top of `provision` — *before* `serializeByGrant`,
  so a malformed request never waits behind another provision's lock and never
  reaches the quota check or `store.put`. Map a `requireEd25519PublicKeyB64` throw to
  `DonationError('invalid_request', …)` so `error-handler.ts` renders it as 400.
- Pass the trimmed keys forward into `provisionLocked` (build a normalized request)
  so the persisted record and the child's `CADRE_OWNER_KEYS` carry exactly the
  validated values — same discipline as `cadre-cli start`.
- Document on `DonationProvisionRequest.ownerKeys` that entries are shape-validated
  at the boundary and what that guarantees downstream.

### Phase 4 — cadre-host tests

- Fix the placeholder fixtures listed above.
- Add to `donation-service.test.ts`: a malformed `ownerKeys` entry rejects with code
  `invalid_request`, `orch.createCalls` is empty, `store.list()` is empty, and
  `store.liveNodeCount(token)` is 0 — the point being that no grant slot is burned.
- Add to `grants-route.test.ts`: `POST /grants` with a malformed owner key → 400
  `invalid_request`, next to the existing empty-`ownerKeys` case.
- Run `yarn workspace @serfab/cadre-host test` and `… typecheck`.

### Phase 5 — wrap-up

- `yarn lint`.
- Update `docs/cadre-host.md` (donation request validation) and
  `packages/cadre-provider/README.md` (which documents `POST /containers`), so the
  new 400 is stated where a caller would look. `docs/architecture.md` and
  `docs/STATUS.md` also mention the route — check whether either needs a line. Do
  not create a new doc.
