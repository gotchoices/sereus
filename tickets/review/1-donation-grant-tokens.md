----
description: Review the new "grant token" layer that lets a cadre-host owner hand out redeemable tokens so a specific friend/family member can ask the host to donate nodes, capped per grantee.
prereq:
files: packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/grant-store.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/donation/__tests__/grant-store.test.ts, packages/cadre-host/src/donation/__tests__/grant-service.test.ts, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/__tests__/grants-admin-route.test.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/server/__tests__/error-handler.test.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/index.ts
difficulty: medium
----

# Review: donation grant-token layer

## What this ticket built

The **grant-token layer** for cadre-host — the social-scale equivalent of
cadre-provider's API-key gate. A grant token authorises one *grantee* (a friend
or family member's cadre authority — their phone) to ask this host to donate
cadre nodes, up to a per-grantee cap. This ticket is **only** issuance,
validation, and quota; the lifecycle service that *consumes* a validated grant
to actually provision a node is the downstream `2-donation-service` ticket,
which imports the `GrantValidator` interface defined here.

**Not to be confused with the trust-circle flow** (`src/auth/`): a trust-circle
invite lets a device join *the host's own* cadre; a donation grant lets an
external cadre authority ask the host to spawn a node that joins *the grantee's*
cadre. Deliberately separate modules — this one reuses the *shape* of
`TrustCircleStore` (atomic write-then-rename JSON, token-keyed rows) but with
**grant** semantics: long-lived and reusable up to a quota, never
one-time-redeemed.

### Files added

- `src/donation/types.ts` — `Grant`, `GrantDenyReason`, `GrantValidation`,
  `GrantValidator` (the slice `2-donation-service` depends on), plus `GrantFile`
  (on-disk shape), `GrantAdminHandlers`, and `GrantError` / `GrantErrorCode`.
- `src/donation/grant-store.ts` — `GrantStore`, atomic JSON store at
  `<dataDir>/grants.json`, modelled on `TrustCircleStore`. Methods `add`, `get`,
  `list`, `remove`, `markRevoked`. **Not self-reaping** — expiry is evaluated at
  validate time; the admin removes stale grants explicitly.
- `src/donation/grant-service.ts` — `GrantService implements GrantValidator`:
  `issue`, `validate`, `validateForProvision`, `revoke`, `list`, plus
  `createGrantAdminHandlers`. All methods are **synchronous** (pure local store
  ops; no owner-node round-trip, unlike trust-circle).
- `src/donation/index.ts` — module re-exports.
- `src/server/routes/grants-admin.ts` — `registerGrantsAdminRoutes`: loopback
  admin surface `POST/GET/DELETE /grants-admin` (no bearer — same-machine admin,
  matching the local-UI "no login" posture).

### Files changed

- `src/server/index.ts` — added optional `grants?: GrantService` to
  `LocalUiServerOptions`; mounts the grants-admin routes when present.
- `src/server/error-handler.ts` — `GrantError` → HTTP status mapping
  (`invalid_label` / `invalid_max_nodes` / `invalid_ttl` → 400, `not_found` →
  404, `storage_error` → 500).
- `src/bin/host.ts` — `grant issue|list|revoke` CLI subcommands (thin HTTP
  clients of `/grants-admin`); constructs `GrantService` in `start` and passes
  it to `createLocalUiServer`.
- `src/index.ts` — exports the donation surface.

## Design decisions worth a reviewer's eye

- **Quota tally ownership.** `GrantService` never counts nodes itself.
  `validateForProvision(token, liveNodeCount)` takes the count as a callback so
  the donation service stays the single source of truth for "live nodes" (it
  holds the grant→node records and can see terminations). The grant layer owns
  identity/expiry/revocation only. `liveNodeCount` is consulted **only after**
  identity/expiry/revocation pass — an unknown or dead token never invokes it
  (tested).
- **Concurrency boundary (explicitly out of scope here).**
  `validateForProvision` is a pure function of the passed count. Two provision
  requests racing at the quota edge (both seeing count = N-1) would **both**
  pass. Serialising them so only one wins is `2-donation-service`'s job (it owns
  the grant→node lock). Flagged in the code + this handoff so the next ticket
  owns it — do not treat the double-pass as a bug in *this* layer.
