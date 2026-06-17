description: A private group's creator now writes the group's identity record and seats itself as the first owner; a node that merely joins writes nothing and waits to sync. Reviewed and accepted, with one production-wiring gap filed as follow-up.
prereq:
files: packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, docs/architecture.md
----

## What landed

The first runtime *writer* of the layer-2 `Strand.*` membership/RBAC tables. On a strand's
**founder**, a one-time idempotent bootstrap runs at bring-up (`StrandDatabase.initialize()`,
gated on `founder === true`): always a `Strand.Header`, and for a closed strand the founding
`Member` + `Authority` derived from the control-layer `MemberPrivateKey`. A **joiner** writes
nothing and relies on Optimystic sync. Also landed the shared signing/key-bridge primitives the
later invite/peer/rotation tickets reuse (`signStrandPayload`, `strandMemberKeyPair`).

See the implement commit `25097c5` and the original review ticket for the full module/plumbing
breakdown. The architecture doc gained a "Strand Membership Bootstrap" subsection.

## Review findings

Adversarial pass over the implement diff (`25097c5`), read first with fresh eyes against
`schemas/strand.qsql` and the launch plumbing, then against the handoff's self-identified probes.

### Validation (all green)
- `yarn workspace @serfab/cadre-core typecheck` → exit 0.
- `npx eslint` over all changed files (incl. the edited spec) → exit 0.
- `npx vitest run` (full cadre-core suite) → **37 files / 494 tests pass** (was 493; +1 new
  reopen-idempotency test added this pass).

### Checked — correct, no action
- **Signing idiom vs. schema.** `signStrandPayload` hashes the `'|'`-joined payload to raw bytes
  and ed25519-signs those bytes; the `Strand.*` constraints `verify(digest(payload,'sha256',
  'utf8'), sig, pubkey,'ed25519')` with default base64url encodings. Raw-byte signing is
  equivalent to signing the base64url-decoded message, so signer and verifier agree. Pinned by a
  real-plugin round-trip test (and a wrong-payload negative). The byte construction is what the
  later invite/peer/rotation constraints will hash — the forward primitive is safe to reuse.
- **Type safety.** `StrandRow.Type` is `'o' | 'c'`, matching `StrandDatabaseConfig.strandType`
  exactly — no widening/laxity through the plumbing. `buildStrandRuntime` is the sole constructor
  of `StrandDatabaseConfig`; typecheck confirms every call site supplies the now-required
  `strandType`.
- **`founder` flag routing.** Traced `addStrand → launchStrand → startStrand → buildStrandRuntime
  → StrandDatabase`. The control-discovered join path (`handleStrandAdded`) never sets `founder`,
  so a discovering peer only syncs. `startStrand` dedupes on `instances.has(strandId)`, so a
  founder's *own* later `onStrandAdded` callback returns the existing instance — no double-launch
  and no founder-vs-joiner conflict on one node. `resumeStrand` retains `founder` in the launch
  config; re-running the bootstrap on a hibernation wake is a no-op via the count guards.
- **Partial-failure recovery.** Per-table `select count(1)` guards are independent, so a crash
  between the Header and Member inserts is healed on the next run (Header skipped, Member +
  Authority inserted) — no stranded keyless closed Header (validated before any write).
- **Deferred `OnlyClosed` ordering.** Header commits (auto-commit per `db.exec`) before the
  deferred subquery checks on Member/Authority evaluate — exercised by the real-DB tests.
- **Count-based idempotency (probe #4).** Correct for a true founder (member #1): the only path
  to the bootstrap is `founder:true` on the founding node, which founds before any sync delivers
  foreign rows. No path reaches it with foreign rows present and the founder's own row absent.
- **Docs.** `docs/architecture.md` subsection matches the landed behavior. `docs/strands.md`
  membership sections are explicit TODOs that defer to architecture.md (not made stale).
  `docs/STATUS.md` is high-level and not contradicted by this writer. Engine columns
  (`STRAND_ENGINE`/`EngineVersion`) are documented placeholders — acceptable.

### Minor — fixed inline this pass
- **Cross-connection (reopen) idempotency was untested (probe #2).** The existing idempotency
  test re-ran the bootstrap on the *same live connection*. Added
  `is idempotent across a reopen: a fresh DB over persisted storage re-runs without duplicating
  rows` to `test/strand-membership-writer.spec.ts`: a cold session bootstraps a closed strand and
  shuts down; a fresh `Database` over the same persisted `MemoryRawStorage` hydrates the rows
  (asserted seated *before* any new write — proving a true reopen, not a fresh insert), then
  re-running the bootstrap is a no-op (counts stay 1/1/1, no `InsertOnly`/PK violation). This is
  the real cross-process restart path the count guards exist for. (Refactored the `openStrandDb`
  helper to accept an optional `strandId`+`storage` for reopen; full suite still green.)

### Major — filed as new ticket
- **Founder bootstrap is dead in production: no real caller sets `founder:true`
  (probe #1, confirmed not captured).** Every closed-strand *creator* path
  (`createClosedChatStrand` in reference-app-web/rn/ns) pairs `publishStrand(…, 'c', key)` with an
  `addStrand` that omits the flag, so the bootstrap never fires in any real bring-up — a created
  closed strand has no `Header`/`Member`/`Authority` and can never admit anyone. The e2e ticket
  `strand-membership-closed-strand-e2e` passes `founder:true` only inside its own test harness
  (a directly-constructed `StrandRow`), not the production creator flows, so the follow-up the
  implementer asked us to confirm is **not** otherwise captured. Filed
  `tickets/backlog/wire-founder-flag-into-strand-creators.md` (prereq:
  `strand-membership-invite-join`) to wire the flag into the real creator/host/responder callers
  and decide the founder predicate for the formation path.

### Deferred — already owned elsewhere (no action)
- Networked founder→joiner sync (founder bootstraps, joiner receives rows via sync without
  re-inserting) is explicitly owned by `strand-membership-closed-strand-e2e` (ticket 4).
- `signStrandPayload`/`strandMemberKeyPair` runtime consumers (invite minting/consumption,
  MemberPeer publication, authority rotation) are owned by tickets 2–3.

## Validation performed (review)
- typecheck exit 0; eslint exit 0; `vitest run` → 37 files / 494 tests pass.
