description: The party-member table's last direct database writes now go through the one place that also refreshes who is allowed to talk to the node, a lint rule blocks new direct writes, and this pass verified all of it — tests, build, lint, and the lint rule itself.
files:
  - packages/cadre-core/src/control-database.ts (`insertCadrePeer` / `reauthorizeCadrePeer`; tripwire NOTE added this pass)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` / `reauthorizePeer` thin wrappers)
  - eslint.config.mjs (`no-restricted-syntax` guard + exemptions; comment clarified this pass)
  - packages/cadre-core/test/seed-bootstrap.spec.ts (two precedence tests)
  - packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts (6 dead lint directives removed this pass)
difficulty: easy
---

# CadrePeer write consolidation — complete

## What landed (across the chain)

Every write to `CadreControl.CadrePeer` now runs through `ControlDatabase`:
`insertCadrePeer` / `reauthorizeCadrePeer` / `deleteCadrePeer` / `updateSelfPeerRecord`.
Each wraps `mutateCadrePeer`, which refreshes the authorized-member snapshot the
control-traffic gate reads — the refresh a raw `getDatabase().exec(...)` silently skipped
(a mistake made twice before). `SeedBootstrapService` keeps only the owner-key
precondition, the signer callback, and one `select`; an ESLint `no-restricted-syntax` rule
fails the build on a literal `CadrePeer` insert/update/delete written anywhere outside
`control-database.ts` and the two constraint fixtures. Docs (`architecture.md`,
`STATUS.md`) updated with the new shape.

This review pass validated the whole chain and closed the loose ends the implement passes
left open.

## Verification run this pass

- `yarn lint`: **0 errors, 0 warnings** (after the fix below; was 0/6).
- `yarn workspace @serfab/cadre-core test`: **83 files, 1315 passed, 1 skipped.**
- Targeted re-run after this pass's edits (`seed-bootstrap`, `control-membership-hub`,
  `control-write-lock`): 93 passed.
- `yarn workspace @serfab/cadre-core build` and root `yarn build`: both exit 0 (root build
  emits the pre-existing chunk-size warning from the web app — unrelated).

## Review findings

**Signature equivalence — checked, correct.** The move swapped the signing call from
`signDigest(cadrePeerVoucherDigest(peerId, stampId))` (base64url sha256 string) to
`signMessageBytes(buildAuthorizationMessage('CadreControl.CadrePeer', 'vouch', [...]))`
(raw sha256 bytes). Both build the same field vector via `controlAuthorizationFields`, and
`signMessageBytes` base64url-encodes the bytes into `signDigest`, whose `sign` decodes
base64url — so the signed bytes are identical and the schema's `AuthorizedInsert` /
`AuthorizedUpdate` checks see the same signature as before. Also exercised end-to-end: the
specs that drive these paths run against a real Quereus database with the CHECKs live.

**ESLint guard — independently re-verified.** Linted a synthetic snippet through
`eslint --stdin --stdin-filename packages/cadre-core/test/probe-tmp.spec.ts` (no file
written, no tree fixture): the rule fires on both the template-literal and plain-string
forms with the intended message. The exempt files lint clean in the full run.

**Docs — checked, current.** No stale references to `insertCadrePeerRow` or
"`SeedBootstrapService`'s direct SQL" survive anywhere in `docs/` or package sources; the
`architecture.md` write-queue paragraph and the `STATUS.md` lint-coverage bullet both
describe the shipped shape.

**Minor, fixed in this pass:**

- `yarn lint` reported 6 warnings against `docs/STATUS.md`'s "exits 0 with 0 warnings,
  0 errors" claim. Root cause was not the doc: the repo configures **no `no-console` rule
  at all**, so the six `// eslint-disable-next-line no-console` directives in
  `zz-scratch-delete-alone.integration.ts` were dead. Removed them; lint is back to 0/0 and
  the doc is true again. The prior pass proposed filing this as a `debt-` backlog ticket —
  unnecessary, it was a six-line deletion.
- The 1 skipped test in the suite is `key-store.spec.ts:231`,
  `it.skipIf(process.platform === 'win32')` on POSIX file-mode behavior — a
  platform-conditional skip on a Windows host, not an unfinished test. Identified so it
  stops getting re-flagged.

**Tripwires (recorded, not ticketed):**

- `reauthorizeCadrePeer` reads the row's `StampId` *outside* the write lock. A concurrent
  delete in that window makes the `update` match zero rows while the method still returns
  `true` and notifies. Harmless today (its only caller logs the result; a spurious notify
  costs one re-read), and a delete-then-re-add fails loudly instead because the signature
  binds the retired stamp. `NOTE:` at the method's doc block in `control-database.ts`.
- The lint guard is blind to an *unqualified* `insert into CadrePeer` as well as to SQL
  assembled from variables — every control statement in the tree names the schema, so this
  is a copy-paste guard, not a bypass barrier. Noted in the rule's comment in
  `eslint.config.mjs`.

**Test coverage — judged sufficient, nothing added.** The two tests the implement pass
added only pin error precedence (control-database check first in `insertCadrePeerRow`,
owner-key check first in `reauthorizePeer`); both were re-read against the sources and are
correct. Behavioral coverage of the moved code already exists elsewhere and was re-run:
`control-write-lock.spec.ts` (the insert race that exercises the in-lock existence check
returning `false`), `cadre-node-control-replication.spec.ts` (re-touch queueing, the
vanished-row path, self-`Sig` skip), `control-membership-hub.spec.ts` (the
`peer-insert`/`peer-reauthorize`/`peer-remove` notify reasons), `control-revocation-replay.spec.ts`
(the re-touch's signature shape against the live CHECK).

**Major findings: none.** No new `fix/`, `plan/`, or `backlog/` tickets filed.

**Pre-existing failures: none.** No `tickets/.pre-existing-error.md` written.

**Observation, not acted on:** `control-database.ts` is now ~2016 lines and this chain
added ~150 of them. Splitting the class is a larger decision than this ticket's scope
(the write lock, the membership hub, and every guarded writer are deliberately co-located
so the non-re-entrancy rule is readable in one file), so it was left alone rather than
half-split here.
