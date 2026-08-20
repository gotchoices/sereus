----
description: The phone app's one-time upgrade step that moved a device's identity key out of an old unencrypted store into the secure hardware store has been deleted, along with the code and docs that supported it. No device ever needed the step.
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/test/secure-key-store.spec.ts, docs/architecture.md, docs/reference-app-rn.md
----

# Complete: removal of the React Native legacy-identity migration

Pure deletion plus doc/comment rewrites. No behaviour added. The React Native app
now reads its node identity only from the platform secure enclave; the one-time
lift from the older plaintext store is gone, along with the plaintext store's
reader, deleter, and database-name constant.

## What shipped

**`packages/reference-app-rn/src/secure-key-store.ts`** — the trailing
legacy-migration section removed: the `LegacyIdentityMigrationOutcome` union, the
`LegacyIdentityMigrationDeps` interface, and `migrateLegacyIdentity`. 384 to 316
lines. Everything above that banner is byte-identical.

**`packages/reference-app-rn/src/cadre-phone.ts`** — `PEER_IDENTITY_DB_NAME`,
`readLegacyIdentityBytes`, `deleteLegacyIdentity`, the `migrateLegacyIdentity`
import, and the `await migrateLegacyIdentity({...})` call that opened
`startPhoneNode`. The ordering comment above `loadOrCreateIdentityKey` now states
only the still-true constraint (before `loadIceConfig`, whose manifest request is
signed with the node identity).

**`packages/reference-app-rn/test/secure-key-store.spec.ts`** — the six
`migrateLegacyIdentity` tests. 392 to 301 lines. The suites guarding the
access-vs-absence contract are untouched.

**`docs/architecture.md`** — the "One-time migration" paragraph retitled "No
migration path"; the ordering clause upstream trimmed to match.
**`docs/reference-app-rn.md`** — the two sentences describing the migration
rewritten as prose about the behaviour that now exists.

## Review findings

### Checked and clean

- **The access-vs-absence contract in `SecureStoreKeyStore.get` is untouched.**
  This was the security property the ticket was told to protect: a thrown read
  raises `KeyStoreAccessError` rather than reporting the slot empty, so a
  transient failure can never make the app regenerate over a live identity.
  Confirmed structurally, not by trusting the summary — the diff of
  `secure-key-store.ts` is a single hunk beginning after the class's closing
  brace, containing only deletions. No hunk reaches inside the class body.
  Confirmed behaviourally too: `SecureStoreKeyStore — access vs absence`,
  `— gated null discriminator`, and `— index consistency` all still run.
- **No orphaned imports or helpers.** Every symbol the deletion could have
  stranded is still used: `DEFAULT_IDENTITY_KEY_ID` and `openLevelDb` in
  `cadre-phone.ts` (the latter by both the per-strand storage factory and the
  node-local record store), `LevelDB` / `LevelDBWriteBatch` inside `openLevelDb`,
  and `sameBytes`, `KeyStoreAccessError`, and `vi` in the spec. The lone
  surviving `vi.spyOn(console, 'warn')` belongs to the corrupt-index test, not to
  the removed legacy read.
- **Straggler sweep, redone independently.** `migrateLegacyIdentity`,
  `LegacyIdentityMigration`, `readLegacyIdentityBytes`, `deleteLegacyIdentity`,
  `PEER_IDENTITY_DB_NAME`, and the literal `sereus-peer-identity` have no hits
  left outside `tickets/` except in `packages/reference-app-ns/` and the
  NativeScript sections of `docs/`. That is a different app on a different
  storage engine, on a live code path; leaving it alone is correct.
- **Documentation matches the new reality.** Read every file the change touched
  and the neighbours it should have. `docs/architecture.md` and
  `docs/reference-app-rn.md` each keep one clause of history (earlier development
  builds used plaintext MMKV, then plaintext LevelDB) and state plainly that no
  upgrade path exists from either. That history earns its space: the plaintext
  LevelDB is referenced two paragraphs earlier in the architecture doc, and
  deleting the mention entirely would leave that reference dangling. The two
  copies are two sentences in two documents with different audiences — not worth
  a shared source. `packages/reference-app-rn/README.md` never mentioned the
  migration and needed no edit.