- **revoked vs expired precedence.** When a grant is both revoked and expired,
  `validate` reports `revoked` (the explicit admin action is the stronger
  signal). Tested. Either order satisfies the spec's "distinct reasons"
  requirement; flagging the choice in case review prefers `expired`-first.
- **Revoke marks, does not remove.** `revoke` sets `revokedAt` (idempotent —
  keeps the first timestamp) and leaves the row listed. A revoked grant denies
  future requests but does **not** tear down existing live nodes (that's a
  separate admin terminate in `2-donation-service`). The CLI `grant list` shows
  `[revoked]`.
- **CLI token to stdout, metadata to stderr.** `grant issue` prints the raw
  token alone on stdout (pipe/copy-friendly) and the QR + maxNodes/expiry line to
  stderr — mirrors how `invite` separates the encoded invite from its
  `(expires …)` note.

## How to validate / exercise

Build + test + lint all pass locally:

```
yarn workspace @serfab/cadre-host typecheck     # exit 0
yarn workspace @serfab/cadre-host test          # 413 passed, 3 pre-existing skips
yarn workspace @serfab/cadre-host build          # server tsc + vite UI, exit 0
yarn lint                                        # exit 0
```

Targeted suites (47 tests): `yarn vitest run src/donation src/server/__tests__/grants-admin-route.test.ts src/server/__tests__/error-handler.test.ts`

Unit coverage to lean on (this is the **floor**, not the ceiling):

- **grant-store** — absent file → empty; round-trip; remove; `markRevoked`
  idempotence + unknown-token false; atomic-rename (no `.tmp` residue); token is
  the map key (not duplicated in the row); **malformed/wrong-shape file throws**
  (does not silently wipe — that would revoke everyone).
- **grant-service** — issue (base64url token, default maxNodes, ttl→expiresAt);
  label/maxNodes/ttl validation; `validate` accept / empty→unknown_token /
  unknown→unknown_token / revoked / expired-even-if-not-revoked /
  revoked-over-expired; `validateForProvision` quota boundary (0,1 ok → 2
  quota_exceeded) and **liveNodeCount not consulted** for unknown/revoked;
  `revoke` not_found + idempotence; handler surface.
- **grants-admin route** — POST→GET→DELETE against a real `GrantService`/store
  through Fastify + the error handler; 400 invalid_label, 400 invalid_max_nodes,
  404 not_found.
- **error-handler** — `GrantError` code→status mapping.

Manual end-to-end (needs a running host): `cadre-host grant issue "Alice's
cadre" --max-nodes 2 --ttl 30d`, then `grant list`, then `grant revoke <token>`.

## Known gaps / suggested review focus

- **No live provisioning path is exercised.** `validateForProvision`'s
  `liveNodeCount` is only tested with hand-supplied closures. The real tally, and
  the race serialization, arrive with `2-donation-service` — there is no
  integration test spanning the two yet (by design; the consumer doesn't exist).
- **No SSE event** is emitted on grant issue/revoke (the trust-circle/NAT routes
  publish `*-changed` bus events). Skipped deliberately — there is no SPA grants
  page yet (that's the docs/integration ticket `4-donor-docs-and-integration`).
  Adding an event now would be a dead `LocalUiEvent` variant. Reviewer: confirm
  you agree, or file a follow-up when the UI lands.
- **`/grants-admin` has no bearer** — intentional (loopback same-machine admin,
  per the security posture). The origin guard + 127.0.0.1 bind are the gate,
  same as every other management route. Worth a second look that it's genuinely
  mounted only on the loopback server (it is — via `createLocalUiServer`).
- **grants.json rewrites whole-file per mutation** — parked as a `NOTE:` tripwire
  at `grant-store.ts` `save()`. Fine at household scale; revisit only if grant
  counts ever grow large. Not a ticket.
- **No docs update.** `docs/cadre-host.md` has no grant section yet; the source
  ticket routes documentation through `4-donor-docs-and-integration`. If review
  wants a stub sooner, that's a small add.

## Review findings

- Tripwire parked: `grants.json` is rewritten in full on every mutation
  (`grant-store.ts` `save()`, tagged `NOTE:`) — negligible at household scale,
  revisit if grant counts grow large. Not filed as a ticket.
- Deliberate scope boundary noted in code + handoff: the quota-edge race between
  two concurrent provisions is `2-donation-service`'s to serialize, not a defect
  in this pure-function validator.
