----
description: Strand membership/RBAC schema (strand.qsql) is never applied to strand databases
files: schemas/strand.qsql, packages/cadre-core/src/strand-database.ts, packages/quereus-plugin-sereus/src/connect.ts, docs/architecture.md
----

## Problem

Sereus's central promise is that each strand is a shared SQL database that is an
invitation-only, consent-based trust domain with role-based permissions
(README.md:3,13; docs/architecture.md). That guarantee is meant to be enforced
at the SQL layer by `schemas/strand.qsql`, which declares `declare schema Strand`
with the tables `Header`, `Invite`, `Member`, `Authority`, `ConsumedInvite`, and
`MemberPeer`. These tables carry insert-only, signature-verifying (`verify()`)
check constraints that gate joins, invite consumption, and role assignment — e.g.
`Invite.InviteValid`, `ConsumedInvite.ValidUsage`, `Member.Authorized`,
`Authority.Authorized`, `MemberPeer.Authorized` — and the open vs closed
distinction via `Header.Type in ('o','c')` with the `OnlyClosed` constraints.

This schema is never applied to a live strand database. `StrandDatabase.executeSchema`
(packages/cadre-core/src/strand-database.ts:184-200) wraps and applies ONLY
`this.config.sAppConfig.schema` inside `declare schema App { ... } apply schema App;`.
The plugin SQL surface does the same: `packages/quereus-plugin-sereus/src/connect.ts:151-161`
applies only the passed-in sApp `schema` under `declare schema App`. Nothing in
cadre-core or quereus-plugin-sereus ever applies `schemas/strand.qsql`, and no
runtime code creates, populates, or queries `Member`, `Invite`, `Authority`,
`ConsumedInvite`, or `MemberPeer`.

## Divergence from stated goals

Because the membership/authority schema is absent from the running database:

- There are no membership tables, so there is no invite-gated or authority-gated
  join path and no record of who belongs to a strand.
- The signed-write constraints in `strand.qsql` (the `verify()`-based `check`
  clauses, including the `with context (...)` signature parameters) never execute,
  so authority-gated role changes and invite consumption are unenforced.
- The open vs closed (`Header.Type` `'o'`/`'c'`) distinction and the `OnlyClosed`
  constraints are inert; there is no per-table / per-column / per-row RBAC layer.
- Any write authorization that the sApp does not itself replicate is unprotected,
  so the product's central consent/RBAC guarantee is not actually in force on a
  live strand. docs/architecture.md:58 already acknowledges this gap.

## Expected behavior

The strand membership/authority schema must be applied to each strand database
alongside the sApp DDL, so that both runtime paths that bring up a strand database
(cadre-core's `StrandDatabase` and the `quereus-plugin-sereus` SQL surface) share
the same enforced membership/authority model. The consent/RBAC enforcement model —
invite-gated membership, authority-gated role changes and authority rotation, and
signature-verified (`verify()`) writes carrying their `with context (...)`
signature parameters — must be represented and active at the SQL layer rather than
left to each sApp to re-implement. The open/closed (`Header.Type`) behavior and the
`OnlyClosed` constraints should take effect as specified in `schemas/strand.qsql`.

## Use case / specification notes

- A closed strand must reject a `Member` insert that is neither the first member,
  nor authorized by an existing `Authority`, nor backed by a `ConsumedInvite`.
- An `Invite` may only be created by an existing `Authority` and must prove
  possession of the invite key; consuming it must record a `ConsumedInvite` and
  admit the corresponding `Member`.
- `Authority` membership changes (including bootstrap of the first authority and
  subsequent rotation) must satisfy the `Authority.Authorized` constraint.
- `MemberPeer` associations must be signed by the member they bind.
- The Strand-level tables and the App-level sApp schema must coexist in the same
  strand database without name collision (the sApp DDL is currently isolated under
  schema `App`; the membership schema is declared under schema `Strand`).

## Key references

- `schemas/strand.qsql` — full membership/invite/authority/RBAC schema (currently unused at runtime).
- `packages/cadre-core/src/strand-database.ts:184-200` — `executeSchema`, applies only sApp DDL under `declare schema App`.
- `packages/quereus-plugin-sereus/src/connect.ts:151-161` — plugin SQL surface, applies only sApp DDL under `declare schema App`.
- `docs/architecture.md:58` — acknowledges that the membership/RBAC schema is not yet wired in.
