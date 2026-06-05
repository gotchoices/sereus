description: COMPLETE — browser reference drives the consent/invitation strand-formation flow (responder + initiator), closed-strand membership, and `CadreControl` authorization-gate ("RBAC") observability. Reviewed: found + fixed a defect in the authority-gate probe (it was rejecting on an incidental column/context error, not the `Strand.Authorized` gate); strengthened the e2e to make the demonstration self-verifying. typecheck + svelte-check + lint + build + full e2e green.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/relay-config.ts, packages/reference-app-web/src/lib/network.svelte.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-web/src/lib/diagnostics.svelte.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/src/Diagnostics.svelte, packages/reference-app-web/e2e/solo/formation-rbac.spec.ts, packages/reference-app-web/e2e/global-setup.ts, packages/reference-app-web/README.md, docs/architecture.md
----

# Complete: browser consent/invitation formation + closed strands + RBAC observability

The browser reference moved beyond the Phase-1 solo open strand: it drives the
cadre-core strand-formation API (responder `createOpenInvitation`/`encodeInvitation`
+ initiator `decodeInvitation`/`formStrand`/closed-strand `addStrand`), reserves a
circuit relay for dialability, and surfaces the `CadreControl` authorization gates
("RBAC") on Diagnostics. Single-tab paths are automated and green; live two-party
convergence remains deferred to `reference-app-web-formation-convergence-e2e`
(backlog).

Implement commit reviewed: `5a218b4`.

## Review findings

### Checked
- **Implement diff read fresh** (`5a218b4`, ~1.4k LOC) before the handoff summary:
  `cadre-web.ts` formation machinery, `relay-config.ts`, `network.svelte.ts`,
  `store.svelte.ts`, `chat-strand.ts`, `diagnostics.svelte.ts`, `Home.svelte`,
  `Diagnostics.svelte`, the new `formation-rbac.spec.ts`, `global-setup.ts`, and
  the README/architecture docs.
- **cadre-core API surface the web app binds to** (resolves to `dist/`, not src):
  confirmed `CadreNode.initializeStrandSolicitation / createOpenInvitation /
  encodeInvitation / decodeInvitation / formStrand / addStrand / getControlDatabase
  / getControlNode / peerId / isRunning` and `ControlDatabase.queryStrands /
  getDatabase` all exist in the built `.d.ts` with matching signatures, and that
  `OpenInvitation` / `FormStrandResult` / `StrandFormationDisclosure` field shapes
  match the call sites (e.g. `partyId` is a real `StrandFormationDisclosure` field;
  `queryStrands()` returns `{ Id, Type, MemberPrivateKey }`).
- **The load-bearing RBAC claim** (the authority-gate probe) against the actual
  `Strand` table schema (`control-schema.ts`) and the canonical authorized-insert
  path (`control-database.ts insertStrand`).
- **Docs** re-read against the new reality (README RBAC/formation sections,
  `architecture.md` reference-apps paragraph).
- **Removed/renamed exports** (`networkState`/`setSeedInput`/`seedInput`, the
  `seed-input` testid) — confirmed no dangling consumers in `src/` or `e2e/`.
- **Validation re-run from scratch** (see below).

