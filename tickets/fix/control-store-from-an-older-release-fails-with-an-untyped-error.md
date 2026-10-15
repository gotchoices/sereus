description: When a release changes the control schema, a control store the previous release wrote fails every `CadreNode.start()` with the raw Quereus DDL error, whose text differs per change, and "recreate the party" has no defined procedure for an embedder. Throw a typed error and document (or provide) the recreate step (GitHub #46).
architecture: docs/architecture.md
files: packages/cadre-core/src/control-database.ts (`initialize` ~1005-1040, `loadSchema` ~1047-1137 and its NOTE ~1098-1102), packages/cadre-core/src/cadre-node.ts (start's catch ~1427-1439), packages/cadre-core/src/control-write-retry.ts (`RETRIABLE_SCHEMA_INIT_MATCHERS` ~424-427), packages/cadre-core/src/index.ts, docs/architecture.md (~53, the recreate policy), packages/cadre-rn/src/phone-node (start failure)
----

# A control store from an older release fails with an untyped error

Reported by kjeib (gotchoices/sereus#46) with a three-release reproduction. Verified at 70b2dc1d:

- `loadSchema` runs the schema apply under `SCHEMA_INIT_RETRY_POLICY`; a DDL refusal matches none of the transient matchers, so it is rethrown, and `start()` rethrows it unwrapped. No error class identifies an incompatible store; tests pin the raw `Failed to execute DDL: …` text.
- Nothing is persisted that identifies the schema a store was written with.
- No API deletes or recreates the running party's control store. Embedders find `controlStorageScope(partyId)` and delete it themselves; cadre-rn's `dissolve.ts` and the web app's `web-dissolve.ts` delete a former party's store only.
- `docs/architecture.md` (~53) names one trigger (edited constraint text → `drop constraint`). The 1.14 break was a `drop table` blocked by another table's CHECK, and 1.15's was `add column`: any change to an existing control table breaks a warm start.

## What to do

1. **Typed error.** When the apply fails non-transiently on a store whose hydrated catalog already held `CadreControl` tables, throw `ControlStoreIncompatibleError` (exported; carries `partyId`, the storage scope and the Quereus error as `cause`). A cold store that fails the apply keeps the raw error. Retire the raw-text pins in tests that should now see the typed error.
2. **Schema fingerprint.** Persist a hash of the applied schema text in the control store (a singleton row, or node-local beside it), and check it before applying, so detection does not depend on which DDL fails first. Mismatch → the same typed error, without attempting the apply.
3. **Recreate, defined.** Document in `docs/architecture.md` what recreating a party's control store means and what is lost. Deleting the control scope loses every `OwnerKey`, `CadrePeer`, invitation, `Strand` and `JoinedStrand` row, the closed-strand read secrets (`Strand.MemberPrivateKey`, `JoinedStrand.MemberPrivateKey`) and the `StrandPartyKey` private keys, which exist nowhere else; strand stores, the identity key and the trusted-owner anchor survive. Decide whether cadre-core offers `CadreNode`-level `recreateControlStore` or the doc gives the recipe; the owner-key series (`implement/1.0x`) changes the answer, since the owner key will no longer be derived from the identity.
4. Fix the architecture note to say any change to an existing control table breaks a warm start, not only constraint text.

## Out of scope: the policy

The reporter's point 4 (phones receive app-store updates one at a time, so "upgrade every machine together" is not something a phone app can do) questions the no-migration policy itself. That is `blocked/decide-control-schema-upgrade-across-separately-updated-machines`.
