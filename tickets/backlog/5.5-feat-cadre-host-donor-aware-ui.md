description: The cadre-host web dashboard was built assuming the machine runs its own cadre; now that most installs just donate nodes to friends, the dashboard should adapt so it stops showing broken "Trust Circle" and "Connectivity" pages those installs don't have.
files: packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/routes/Home.svelte, packages/cadre-host/ui/src/routes/TrustCircle.svelte, packages/cadre-host/ui/src/routes/Connectivity.svelte, packages/cadre-host/ui/src/lib/router.ts, packages/cadre-host/src/server/routes/status.ts

# Make the cadre-host local UI donor-aware

## Background

`demote-host-founder` (landed) made **node-donor** the default role for cadre-host
and gated the host running its **own** personal cadre (the "founder" role — owner
node + trust circle + NAT) behind an install-time flag `ownCadre.enabled` (default
**false**). On the server side this is clean: in donor-only mode `/auth/*` and
`/nat/*` are left unmounted and 404, and `GET /api/status` omits the `trustCircle`
and `connectivity` fields.

The **local UI SPA** (`packages/cadre-host/ui/`) was not updated to match. It was
built entirely around the founder role, so on a donor-only install (the new
default) it presents surfaces that don't exist:

- The **Home** page connectivity tile is stuck on "Loading connectivity…" forever,
  because `state.connectivity` is never populated (status omits it). The trust-circle
  tile shows a hardcoded-looking "0 members / 0 pending".
- The **Trust Circle** nav page calls `/auth/trust-circle` on mount → 404 → an error
  toast (`reportError('trust-circle', …)`).
- The **Connectivity** nav page calls `/nat/status` on mount → 404 → an error toast.

Nothing crashes — `state.svelte.ts` seeds safe defaults (`trustCircle: {members:[],
pending:[]}`, `connectivity: null`) and the templates guard `connectivity` with
`{#if}` — but a fresh default install's dashboard shows a permanently-loading tile
and two nav destinations that error when opened. That reads as broken.

## What this ticket is about

Make the SPA aware of which role the host is in and adapt:

- When the host is **donor-only**, hide or disable the founder-only nav items
  (Trust Circle, Connectivity) and the Home tiles that depend on them, rather than
  letting them 404. Surface the donor role instead (grants / donated-node status —
  note there is currently no grants view at all; that may be its own follow-up).
- When the host **is** a founder (`ownCadre.enabled`), the UI behaves exactly as
  today.

## Design notes / open questions (for the planner, not prescriptive)

- **How does the SPA learn the role?** Two options: (a) infer from the already-present
  signal — `GET /api/status` omitting `trustCircle`/`connectivity` — or (b) add an
  explicit role/`ownCadre` boolean to the status response so the client isn't guessing
  from absence. (b) is more honest and less fragile; it's a one-line add to
  `status.ts` (`StatusResponse`). Prefer an explicit flag.
- Consider whether the donor dashboard needs its own primary view (issued grants,
  live donated nodes per grantee). That overlaps with any future grants-UI work —
  scope it here or split, planner's call.
- Keep the founder path untouched; this is purely additive gating on the client.

## Also covers: the Strands page

`feat-cadre-host-strand-removal-screen` adds a third founder-only nav page, **Strands**
(`#/strands`, backed by `/api/strands`). It has the same problem for the same reason: on a
donor-only install the route is unmounted, so opening the page 404s into an error toast. That
ticket deliberately does *not* invent its own gating — it follows the existing Trust Circle /
Connectivity pattern so there is one problem with one fix. When this ticket is worked, treat
Strands as a third member of the founder-only set, not a separate case.

## Why backlog, not fix

No functional breakage and no crash — the server surface is already honest (404s +
omitted fields), and the SPA degrades to stale tiles + error toasts rather than
failing. This is a UX-completeness enhancement for the new default role, not a
correctness defect. Surfaced during review of `demote-host-founder`.