### Found + fixed (minor — fixed inline this pass)
- **The authority-gate probe was rejecting for the wrong reason** — the headline
  risk the handoff itself flagged (use-case #1), and it was real.
  `attemptUnauthorizedStrandWrite` issued:
  ```sql
  insert into CadreControl.Strand (Id, Type, MemberPrivateKey)
    with context AuthorityKey = ?, Signature = ?, StampId = ?
    values (?, 'o', null)
  ```
  But the `Strand` table's context is exactly `(AuthorityKey, Signature)` — there
  is **no `StampId` context variable** — and `StampId` is a `not null unique`
  **column**. So the probe (a) bound `StampId` as a non-existent context var and
  (b) omitted the required `StampId` column. The write was therefore rejected by an
  incidental column/context error, **not** the `Strand.Authorized` CHECK it claims
  to demonstrate — giving a false "gate is live ✓" that would survive even if the
  authorization gate were removed.

  **Fix** (`cadre-web.ts`): mirror the canonical `insertStrand` shape — context is
  `(AuthorityKey, Signature)`, and `StampId` is supplied as a fresh unique column
  value (`rbac-probe-stamp-${crypto.randomUUID()}`):
  ```sql
  insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
    with context AuthorityKey = ?, Signature = ?
    values (?, 'o', null, ?)
  ```
  With the not-null/anti-replay column satisfied and a bogus non-enrolled
  authority key + bogus signature and no consuming `FormationUsage` row, the
  **only** failing condition is `Strand.Authorized` (no authority matches; no
  consent row) — so the rejection genuinely is the authority gate. This also makes
  the README's "the `CadreControl` constraint rejects it at commit" claim true,
  which it previously was not.
- **Made the demonstration self-verifying** so it can't silently regress to a
  masked rejection: added `data-testid="diag-gate-detail"` to the probe's surfaced
  error in `Diagnostics.svelte`, and extended `formation-rbac.spec.ts` to assert
  the error text contains `Authorized` (Quereus emits `CHECK constraint failed:
  Authorized`). The probe now proves *which* gate fired, in CI.

### Found, not fixed (already filed — left for the deferred convergence work)
- **Live two-party convergence remains unautomated** (the implement handoff's
  gap #1). The `createInvitation`/`joinViaInvitation`/`formStrand` paths are
  typechecked + reachable but never run against a real second party; they need a
  circuit-relay reservation, a dialable second cadre, and the DB-backed consent
  wiring. Already filed as
  `tickets/backlog/reference-app-web-formation-convergence-e2e.md` — no new ticket.
- **`joinViaInvitation` stores `result.invitePrivateKey` as the row's
  `MemberPrivateKey`** (while reporting `result.memberKey` to the UI). That field
  choice is plausible (the row wants the private signing key) but is **unverified**
  — it is only exercised on the live-convergence path, which has no coverage. Folded
  into the backlog convergence ticket as an explicit thing to assert when that path
  is wired; not chased here because a solo node can't validate it.
- **Closed-strand-membership negative test** still deferred: the schema's "member
  key only if closed" constraint is a TODO (`control-schema.ts` `Strand`), so a
  clean solo negative assertion isn't meaningful yet. Covered by the same backlog
  ticket.

### Not found (explicitly clear)
- **No dangling references** to the removed Phase-1 seed exports/testid.
- **No regression** to the Phase-1 solo posture: boot / messages / reload /
  routing / diagnostics / schema-gate specs all still green with no relay
  configured.
- **No new build/typecheck/lint warnings**: only the pre-existing ~3 MB chunk-size
  and db-p2p dynamic-import warnings, unchanged.

## Validation (all green, re-run during review)
- `yarn workspace @serfab/reference-app-web typecheck` → exit 0.
- `svelte-check` → 0 errors, 0 warnings, 0 files with problems (682 files).
- `eslint packages/reference-app-web/src/lib/cadre-web.ts` → exit 0.
- `yarn workspace @serfab/reference-app-web build` → exit 0 (pre-existing warnings only).
- `yarn playwright test --project=chromium` (full suite) → **25 passed, 8 skipped,
  0 failed**. The strengthened authority-gate test now asserts the rejection is the
  `Authorized` constraint; the 8 Tier-2 `e2e/distributed/*` specs skip via the
  convergence-deferred fixture gate.

## Pre-existing failures
None surfaced by the e2e or web-app build; `tickets/.pre-existing-error.md` not
written.

Note (not a failure, disclosure only): the working tree carried uncommitted
changes to `packages/cadre-core/src/{control-database,index}.ts` and
`packages/integration-tests/src/**` at review start. These are **unrelated to this
ticket** (this ticket's surface is `reference-app-web` + docs), predate this pass,
and the web app compiles against cadre-core `dist/` rather than that src, so they
do not affect this ticket's validation. Left untouched.

## Out of scope (carried forward to backlog)
Live two-party formation→convergence e2e, a headless/relay responder fixture,
the closed-membership negative test, and confirming the `MemberPrivateKey` field
choice on the formed strand — all tracked in
`tickets/backlog/reference-app-web-formation-convergence-e2e.md`.
