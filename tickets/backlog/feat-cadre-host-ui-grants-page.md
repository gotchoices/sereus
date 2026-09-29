description: Give the cadre-host dashboard a page for managing who may borrow nodes from this machine — issuing, listing and revoking the invitation tokens friends use — which today can only be done from the command line, even though donating nodes is what most installs are for.
prereq: feat-cadre-host-donor-aware-ui
architecture: docs/cadre-host.md#node-donation-the-primary-role
files: packages/cadre-host/ui/src/App.svelte, packages/cadre-host/ui/src/lib/router.ts, packages/cadre-host/ui/src/lib/state.svelte.ts, packages/cadre-host/ui/src/routes/Home.svelte, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/bin/host.ts, docs/cadre-host.md
tradeoffs: The `cadre-host grant` CLI already covers issue/list/revoke/terminate on the same machine the dashboard runs on, so this is convenience for non-technical donors rather than new capability, and handing a grant token to the browser widens where a bearer secret is displayed.
----

# Grants page in the cadre-host dashboard

## Situation

Node donation is cadre-host's primary role: a friend holding a **grant token** asks the host for cadre nodes, up to that grant's `maxNodes`. The host owner manages grants through the loopback, no-bearer admin surface `/grants-admin` — `GET` (list), `POST` (issue: `label`, optional `maxNodes`, `ttlMs`), `DELETE /grants-admin/:token[?keepNodes=true]` (revoke, terminating the grant's nodes unless kept), `DELETE /grants-admin/donations/:id` (end one donated node). The only client today is the `cadre-host grant issue|list|revoke|terminate` CLI in `src/bin/host.ts`.

After `feat-cadre-host-donor-aware-ui`, a donor-only dashboard shows a Donation tile on Home that tells the user to run `cadre-host grant issue <label>` and a Terminate button on each donated node — but no way to see or manage grants.

## What to build

A **Grants** page (`#/grants`), shown in both roles (donation is always on):

- List grants: label, max nodes, live donated nodes under it, expiry, revoked state.
- Issue a grant: label, optional max nodes, optional lifetime; show the resulting token once, with a copy button and a QR code (the SPA already has `components/QrCode.svelte`, used for trust-circle invites), matching what `cadre-host grant issue` prints.
- Revoke a grant, with a confirmation that states how many donated nodes will be shut down, and an option to keep them running (`keepNodes`).
- Link from each grant to its donated nodes on the Nodes page, and replace Home's CLI hint with a link to this page.

## Open points for the planner

- The live-node count per grant is not in `GET /grants-admin`'s response (`Grant` carries no count; the tally lives in `DonationStore.liveNodeCount`). Either extend the list response or have the page join against `/api/nodes`.
- Whether the full token should appear in the list after issue (the CLI's `grant list` prints it) or only at issue time.
- A `grants-changed` server-sent event, so a CLI issue/revoke updates an open page, versus refresh-on-focus.
