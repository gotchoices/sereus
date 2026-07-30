description: A party owner still has no way to remove one of the shared networks their party belongs to; add the node-level operation that performs the removal and makes every other node in the party stop running that network.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/test/validation-key-enrollment.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/README.md, docs/architecture.md, docs/STATUS.md
difficulty: hard
----

<!-- resume-note -->
A prior agent run was interrupted by BUDGET_WARNING mid-implementation. **The source code
changes are DONE and uncommitted in the working tree** — do not redo them; verify and
continue from "Remaining work" below.

## Already done (verify in working tree, do not rebuild)

- **Rename `CadreNode.removeStrand` → `stopStrand`** — landed in
  `packages/cadre-core/src/cadre-node.ts` (~line 3370 after the insertion below), with the
  new doc comment stating: local stop only, the shared `Strand` row stays, rediscovered as
  `strand:discovered` on restart, party-wide removal is `unpublishStrand`. Behaviour
  unchanged. Both spec call sites updated (`cadre-node.spec.ts` — the former `:145` and
  `:234` calls now say `stopStrand`; grep confirms zero `removeStrand` references remain
  anywhere).
- **New `CadreNode.unpublishStrand(strandId)`** — landed in `cadre-node.ts` immediately
  after `publishStrand` (~line 2930), exactly per the original ticket shape:
  `requireOwnerSigningKey` → `requireNonBlank` → `controlDatabase.deleteStrand` →
  `committedAlone()` loud log (wording modeled on `noteControlWrite`'s remove branch; NOT
  queued in `pendingPeerWrites`) → `strandWatcher?.forcePoll()` → explicit
  `stopStrand(trimmed)` fallback if `strandManager.getInstance(trimmed)` still present →
  final success log with owner key. Full doc comment covers: owner-only / removes-our-
  participation-only / not "destroy the network"; closed-strand `MemberPrivateKey`
  destruction is irreversible; id not blacklisted (owner re-publish re-seats, unsigned
  consent re-seat foreclosed forever); outstanding bound `FormationInvite`s unredeemable;
  sibling convergence lag; delete-while-alone caveat referencing docs/architecture.md +
  control-delete-while-alone-tombstone; absent-row no-op still stops a local instance.
- `requireOwnerSigningKey` doc comment's caller list now includes `unpublishStrand`.
- **README** (`packages/cadre-core/README.md` API table): `removeStrand` row replaced with
  `stopStrand`, plus new `publishStrand` and `unpublishStrand` rows.

## Remaining work

- [ ] **New spec `packages/cadre-core/test/strand-unpublish.spec.ts`** per the "Test plan"
      section below (the original ticket's plan with corrections from this run's findings).
- [ ] **docs/architecture.md** — in the control-layer Strand narrative (the numbered list
      item 1 around lines 535-538, which already covers removal tombstones/consent
      foreclosure), add: party-wide removal is owner-signed (`CadreNode.unpublishStrand` →
      `ControlDatabase.deleteStrand`), removes this party's participation only, and a
      closed strand's `MemberPrivateKey` is destroyed with the row. Cross-reference the
      existing "Delete-while-alone durability" bullet at architecture.md:192 — do not
      restate it.
- [ ] **docs/STATUS.md** — **finding: the entry claiming "nothing calls `deleteStrand`"
      does NOT exist** (searched exhaustively: no match for deleteStrand / removeStrand /
      strand removal / in-memory only / never touches anywhere in STATUS.md; the claim
      lives only in archived tickets under tickets/complete/, which are not edited).
      Instead ADD a new `[x]` bullet recording the capability, next to the validation-key
      enrollment bullet under "### Inviting another user / cross-party strand formation"
      (docs/STATUS.md:739) — same shape as that entry: `CadreNode.unpublishStrand` is now
      the first caller of `ControlDatabase.deleteStrand`; local-stop renamed `stopStrand`;
      operator-facing command lands in sibling `feat-strand-removal-cli`.
- [ ] `yarn build`, `yarn lint`, `yarn dep-check`, `yarn --cwd packages/cadre-core test`
      (stream via `2>&1 | tee`, never silent redirect). **None of these have been run yet
      this ticket** — the new `unpublishStrand` code is unbuilt and untested.
