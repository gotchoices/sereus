----
description: A shared workspace's read secret used to double as the founder's identity, letting any participant act as the founder. The founding party now gets its own private identity key, minted and stored separately, so the shared secret grants reading only.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/control-authorization.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-member-key.ts, packages/cadre-core/test/control-strand-party-key.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/integration-tests/src/harness/strand-join.ts, docs/strands.md, docs/architecture.md
----

# Complete: strand party member key (founder half of the identity/read-secret split)

First of the four-ticket `strand-party-member-key` → `strand-formation-membership-invite` → `strand-node-binds-member-peer` → `strand-party-removal-via-formation-e2e` chain. A closed strand's founding `Strand.Member`/`Strand.Manager` identity no longer derives from the strand-wide `Strand.MemberPrivateKey` — the key formation hands to *every* joining party, so any joiner could recompute the founding manager's private key and sign as it (gotchoices/sereus#4). It derives from a new per-party key instead.

## What landed

**New control table `CadreControl.StrandPartyKey`** (`control-schema.ts`, mirrored byte-equivalent in `schemas/control.qsql`): `Id` (strand id, primary key), `PrivateKey` (this party's ed25519 strand member private key, base64 protobuf — same encoding as `MemberPrivateKey`, decoded by `strandMemberKeyPair`), `StampId` (unique single-use nonce). Constraints follow the `ValidationKey` idiom: `NotRevoked` / `RevocationRecorded` / `NoUpdate` / owner-signed `AuthorizedInsert` over `digest('CadreControl.StrandPartyKey','add', Id, PrivateKey, StampId)` — the key material is deliberately in the digest, so a captured approval can only ever reproduce the exact key it approved — and a `'remove'`-tagged `AuthorizedDelete` with **no REAP branch** (the key is stored nowhere else, same stance as `Strand`). `Revocation.RowIsGone` gained the matching branch; `CONTROL_TABLES` and `RevocableTable` gained the name; `REAPABLE_TABLES` deliberately excludes it. A side table rather than a `Strand` column because a joining party holds no control `Strand` row at all yet still needs its own key, and because it leaves the heavily-audited `Strand` insert digest untouched.

**ControlDatabase**: `queryStrandPartyKey`, `queryStrandPartyKeyStampId`, `insertStrandPartyKey`, `deleteStrandPartyKey`; and `deleteStrand` now runs a two-table body (`deleteStrandAndPartyKey`) that removes the strand's party-key row — its own remove signature, its own `Revocation` tombstone — in the **same transaction** as the `Strand` row, so no crash window orphans an identity and a re-publish always mints fresh. The companion delete runs only when a `Strand` row is actually removed: a party-key row with no `Strand` row is a joiner's identity (the next ticket's shape) and only `deleteStrandPartyKey` touches it. The guarded-delete listener fires once per tombstone (two for a closed strand), and the write-while-alone re-issue queue is keyed by stamp, so both ride it.

**CadreNode**: `publishStrand` of a closed strand mints (insert-if-absent) the party key after the row insert, and heals on its idempotent branch when the stored row is self-founded. `launchStrand` for a closed strand resolves the key — explicit attach-time key, else the `StrandPartyKey` row, else (only when the row's `FounderOwnerKey` is this machine's own owner key) mint-and-persist, the heal for pre-split strands — and retains it in the launch config, so hibernation wakes rebuild under the same identity. Non-founding machines never mint. New public `ensureStrandPartyKey(strandId, key?)` (mint-or-adopt; throws on a conflicting supplied key; adopts the landed row on a lost concurrent-seat race). `unpublishStrand` documents the party-key removal riding along.

**Bootstrap**: `StrandDatabaseConfig` gained `partyMemberPrivateKey`; `deriveFounderKeyPair` decodes it and throws loudly naming `StrandPartyKey` for closed+founder+keyless — the shared `MemberPrivateKey` is *not* accepted as a fallback. `StartStrandConfig` and `StrandConfig` (`addStrand`) gained the same optional field; `foundExistingStrand` takes a lazy key resolver so a joiner-launched closed instance later flipped to founder still gets a key (the resolver runs only when the retained config lacks one, so the common watcher re-entry stays read-free).

**Docs**: `docs/strands.md` → "Closed-Strand Member Key Handling" rewritten around the two-key split; `docs/architecture.md` brought in line during review (see findings); `strand-member-key.ts` doc comments updated.

**Harness**: `joinStrandOn` gained `partyMemberPrivateKey` (minted by default, injectable), passed in-memory to the founder's `addStrand` and — under `publish:` — also persisted via `ensureStrandPartyKey` so publish's own mint cannot diverge.

## Review findings

### Checked

The implement diff was read in full before the handoff summary: schema + qsql, `control-authorization.ts`, `control-database.ts`, `cadre-node.ts`, `strand-database.ts`, `strand-instance-manager.ts`, `strand-member-key.ts`, `types.ts`, every changed spec, the integration harness and the four changed scenarios.

Cross-cutting enumerations swept for a missed entry: `CONTROL_TABLES` and its consumers, `RevocableTable`, `GUARDED_KEY_COLUMN`, `REAPABLE_TABLES` / `isReapableTable` / the reap sweep, every `tableName === '…'` and `TableName = '…'` literal in `src`, the guarded-delete listener and the tombstone re-issue drain (keyed by stamp, so the two tombstones of one closed-strand removal queue independently — correct), and `strand-revocation-enforcer.ts` (strand-layer, genuinely unaffected).

**Every call site that founds a closed strand, across all nine packages.** `reference-app-web`, `reference-app-rn`, `reference-app-ns`, the web Playwright formation-responder fixture, `blind-relay-phone-to-phone-e2e`, `strand-late-cadre-join`, `strand-formation-cross-party-seed`, `cadre-host` / `cadre-cli` / `cadre-provider` (which found no strands at all). All either route through `foundStrand`/`publishStrand`, which mints, or attach as joiners, which needs no key. No caller regressed into the new loud throw.

**The divergent-identity hazard the split could have introduced.** Before, two machines of one party both "founding" a closed strand derived the *same* `Member.Key` from the row's shared secret, so the bootstrap's insert-if-absent guards stayed idempotent across replicas; with per-party identity they could have derived different keys and seated two `Member` rows. It is closed, and not by accident: `isSelfFoundedRow` compares the row's `FounderOwnerKey` to *this machine's* identity-derived owner key, so only the publishing machine ever resolves as founder or mints.

**Read-filter symmetry.** Neither `queryStrand` nor `queryStrandPartyKey` filters retired stamps, and neither table is reapable — so a node that converges on a tombstone while holding the row keeps reading it. That is the pre-existing `Strand` property, not something this ticket introduced, and removal still propagates as a replicated delete (pinned by `strand-unpublish-sibling-convergence`, re-run green). No new gap, nothing filed.

**Docs**, including the files the change *should* have touched — which is where the substantive finding was.

### Found and fixed in this pass (minor)

- **`docs/architecture.md` was never touched, and is the entry-point doc.** Its "Strand Membership Bootstrap → Closed strand" bullet still stated that the founding `Member.Key` and `Manager.MemberKey` are *derived from* the control-layer `MemberPrivateKey` via `strandMemberKeyPair` — a description of exactly the vulnerability this ticket removed. Corrected, and with it eight other statements in the same file that had gone false: the control-table list (no `StrandPartyKey` row at all), `Revocation`'s table enumeration and its reap-exclusion sentence, the two delete-while-alone exclusion sentences, the claim that `removePeer`/`clearDeviceToken`/`deleteStrand`/`deleteValidationKey` "all four share one implementation, `ControlDatabase.deleteGuardedRow`" (`deleteStrand` no longer does), the layer-1 key description, `unpublishStrand`'s irreversibility paragraph, `publishStrand`'s idempotency bullet, the founder plumbing path, the closed-strand e2e description, and the "Closed-strand member keys — accepted residual risk" section.
- **`docs/strand-contracts.md` and `docs/strand-contracts-review.md`** both asserted that per-party member keys "are minted only in tests" and that every party presents the same key. Still true for joiners, no longer for the founder. Narrowed to say so and pointed at `strand-formation-membership-invite` for the remaining half.
- **`packages/reference-app-web/src/lib/cadre-web.ts`** doc comment claimed `foundStrand`'s genesis seats Header/Member/Owner from `MemberPrivateKey`.
- **`control-database.ts`** reap-sweep doc listed the non-reapable tables as `(Strand, OwnerKey)`.
- **`control-start-storage-op-budget.spec.ts`** was half-updated: the WARM paragraph still read "52 operations over 22 blocks" against a constant of 46, its "one above cold" arithmetic was stale (cold moved to 20), and COLD had *dropped* its genuine-write count rather than re-measuring it. Re-measured under `--reporter=verbose`: cold **169 ops / 20 blocks / 131 writes**, warm **46 / 22** — reproduces the committed numbers exactly. Restored the write count and fixed the warm figures.
- **`ensureStrandPartyKey`** resolved the owner signing key before validating the strand id, so a blank id reported the wrong problem. Order swapped.
- **`addStrand` silently dropped `partyMemberPrivateKey` for an open strand.** An open strand seats no `Member`/`Manager`, so the key went nowhere and the caller's confusion about which of the two keys they held was hidden. Now throws naming the mismatch. (The integration harness already validated this; the public API did not.)

### Test gaps closed (5 new tests; 1 existing test strengthened)

The implementer's suite was a genuinely good starting point — the gaps were on security claims the schema comments make but nothing exercised:

- `AuthorizedDelete`'s distinct `'remove'` action tag exists so the never-expiring *insert* approval cannot be replayed as a removal. That replay was unpinned; now asserted (with the tombstone filed in the same transaction so only `AuthorizedDelete` can reject).
- `Revocation.RowIsGone` gained a `StrandPartyKey` branch with no coverage — a standalone tombstone retiring a *live* row's stamp was untested. Now asserted.
- `ensureStrandPartyKey`'s conflicting-key throw and its adopt-on-repeat were untested public API paths.
- The **joiner→founder flip with no party key** — the edge the handoff flagged as uncovered. Now pinned: the flip throws naming `StrandPartyKey` and mints nothing, rather than seating an identity the strand's RBAC layer will not match.
- `addStrand`'s new open-strand guard.
- Strengthened the pre-existing "closed strand attached first as a joiner, later founded" test, which counted rows only, to assert `Member.Key` is the party key's public half and **not** `strandMemberKeyPair(MemberPrivateKey)`.

### Major findings: none — and why

No ticket filed, deliberately rather than by omission. The four things that would have been major were each looked for and each found closed: a regression in any closed-strand founding path (none, across all nine packages), divergent founding identities between a party's machines (closed by per-machine `isSelfFoundedRow`), an orphaned identity row on any removal path (the two-table transaction covers it, and the joiner-row case is both deliberate and tested), and a read-filter asymmetry between the two non-reapable tables (symmetric with pre-existing `Strand` behaviour). Everything else resolved to a minor fix or a tripwire.

### Tripwires (parked as `NOTE:` at the site, not filed)

- `cadre-node.ts` → `resolveStrandPartyKey`: the mint gate is the *row's* provenance, not the launch's resolved `founder` flag, so an explicit `founder: false` over a row this machine itself published would still mint — an owner-signed write the caller did not ask for. Harmless and unreachable today (the one explicit `founder: false` caller passes a null `FounderOwnerKey`); the NOTE says to gate on the resolved flag if that ever changes.
- `control-database.ts` → `deleteStrandAndPartyKey`: it duplicates `deleteGuardedRow`'s per-clause discipline rather than generalizing it. Correct today; the risk is drift if either side tightens. NOTE says to grep for both, and to generalize rather than copy a third time if a second guarded table ever gains a companion row.
- `control-start-storage-op-budget.spec.ts`: table count → block count is **not** one-to-one — adding the ninth control table moved the cold start *down* from 172 ops / 21 blocks to 169 / 20. That is block packing, not a saving to bank on; NOTE says re-measure rather than predict.

### Accepted tradeoffs left alone

The handoff's "explicit `StrandConfig.partyMemberPrivateKey` is an in-memory seam, not persistence" is the documented shape, not a defect: the production paths (`foundStrand`/`publishStrand`, watcher relaunch) always persist, and the intended users of the explicit seam — the harness and the closed-strand e2e — found from hand-built rows whose nodes are not enrolled owners and so cannot write the control row at all. Verified, not re-litigated. Likewise `strandRowMismatches` / `adoptPublishedStrand` are correctly untouched: the party key lives outside the `Strand` row and no test asserts otherwise.

### Size debt

`wc -l` → 6496 `cadre-node.ts`, 2803 `control-database.ts`. Appended as an evidence arm to the existing `tickets/backlog/debt-cadre-node-single-file-size.md` (whose own measurement table was stale by ~1,700 lines) rather than filed fresh, noting that `ControlDatabase`'s per-table writer groups are the same kind of cut.

### Pre-existing failures

None surfaced. The single skip in the cadre-core run is the known platform-conditional skip in `key-store.spec.ts`; `cadre-host`'s four skips are likewise pre-existing. Nothing written to `tickets/.pre-existing-error.md`.

## Validation

All run in the foreground on 2026-09-10, after every change above:

- `yarn lint` → exit 0; `yarn build` → exit 0 (all workspaces).
- `@serfab/cadre-core`: **115 files, 1960 passed, 1 skipped** (was 1955 passed; +5 from this pass).
- Every sibling workspace green: `quereus-plugin-sereus` 112, `cadre-cli` 232, `cadre-host` 626 (+4 pre-existing skips), `cadre-provider` 222, `reference-app-ns` 103, `reference-app-rn` 192, `reference-app-web` 66.
- Integration, real network: `harness-topology` 7/7, `strand-membership-closed-strand-e2e` 9/9, `strand-unpublish-sibling-convergence` 1/1 (added by this review — `deleteStrand` became a two-table transaction, so sibling convergence on the second tombstone wanted a live-network run). The implementer's earlier green runs of `strand-membership-second-machine`, `strand-removal-cuts-network` and `blind-relay-phone-to-phone-e2e` stand; nothing in this pass touched those paths.
- Logs under `tickets/.logs/1-strand-party-member-key.review.*.log`.

## Downstream

The joiner half — persisting a formation-issued party key and delivering invites against it — is `strand-formation-membership-invite`. The seams it consumes are `queryStrandPartyKey` / `insertStrandPartyKey` / `deleteStrandPartyKey`, `CadreNode.ensureStrandPartyKey`, and `deleteStrand`'s rule of leaving alone a party-key row that has no `Strand` row.
