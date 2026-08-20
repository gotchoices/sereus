----
description: The code carries several accommodations for older versions of itself — an alias kept for old monitoring setups, a one-time upgrade path for phones, an older way of calling one function, and an older on-disk config layout. There are no live installations to protect, so all of it should be removed now, while removing it is free.
files: packages/cadre-cli/src/server/health.ts, packages/reference-app-rn/src/secure-key-store.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-host/src/installer/config.ts, docs/architecture.md
difficulty: medium
----

# Retire every backwards-compatibility affordance while there is nothing live to break

## The standing decision

There are no live instances, no deployed data, and no external consumers pinned to our formats.
The project's position — stated in `AGENTS.md` as "No backwards compat yet" and reaffirmed by the
maintainer — is that compatibility is **not** a constraint right now, and that any break we know
we want should be taken **now**, while it costs nothing, rather than deferred until there is data
or deployments to migrate.

That inverts the usual default. This ticket is not "clean up some dead code"; it is "spend the
free window deliberately". A compatibility affordance kept past this window is a migration we
will have to write later.

## Scope

Every place the code accommodates an older version of itself. Each item below was located
directly; line numbers are from the tree at the time of filing and may drift.

### Confirmed — remove

**1. `cadre_peers_connected` metric alias.** `packages/cadre-cli/src/server/health.ts:72` declares
it and `:197` emits it, both commented as kept for back-compat with existing scrape configs. It is
a duplicate of `cadre_connections_total` with the same value. There are no existing scrape configs.

**2. The React Native one-time identity migration.** `docs/architecture.md:1145` ("One-time
migration") describes lifting a phone identity out of the old plaintext LevelDB
(`sereus-peer-identity`) into the platform enclave on upgrade, then clearing the plaintext copy.
It exists only to carry devices across an upgrade that no device has to make. Removing it deletes
the legacy read path, the clear-after-lift, and the ordering constraint it imposes on
`startPhoneNode` (`docs/architecture.md:1114` notes `loadOrCreateIdentityKey` must run *after* the
migration so it cannot pre-empt it — that constraint disappears with it). Update the docs section
in the same change; it is prose describing behaviour that will no longer exist.

**3. The legacy string overload of `formStrand`.** `packages/cadre-core/src/strand-solicitation.ts:295`
takes `invitation: OpenInvitation | string` and `:299` narrows with an explicit "Handle legacy API
where just token was passed". Drop the `string` arm and the narrowing; the parameter becomes
`OpenInvitation`. Check callers — the reference apps and integration scenarios are the likely
holders of the old shape.

**4. The `host.config.json` v1 → v2 migration.** `packages/cadre-host/src/installer/config.ts:157`
(`upgradeV1`) plus its `isV1Shape` guard and the schema-versions comment at `:8-12` exist to
silently upgrade v1 files written by installer 6.4.1. No such file exists in the wild. Collapse to
v2-only: delete `upgradeV1` and `isV1Shape`, and make a non-v2 `version` a load error. **Keep the
`version` field itself** — it is a forward guard, not an affordance, and the same is true of the
`version: 1` stamps on `grants.json`, `donations.json`, `nat.json`, and `trust-circle.json`, which
carry no migration code and should be left exactly as they are.

### Confirmed — decide the honest name, then take the break

**5. `@serfab/strand-proto` and the `/sereus/bootstrap/1.0.0` protocol id.** This is the subject of
`tickets/blocked/publish-deprecated-strand-proto-decision`, which asked a human whether we keep
publishing a package three separate places call deprecated. **The maintainer's directive answers
it: stop.** That ticket moves back into the pipeline alongside this one rather than being
duplicated here — treat it as the owner of the package deletion and the publish-chain removal.

What this ticket adds is the piece that ticket did not cover: `docs/strand-proto.md:4` says the
protocol id "remains `/sereus/bootstrap/1.0.0` for backward compatibility", and
`docs/architecture.md:518` says the live formation transport *mirrors* the non-deprecated
seed-bootstrap service. Establish whether any live protocol id is being held at a historical
string purely for compatibility and, if so, rename it to what it actually is. Resolve the
relationship between the two before emitting an implement ticket — do not hand the implementer a
"figure out if these are the same protocol" question.

### Verify before removing — may be current design, not debt

**6. The responder-provisions fallback.** `control-schema.ts:490` makes `FormationInvite.StrandId`
nullable, where null means "legacy responder-provisions path", and
`strand-formation-manager.ts:397` gives that fallback a three-arm precedence whose second arm is
"the legacy/mock contract". Arm 2 (`strandProvisioner` without a real recorder) looks like test
scaffolding that should go. **Arm 1 and the nullable column may be a real feature** — open invites
where the responder creates the strand — and the comment at `:405` records a plan-stage tradeoff
that deliberately chose *keep the fallback* over *remove it*. That is an accepted tradeoff; read it
before touching anything. If the nullable column is genuinely load-bearing, say so and leave it;
if only the mock arm is compat scaffolding, that is a much smaller change. Note that making
`StrandId` non-null is a **schema** break, which is exactly the kind this window exists for — so
the question is whether it is *wanted*, not whether it is affordable.

**7. `keyStore` absent ⇒ "legacy behavior".** `packages/cadre-core/src/types.ts:411`. Reading the
surrounding doc, this is naming rather than a compatibility path — "legacy" here means "the older
of two supported ways to supply a key", both of which are current. Likely a wording fix, not a
removal. Confirm and correct the wording rather than deleting a live path.

**8. "Missing/legacy column values are coalesced".** `control-database.ts:845` and `:913`. This
coalesces absent columns to empty forms so verify/freshness gates uniformly reject unpublished or
malformed rows. That reads as defensive handling of rows that were never published, not as version
compatibility. Probably keep; confirm and reword if "legacy" is misleading.

## Explicitly not in scope

These carry version markers that are **forward** guards — they exist so a future change can be
recognised, and none of them has a compatibility branch behind it today. Leave them:

- `strand-transport-key.ts:14` — the `.v1` domain-separation tag.
- `node-local-snapshot.ts:49` — the envelope version.
- The `version: 1` stamps on the cadre-host on-disk stores (see item 4).

## Edge cases & interactions

- **Deleting the metric alias is a public-surface change** for anything scraping `/health`. Check
  whether `cadre-host`'s UI, the reference apps, or `ops/` read `cadre_peers_connected` before
  assuming only external scrapers do.
- **The RN migration removal touches a security-sensitive path.** The failure mode to avoid is a
  device that reads `undefined` from the enclave and regenerates an identity when it should have
  raised a `KeyStoreAccessError`. The gated/ungated disambiguation described at
  `docs/architecture.md:1130` must survive the change untouched.
- **`formStrand`'s signature change ripples into the reference apps**, which are separate
  workspaces with their own type-check programs. A change that compiles in `cadre-core` can still
  break `reference-app-rn` / `reference-app-web`.
- **Any schema change (item 6) touches `schemas/*.qsql` as well as `control-schema.ts`**, and the
  control tables are network-backed — a column's nullability is part of what peers agree on.
- Removing `upgradeV1` changes a **load error path**: a malformed or old file must now fail
  loudly with a message that tells the operator what to do, not throw a shape error from deep in
  the parser.

## Sizing

Do not emit this as one implement ticket. Items 1-4 are independent and small; item 5 is owned by
its own ticket; item 6 needs its verification done before it can be sized at all. Split so each
implement ticket is a single coherent change, and chain with `prereq:` only where a real ordering
exists.
