----
description: Give a cadre-host owner a way to hand out redeemable "grant" tokens that let a specific friend or family member ask the host for a node — with a per-grantee cap on how many nodes they may request.
prereq:
files: packages/cadre-host/src/donation/grant-store.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/auth/trust-circle-store.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-provider/src/server/permissions.ts, packages/cadre-provider/src/service/billing-service.ts
difficulty: medium
----

# Donation grant tokens — the "who may ask this host for a node" gate

## Context

cadre-host is being realigned from *founding* a cadre to *donating nodes* to other
people's cadres (see the sibling `2-donation-service`, `3-demote-host-founder`,
`4-donor-docs-and-integration` tickets, all downstream of this one). cadre-provider
gates node requests with API keys + billing quotas; cadre-host's persona is
friends/family, so it needs an equivalent but socially-scaled gate.

This ticket builds **only the grant-token layer**: issuance, validation, and
per-grantee quota. The lifecycle service that *consumes* a validated grant to
provision a node is the next ticket (`2-donation-service`), which imports the
validator interface defined here.

**Grant ≠ trust-circle membership.** Don't conflate the two token flows:

- A **trust-circle invite** (existing, `auth/trust-circle.ts`) authorizes a device to
  join *the host's own* cadre. In the realigned model this is an optional
  "host owner also wants their own cadre" convenience (`3-demote-host-founder`).
