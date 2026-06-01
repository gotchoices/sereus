----
description: Web reference app validates Optimystic-in-a-browser but exercises none of the Sereus cadre/strand/control-network/RBAC stack
files: packages/reference-app-web/package.json, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/src/lib/messages.svelte.ts, docs/architecture.md
----

`reference-app-web` is presented as the browser Sereus reference app, but in
its current form it validates only the Optimystic transport/storage layer in a
browser — not the Sereus consent/strand/control-network/RBAC stack that the
product's cross-platform claims rest on.

## How it diverges from Sereus's goals

The package has no dependency on `@serfab/cadre-core`
(`packages/reference-app-web/package.json:15-28` lists `@optimystic/db-core`,
`@optimystic/db-p2p`, `@optimystic/db-p2p-storage-web`, `@optimystic/demo`,
libp2p, svelte — and nothing from the cadre runtime). Instead it instantiates a
bare libp2p node and drives `@optimystic/demo`'s `MessageApp` through a
`Local`/`NetworkTransactor` (`src/lib/optimystic.ts:19-48,143-195`;
`src/lib/messages.svelte.ts:15,80`).

As a result the browser surface instantiates none of the Sereus primitives:

- No `CadreNode`.
- No `ControlNetwork` / `CadreControl` schema.
- No `StrandInstance` / strand lifecycle.
- No sApp schema-signature verification.
- No role-based permissions (RBAC).
- No consent / invitation / schema-gated join flow.

The README is honest that the app's scope is the Optimystic-in-a-browser
demonstration, so this is a scope/design gap rather than misrepresentation. But
the consequence is that every stated Sereus goal that is supposed to be
cross-platform — consent-based strands, the control network, role-based
permissions, schema-gated join — is currently unvalidated in the browser
environment. Cross-platform claims today cover the storage/transport layer
only, not the product.

## Expected behavior

A browser reference that exercises the cadre/strand/control-network/RBAC path,
so that the cross-platform story is validated for the Sereus product and not
just the Optimystic transport. Concretely, the browser reference should bring
up a `CadreNode`, participate in a control network under the `CadreControl`
schema, form or join a `StrandInstance` through the consent/invitation flow
with sApp schema-signature verification, and exercise role-based permissions —
mirroring what the node/RN references already cover.

Alternatively, if browser validation is intentionally scoped to the Optimystic
transport for now, that decision should be made explicit and documented (in the
app README and in `docs/architecture.md`) so that the cross-platform claims are
not read as covering the full stack in the browser. Either outcome closes the
gap; the unacceptable state is the current implicit one where the browser app
reads as the "Sereus web reference" while silently bypassing the Sereus stack.

## Use case

A developer or evaluator opening the browser reference to confirm that Sereus's
consent/strand/RBAC model works on the web should be able to drive (or read a
clear statement of) the cadre path in the browser, rather than discovering that
the web reference only demonstrates Optimystic message storage.

## References

- `packages/reference-app-web/package.json:15-28`
- `packages/reference-app-web/src/lib/optimystic.ts:19-48,143-195`
- `packages/reference-app-web/src/lib/messages.svelte.ts:15,80`
- `docs/architecture.md` (cross-platform / reference-app coverage)
- Related (different concern, schema-gate enforcement in cadre-core, not the web app): `sapp-schema-signature-gate-bypassable`
- For RN-side reference coverage of strands: `reference-app-rn-strand-selection`