- **Nothing between the old call site and the identity resolve depended on the
  migration having run first.** The intervening code opens a different LevelDB
  database (`sereus-node-local`) and reads a different secure slot
  (`sereus.anchor.<partyId>`, outside the `sereus.ks.` namespace the identity
  uses). The "No migration is needed" comment further down `startPhoneNode` is
  about the trusted-owner anchor — a separate record — and remains true.

### Found and fixed in this pass

- **Stale comment in `packages/reference-app-rn/src/node-local-slots.ts`.** The
  doc comment on `NODE_LOCAL_DB_NAME` justified the separate database as
  protecting "the identity migration path" that no longer exists, and described
  itself as "not the legacy identity's" database — a distinction from something
  now gone. Trimmed to the one true reason: it is its own database so clearing it
  cannot disturb replicated strand data. The straggler sweep missed this because
  the file names neither a deleted symbol nor the database.

### Recorded as a tripwire, not filed

- **A development device still holding the orphaned plaintext identity database
  keeps an unencrypted key on disk that nothing now deletes.** It is never read —
  the app generates a fresh identity into the enclave — which is the intended
  consequence of this ticket, but the plaintext copy also no longer gets cleaned
  up, because the code that cleaned it up was the migration. No shipped build
  ever wrote that database, so there is nothing to do today. Parked as a `NOTE:`
  beside the secure-store options in `cadre-phone.ts`, saying that if such a
  device is ever found, the answer is to delete the database on start rather than
  revive an import path.

### Filed as a new ticket

- **`tickets/backlog/debt-rn-cadre-phone-lifecycle-untested.md`** — the React
  Native app's `cadre-phone.ts` has no test of any kind, while the equivalent
  NativeScript module has a thorough one. Four rules the file's own comments call
  load-bearing are verified by nobody: identity resolved before the
  relay-credential fetch, no second database handle on a re-entered start, a
  refused enclave read failing the start rather than falling back, and the
  database handle closing even when stopping the node throws.

  This gap predates the ticket and no coverage was lost here (the deleted tests
  exercised `migrateLegacyIdentity` in isolation, never through `startPhoneNode`).
  It is filed because this diff is what makes the gap concrete: it removed a
  statement from the front of `startPhoneNode` and rewrote the comment describing
  what that ordering guaranteed, and nothing in the repository would have objected
  had it been wrong. Filed as one general test rather than four point tests —
  these are one class of defect, the start/stop sequence silently changing, and a
  single suite catches the next edit too. No open ticket claimed the site.

### Empty categories

- **No bugs found.** The reviewed change is a deletion of an unreferenced code
  path plus comment and prose rewrites; there is no new logic to be wrong, and the
  behaviour it removed was gated on a store that no shipped device populated.
- **No accepted-tradeoff `NOTE:` was overridden.** None of the sites touched
  carries one.
- **No pre-existing test failures.** Nothing was written to
  `tickets/.pre-existing-error.md`.

## Validation

All from repo root, all green, run after the review's own edits were in place:

| Command | Result |
| --- | --- |
| `yarn workspace @serfab/reference-app-rn typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-rn test` | 10 files, **184 tests passed** |
| `yarn lint` | exit 0 |

## Known limits of this verification

- **No device or emulator run.** Everything here is type-check, unit test, lint,
  and reading. `startPhoneNode` has no unit test in this package — that is the gap
  the new backlog ticket describes — so "the app still starts and resolves its
  identity" is verified by types and by reading, not by execution.
- **`yarn workspace @serfab/reference-app-rn test:bundle`** (`expo export`) was
  not run; it routinely exceeds the ten-minute agent budget and belongs to CI or a
  human. It is the only check that would catch a bundler-visible breakage the
  TypeScript program misses. The diff adds no imports and removes only
  unreferenced symbols, so the risk is low.
- **The stale `openLevelDb` banner comment in `cadre-phone.ts` was rewritten
  opportunistically** by the implementer; it was wrong before this ticket too
  (it claimed the peer identity lived in LevelDB). Reviewed and kept — it is now
  accurate, and leaving a known-false comment in place to preserve a tight diff
  would be the worse trade.

## User-visible consequence

A development device holding only a plaintext identity generates a fresh identity
into the enclave rather than importing the old one — a new PeerId and owner key.
That is the intended effect of the ticket. No shipped build is affected.
