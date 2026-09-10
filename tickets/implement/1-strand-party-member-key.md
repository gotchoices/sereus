----
description: The secret that lets everyone read a shared workspace currently doubles as the founder's identity, so any participant can act as the founder. Give the founding party its own private identity key so identity and the shared read secret are separate things.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-member-key.ts, packages/integration-tests/src/harness/strand-join.ts, docs/strands.md
difficulty: hard
----

# A party's strand identity must stop deriving from the shared strand secret

First of a four-ticket chain (`strand-party-member-key` → `strand-formation-membership-invite` → `strand-node-binds-member-peer` → `strand-party-removal-via-formation-e2e`) that gives each party on a closed strand its own membership identity. This ticket is the founder half; the joiner half needs the formation changes in the next ticket.

## The gap

A closed strand's founding `Strand.Member` / `Strand.Manager` rows are seated with a keypair derived from the control-layer `Strand.MemberPrivateKey` (`strand-database.ts` `deriveFounderKeyPair` → `strandMemberKeyPair`). But formation hands that same `MemberPrivateKey` to **every joining party** (`FormationProvisionResult.memberPrivateKey`) — it is the strand-wide read secret. So every party on a production closed strand can compute the founder's member *and manager* private key: any joiner can sign as the founding manager, admit members, revoke members, and cannot itself be meaningfully removed (gotchoices/sereus#4). Identity and the shared secret must be two different keys.

## Design (settled)

**New control table `StrandPartyKey`** in `CONTROL_SCHEMA` (`control-schema.ts`, mirrored in `schemas/control.qsql` — keep both byte-equivalent per the existing drift discipline):

```
table StrandPartyKey (
    Id text primary key,            -- the strand id this key is for
    PrivateKey text not null,       -- THIS party's ed25519 strand member private key, base64 protobuf
                                    -- (same encoding as Strand.MemberPrivateKey; decode with strandMemberKeyPair)
    StampId text not null unique,
    -- NotRevoked / RevocationRecorded / NoUpdate / AuthorizedInsert / AuthorizedDelete
    -- following the ValidationKey idiom: owner-signed insert over
    -- digest('CadreControl.StrandPartyKey', 'add', Id, PrivateKey, StampId), remove-tagged delete,
    -- stamp retired into Revocation on delete.
) with context (OwnerKey text, Signature text);
```

Why a separate table and not a column on `Strand`: a **joiner** holds no control `Strand` row at all (reference apps attach formed strands with an in-memory `StrandRow`; see `cadre-web.ts` `joinViaInvitation`), yet the next ticket needs the joiner to persist its own party key too. A side table keyed by strand id serves founder and joiner uniformly, and leaves the heavily-audited `Strand` insert digest untouched. Deliberately **no** "closed strands only" cross-table check: the joiner writes this row without any local `Strand` row to check against.

The row is party-private in the same sense `MemberPrivateKey` is: it replicates to every machine the party owns (that replication is what lets any of the party's machines sign membership writes — same fungibility argument, same accepted plaintext-at-rest risk as documented in `docs/strands.md` → "Closed-Strand Member Key Handling"). Unlike `MemberPrivateKey` it is **never** put on the formation wire.

**Founder mints at publish, heals at launch.** `CadreNode.publishStrand` for a closed strand mints a party key (`generateStrandMemberKey`) and inserts the `StrandPartyKey` row alongside the `Strand` row. `launchStrand`, when it derives founder-ness (`FounderOwnerKey` == own owner key) for a closed strand and finds no `StrandPartyKey` row, mints and inserts one before starting the strand (covers strands published before this change, and any publish path that skipped the mint). Insert-if-absent; only the founding machine heals, so no mint race between party machines.

**Bootstrap consumes the party key.** `StrandDatabaseConfig` gains `partyMemberPrivateKey`; `strand-instance-manager.ts` threads it from the launch config; `deriveFounderKeyPair` decodes it via `strandMemberKeyPair` instead of `MemberPrivateKey`. A closed strand founding with no party key throws, exactly as the missing-`MemberPrivateKey` case does today.

**`MemberPrivateKey` is demoted, not removed.** It stays the strand-wide secret formation delivers (the future read-gate / key-rotation story), it stays in the `Strand` row and digest — it just no longer derives anyone's identity. After this ticket its only production consumer is the formation passthrough. Update `docs/strands.md` → "Closed-Strand Member Key Handling" to state the split, and the `strandMemberKeyPair` doc comment in `strand-member-key.ts` (it currently says the founding keys derive from `MemberPrivateKey`).

## Edge cases & interactions

- **Founder restart / re-`addStrand`**: mint-if-absent must be idempotent — a second launch finds the row and reuses it; the founding `Member.Key` must be stable across restarts or the bootstrap's insert-if-absent guards stop matching.
- **Non-founding machines of the founder party**: they read the replicated `StrandPartyKey` row; they never mint. A sibling that launches the strand before the row replicates must not fail bring-up — it is not the founder (`FounderOwnerKey` mismatch), so bootstrap never runs there and the key is only needed later (next tickets' retry loops).
- **Open strands**: no party key is minted, threaded, or required — bootstrap stays Header-only.
- **Consent-seated strands** (unbound formation, open/keyless): unaffected; no `StrandPartyKey` row.
- **`adoptPublishedStrand` equality check** (`strandRowMismatches`): the party key lives outside the `Strand` row, so no change to the row-comparison contract — verify no test asserts otherwise.
- **Strand removal**: when a `Strand` row is deleted (unpublish path), delete the strand's `StrandPartyKey` row in the same act (delete + `Revocation` tombstone), so a re-published strand mints fresh identity.
- **Schema evolution**: there is no control-schema migration mechanism (`apply schema` only adds missing objects) — a brand-new table is exactly the shape that works; do not add columns to existing tables here.
- **Test ripple**: `joinStrandOn` (`integration-tests/src/harness/strand-join.ts`) and every scenario that computes `founderKeyPair = strandMemberKeyPair(memberPrivateKey)` (`strand-removal-cuts-network`, `strand-membership-closed-strand-e2e`, `strand-membership-second-machine`, `strand-two-party-two-machine`, …) must obtain the founder keypair from the new source. Centralize: let the harness accept an optional injected party key (mint one by default) and hand the resulting keypair back to scenarios, so scenario bodies change minimally.

## Key tests

- Unit: closed-strand publish mints a `StrandPartyKey` row; founding `Member.Key` equals its public key and does **not** equal `strandMemberKeyPair(MemberPrivateKey).publicKeyB64`.
- Unit: launch of a pre-existing closed strand with no party key row heals (mints once, stable thereafter); non-founder launch never mints.
- Unit: `StrandPartyKey` constraint coverage in the control-schema spec style — unsigned insert rejected, update rejected, delete requires tombstone, replayed insert of a retired stamp rejected.
- Existing suites green: `yarn workspace @serfab/cadre-core test`, the control-schema drift spec, and the touched integration scenarios.

## TODO

- Add `StrandPartyKey` to `CONTROL_SCHEMA` and mirror into `schemas/control.qsql`; run the drift spec.
- `ControlDatabase`: insert/read/delete writers for `StrandPartyKey` (owner-signed, ValidationKey idiom), wired into the removal path for `Strand` rows.
- `CadreNode.publishStrand`: mint + insert for closed strands; `launchStrand`: founder heal-if-absent, thread `partyMemberPrivateKey` into the instance-manager launch config.
- `StrandDatabaseConfig` + `deriveFounderKeyPair`: switch derivation source; keep the loud throw for closed+founder+keyless.
- Update `docs/strands.md` (member-key-handling section) and `strand-member-key.ts` doc comments.
- Update harness + affected scenarios/specs; full cadre-core test run plus the touched integration scenarios in foreground.