- [ ] Write the review/ handoff (distilled summary + honest gaps) and delete this ticket.

## Findings that correct the original test plan

- **Stopped-node error shapes DIFFER between the two methods** — the original ticket said
  both throw the "must be started" shape; wrong. `stopStrand` keeps its pre-existing
  `'CadreNode not running'` throw (behaviour unchanged per decision 2 — rename only);
  `unpublishStrand` throws via `requireOwnerSigningKey`:
  `/must be started before attempting to unpublish strand/`. Pin each actual message.
- Blank-id ordering: `unpublishStrand` calls `requireOwnerSigningKey` BEFORE
  `requireNonBlank` (matches `removeValidationKey`'s ordering), so a blank id on a
  stopped node reports not-started, not blank. The blank-id test needs a started node;
  expect `/required/i` (the `requireNonBlank` message shape, as
  `validation-key-enrollment.spec.ts:203` pins).
- Convergence-test safety verified: default `StrandFilter` is `{mode:'all'}`
  (`strand-watcher.ts:69`), `StrandInstanceManager.startStrand` returns the existing
  instance on duplicate id (`strand-instance-manager.ts:183-186`), `stopStrand` no-ops on
  unknown id — so publish + addStrand + watcher polling cannot double-start, and the
  watcher-fires vs explicit-stop paths cannot double-stop.
- Useful helpers confirmed: `ControlDatabase.queryStrandStampId(strandId)`
  (control-database.ts:566) for reading the stamp before removal;
  `generateStrandMemberKey` exported from `src/strand-member-key.ts` (also via index);
  `queryStrands()` returns `{Id, MemberPrivateKey, Type}` rows (control-database.ts:380).

## Test plan (carried over from original ticket, with corrections above)

Copy the `startSelfOwnerNode` harness from `validation-key-enrollment.spec.ts:43-60`
verbatim (fresh libp2p Ed25519 key → node with `profile:'transaction'` →
`insertOwnerKey(publicKeyB64)`; 60 s timeout per case). Adapt its `revocationRow` helper
(`:62`) to `TableName='Strand'`.

- publish → `queryStrands()` contains it → unpublish → `queryStrands()` empty, and the
  `Revocation` row `(TableName='Strand', StampId=<row's stamp read via
  queryStrandStampId BEFORE removal>, RowKey=<id>)` exists.
- unpublish of a never-published id resolves, writes no tombstone.
- Blank / whitespace-only id rejects before any write (started node; `/required/i`).
- Stopped node: `stopStrand` rejects `/not running/`; `unpublishStrand` rejects
  `/must be started before attempting to unpublish/`.
- Closed strand: publish `Type='c'` with a `generateStrandMemberKey()` value, unpublish,
  row + `MemberPrivateKey` gone.
- Re-publish after unpublish succeeds with a fresh stamp (pins "id not blacklisted").
- Local convergence: combine the harness with `cadre-node.spec.ts:39-60`'s
  `createStrandConfig` fixture (signed sApp schema via `signSchema` +
  `generatePrivateKey`/`getPublicKey`) — `addStrand` + `publishStrand`, then
  `unpublishStrand`, assert `node.getStrands()` lacks the id by the time the promise
  resolves (pins the force-poll + explicit-stop step). Works in this spec directly; no
  need to split into cadre-node.spec.ts.

Edge cases NOT to re-test (already pinned at the DB layer by
`control-authorization-binding.spec.ts:627-740`): non-owner signer refused, replay of the
original add-approval refused, owner re-publish mechanics, tombstone transactionality.

## Decisions already made — do not re-open

All decisions from the original ticket stand and are now IMPLEMENTED in the doc comments:
owner-only (no cross-party agreement); two methods not a flag; approval = the node's own
owner key via `requireOwnerSigningKey`; closed-strand hard-warning lives in the doc
comment here, the CLI confirmation gate is sibling ticket `feat-strand-removal-cli`
(implement/5.1, prereq on this slug — do not rename this ticket's slug).