- A **donation grant** (new, this ticket) authorizes an *external* cadre authority
  (someone's phone) to ask the host to spawn a node that will join *the requester's*
  cadre. The host never learns the requester's authority key.

Requirement #4 of the source plan says: *repurpose the existing trust-circle
invite/token machinery as grant tokens.* Concretely — **reuse the shape/patterns**
of `TrustCircleStore` (atomic write-then-rename JSON, pending rows, one-time
redemption claim, TTL reaping) but as a **separate module** with grant semantics,
so the optional trust-circle role stays intact and independent.

## Design

A **grant token** is a high-entropy base64url secret the host admin issues
out-of-band (QR / copy-paste), exactly like a trust-circle invite is delivered. The
requester's app stores it and presents it as `Authorization: Bearer <grant-token>`
on every donation request (`2-donation-service`).

Unlike a trust-circle invite (one-time: redeemed → consumed), a grant token is
**long-lived and reusable up to a quota** — a grantee may hold one grant and use it
to provision, inspect, re-seed, and terminate up to N nodes over the grant's
lifetime. This mirrors a provider API key (persistent credential + quota) more than
a one-shot invite.

### Types (`donation/types.ts`)

```ts
/** A grant the host admin issued to one grantee (friend/family). */
export interface Grant {
  /** base64url secret; also the bearer credential. The store key. */
  token: string;
  /** Human label chosen by the admin, e.g. "Alice's cadre". Display-only. */
  label: string;
  /** Max concurrently-live donated nodes this grant may hold. */
  maxNodes: number;
  createdAt: string;   // ISO
  expiresAt?: string;  // ISO; absent = no expiry
  /** Set when the admin revokes; a revoked grant validates as denied. */
  revokedAt?: string;
}

export type GrantDenyReason =
  | 'unknown_token'     // no such grant
  | 'expired'
  | 'revoked'
  | 'quota_exceeded';   // live node count already at maxNodes

export interface GrantValidation {
  ok: boolean;
  grant?: Grant;
  reason?: GrantDenyReason;
}

/** The slice `2-donation-service` depends on. Keeps that ticket decoupled
 *  from the store implementation. */
export interface GrantValidator {
  /**
   * Validate a presented bearer token for a *new* provision request.
   * `liveNodeCount(token)` is supplied by the donation service — the grant
   * layer owns identity/expiry/revocation; the donation service owns the
   * authoritative live-node tally (it holds the grant→node records).
   */
  validateForProvision(
    token: string,
    liveNodeCount: (token: string) => number,
  ): GrantValidation;
  /** Validate for a non-provisioning op (peer/seed/terminate) — identity + not
   *  expired/revoked, no quota check. */
  validate(token: string): GrantValidation;
}
```

### Store (`donation/grant-store.ts`)

Model on `TrustCircleStore`: a single JSON file `<dataDir>/grants.json`, atomic
write-then-rename, an in-memory map keyed by token. Methods: `add(grant)`,
`get(token)`, `list()`, `remove(token)`, `markRevoked(token, at)`. Expiry is
**not** self-reaping here (a grant may legitimately outlive many nodes) — expiry is
evaluated at validate time; the admin removes stale grants explicitly.

### Service (`donation/grant-service.ts`)

`GrantService implements GrantValidator`. Methods:

- `issue({ label, maxNodes, ttlMs? }) → Grant` — generate token (32 random bytes,
  base64url), persist, return it (the CLI/UI prints/QR-encodes the token).
- `validate(token)` / `validateForProvision(token, liveNodeCount)` — as above.
- `revoke(token)` — mark revoked; existing live nodes are **not** torn down here
  (that is a separate admin action via `2-donation-service`'s terminate). Revocation
  only blocks *future* requests. NOTE this at the call site.
- `list()` — for the CLI/UI.

Quota is `liveNodeCount(token) >= grant.maxNodes → quota_exceeded`. The count comes
from the donation service so there is a single source of truth for "live nodes"
(the donation service persists grant→node records; the grant layer must not
duplicate that tally or the two can drift).

### CLI (`bin/host.ts`)

Add a `grant` command group mirroring the existing `trust` group. These talk to the
running management API over loopback (thin HTTP clients), same as `invite`/`trust`:

```
cadre-host grant issue "Alice's cadre" [--max-nodes 2] [--ttl 30d]   # prints token (+ QR)
cadre-host grant list
cadre-host grant revoke <token>
```

The HTTP routes these hit (`POST /grants-admin`, `GET /grants-admin`,
`DELETE /grants-admin/:token` — an **admin** surface, distinct from the
grantee-facing `/grants` provisioning surface in `2-donation-service`) are mounted
by this ticket on the loopback management server. Keep the admin surface loopback
(no bearer — same-machine admin, per the existing local-UI "no login" posture); the
grantee-facing `/grants` surface in the next ticket carries the bearer gate.

## Edge cases & interactions

- **Reusable vs one-time**: a grant is reusable up to quota — do NOT copy
  trust-circle's redeem-then-consume. Test: issue maxNodes=2, validate for provision
  twice with liveNodeCount 0 then 1 (both ok), a third with liveNodeCount 2
  (`quota_exceeded`).
- **Expiry vs revocation**: both deny, with distinct reasons. Test each. A grant
  with `expiresAt` in the past validates `expired` even if not revoked.
- **Quota tally ownership**: the grant layer never counts nodes itself — it takes
  `liveNodeCount` as a parameter. Guard against a future refactor that tries to make
  the grant store authoritative for node counts (it can't see terminations).
- **Concurrent provision under the same grant**: two provision requests racing at
  quota boundary. This ticket's `validateForProvision` is a pure function of the
  passed count; the *serialization* (don't let two racers both pass at count = N-1)
  is the donation service's responsibility (`2-donation-service` edge cases). Note
  the boundary here so the next ticket owns the lock.
- **Empty/malformed bearer**: `validate('')` / unknown token → `unknown_token`, never
  throws.
- **grants.json corruption / absent**: absent = empty set (fresh install); a
  malformed file should fail loud on load (don't silently wipe grants — that would
  revoke everyone). Match `TrustCircleStore`'s existing load behavior.

## TODO

- [ ] `donation/types.ts` — `Grant`, `GrantDenyReason`, `GrantValidation`,
  `GrantValidator`.
- [ ] `donation/grant-store.ts` — atomic JSON store modeled on `TrustCircleStore`;
  unit tests for add/get/list/remove/markRevoked + absent/corrupt-file behavior.
- [ ] `donation/grant-service.ts` — `GrantService implements GrantValidator`; issue
  / validate / validateForProvision / revoke / list; unit tests for the quota,
  expiry, revocation, and malformed-token cases above.
- [ ] `bin/host.ts` — `grant issue|list|revoke` subcommands (loopback HTTP clients).
- [ ] Management-server routes `POST/GET/DELETE /grants-admin` (loopback, no bearer)
  wired to `GrantService`. (Route file can be `server/routes/grants-admin.ts`; the
  grantee-facing `/grants` file arrives in `2-donation-service`.)
- [ ] `yarn workspace @serfab/cadre-host build` + `test` + `yarn lint` green.
