----
description: Review a documentation rewrite — the cadre-host docs now describe its real main job (running spare nodes on your always-on machine that join *other people's* cadres) instead of the outdated "host your own cadre" framing; check the rewrite is accurate and honest about what is actually built versus still in progress.
prereq:
files: docs/cadre-host.md, docs/architecture.md, docs/STATUS.md
difficulty: medium
----

# Review: cadre-host donor-model docs realignment

## What changed (implement summary)

This is **Part A** of the original `4-donor-docs-and-integration` ticket. Part B (the
cross-package node-donation integration test) was split into a separate implement
ticket — see [Why this was split](#why-this-was-split) below.

The docs were realigned around the corrected model: **cadre-host donates nodes (run as
OS-managed child processes) to *external* cadres — the requester's device stays the
authority, and the host holds no owner key — with running the host's *own* cadre demoted
to an opt-in "founder" role.** The prior docs codified the wrong model throughout
("wants a cadre node for themselves", "cadre-host runs on a machine that *does* hold the
admin's owner identity").

### `docs/cadre-host.md`

- **Intro + "Who it's for"** reframed: primary persona is contributing nodes to friends'
  / family's cadres; running your own cadre is secondary/opt-in.
- **New "Node donation (the primary role)" section** — the grant-token gate
  (`/grants-admin` + `cadre-host grant`), the end-to-end `/grants` lifecycle (provision →
  peer → phone `addDrone` → seed → terminate) with an ASCII sequence, the
  **pinned-owner-key cold-start-trust** requirement (`CADRE_OWNER_KEYS`), the
  **seedToken-stays-host-side** rule, an explicit **status** sub-section (what's landed vs
  in progress), and the **loopback-only reachability caveat** pointing at the WAN backlog
  ticket. Mirrors the provider's container-lifecycle framing.
- **Control-plane separation** — corrected the drifted claim that the host "*does* hold
  the admin's owner identity": it holds an owner key **only** in the opt-in own-cadre
  role; donated nodes pin the *requester's* key and the host holds none. Added a per-role
  breakdown and a marker that the sections that follow are the founder role.
- **Trust circle** — reframed with a lead callout that it is the founder-role own-cadre
  membership mechanism, unrelated to grant-token-gated node donation.
- **Status** — added a "Node-donor realignment (in progress)" paragraph (landed: grant
  layer + pin-key wiring + donation store; in progress: `/grants` routes + `DonationService`
  + reap; deferred: WAN); marked `cadre-host-owner-node.integration.ts` as the opt-in
  founder scenario; grant CLI added to the CLI bullet.

### `docs/architecture.md`

- **Provider Integration** — added a blockquote pointer: cadre-host is a **second
  `Orchestrator` implementation of the same donate-a-node contract** (OS child processes
  instead of Docker), a sibling **donor**, not a founder; recipient stays the authority.
- **`addDrone` helper** — one-line pointer that the same helper backs the cadre-host
  donation flow (step 3).
- **`@serfab/cadre-host` package section** — retitled ("Founder role complete; donor
  lifecycle in progress"), summary reframed donor-primary, added a "Node donation (donor
  role, primary)" bullet.

### `docs/STATUS.md`

- New "Cadre-host node-donation realignment" checklist: donor-primary + founder-opt-in,
  grant layer + pin-key wiring landed (`[x]`), `/grants` + `DonationService` + reap in
  progress (`[~]`), WAN + the integration test deferred (`[ ]`).

## How to validate

Docs-only change — **no build/test/lint impact** (markdown is outside the TS/lint gate).
Validate by reading against the code:

1. **Read `docs/cadre-host.md` top-to-bottom.** Confirm the donor model reads as primary
   and the founder sections are unambiguously marked opt-in. Check the "Node donation"
   sequence matches the intended flow.
2. **Spot-check the honesty of the status claims** against HEAD:
   - Landed: `packages/cadre-host/src/donation/{grant-service,grant-store,types,donation-store}.ts`,
     `server/routes/grants-admin.ts`, and the `createContainer` → `CADRE_OWNER_KEYS`
     wiring at `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts:220-253`.
   - **Not** landed (correctly described as "in progress"): there is no
     `donation/donation-service.ts`, no grantee-facing `server/routes/grants.ts`, no reap
     sweep, and no `POST /grants` in the tree.
3. **Check the anchor links resolve** (`#node-donation-the-primary-role`,
   `#two-roles-donor-and-founder`, `#control-plane-separation-load-bearing-principle`,
   `architecture.md#provider-integration`).
4. **Cross-check for residual founder-centric drift** the rewrite may have missed
   elsewhere in `cadre-host.md` (e.g. the deployment-model intro, the architecture
   sketches) — the review adversarial pass should hunt for any remaining "the host owns
   the cadre" framing outside the marked founder sections.

## Honest gaps & things to probe (treat this as a floor)

1. **The docs describe the `/grants` provisioning lifecycle as a fixed *design*, not as
   shipped code.** The `DonationService` and grantee-facing `/grants` routes are Phase 2/3
   of `implement/2-donation-service`, which is **not yet complete** (it sits in
   `implement/` with a resume note). The docs flag this explicitly ("in progress"), but a
   reviewer should confirm the framing can't be misread as "already works." If
   donation-service's final route/method names diverge from what's documented here, the
   Node-donation section will need a follow-up touch-up when it lands.
2. **`architecture.md` package header** now says "Founder role complete; donor lifecycle
   in progress." If the reviewer feels "(Complete)" should be preserved for release-notes
   consistency, that's a judgment call — flag it, don't silently revert; the point is not
   to claim the donor lifecycle is done when it isn't.
3. **No prose linter runs here.** Typos / broken tables / dead anchors are only caught by
   reading. The adversarial pass is the only gate.

## Why this was split

The original `4-donor-docs-and-integration` bundled the docs (Part A) with a
cross-package integration test (Part B) that drives `DonationService.provision` /
`applySeed` / `getPeer` / `terminate` and the `/grants` HTTP surface. **Those do not
exist yet** — `2-donation-service` completed only its Phase 1 (orchestrator pin-key
wiring) plus the donation store/types before erroring; its Phase 2/3 (`DonationService`,
`/grants` routes, reap) are absent (confirmed by the `3-demote-host-founder` review
handoff). A test importing a non-existent class can't compile, so it could not ship green
alongside the docs. Part B was therefore refiled as
`implement/4-donor-node-donation-integration.md` with `prereq: donation-service`, so the
runner picks it up once that surface actually lands. The docs (no such dependency) ship
now.

## Review disposition

Minor doc inaccuracies → fix inline. Anything about the missing `DonationService` /
`/grants` surface belongs to `2-donation-service` — don't re-file it. If the review finds
the docs materially misdescribe a *landed* behavior, that's a real finding; route genuinely
new work to `fix/` or `backlog/` with a clear slug.
