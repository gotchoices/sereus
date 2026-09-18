description: One integration test failed on every run because it still expected the storage ids that control-database tables had before optimystic started putting the schema name into a table's default storage location; the test's expectation, a design doc, and comments in two other tests describing the old location were updated to match.
files: packages/integration-tests/src/scenarios/control-offline-read-after-restart.integration.ts, packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts, packages/integration-tests/src/scenarios/relay-only-control-addr.integration.ts, docs/architecture.md, tickets/.pre-existing-known.md
----
# Control collection ids are schema-qualified — stale test expectation fixed

## Summary

Optimystic (`1208af4b` / `6302f2e8`, 2026-09-16) moved the default storage location of a table declared without an explicit `using optimystic('<uri>')` from `tree://default/<Table>` to `tree://default/<schema>/<Table>`. The schema name is Quereus's canonical lowercase form (confirmed in `../optimystic/packages/quereus-plugin-optimystic/src/schema/table-identity.ts`). The control schema is `CadreControl`, so its collection-header blocks are now `default/cadrecontrol/CadrePeer` and `default/cadrecontrol/OwnerKey`. No sereus product code builds a `default/...` id. Only test literals, comments and one doc named the old location.

- `control-offline-read-after-restart.integration.ts`: header comment and both block-index assertions now name the schema-qualified ids. This was the failing test.
- `strand-chat-participants-converge.integration.ts`: the header now describes the unqualified location as history. The subject 4c comment names `default/app/…` and `default/strand/…`. The assertion (no `default/` block at all) is unchanged and still correct, because that test writes no rows.
- `relay-only-control-addr.integration.ts`: a quoted historical error message is kept verbatim, with a note giving the current id.
- `tickets/.pre-existing-known.md`: the entry is marked resolved.

## Review findings

- **Diff correctness:** checked the lowercasing claim against `table-identity.ts` (the schema name is canonical lowercase and the table keeps its declared casing) and the strand schema names (`declare schema Strand` and `App` in `compose-strand.ts`, which become `strand` and `app`). The new literals are correct.
- **Stale doc (minor, fixed):** `docs/architecture.md`, in the peer-join catch-up bullet, still said the control header blocks were `default/CadrePeer` and `default/OwnerKey`, which is no longer true. The implementer didn't touch this file. I updated it to the `default/cadrecontrol/...` ids and noted it in the `.pre-existing-known.md` resolved entry.
- **Comment hygiene (minor, fixed):** the edited header line in `control-offline-read-after-restart.integration.ts` was about 115 characters long, far past the block's roughly 90-character wrap, so I reflowed it. In the `.pre-existing-known.md` resolved entry I replaced line-number references that the reformat had already made stale with a plain description of what changed.
- **`docs/strands.md` "Reserved Table Names" section (not touched here):** it still says the default location "does not include the schema name", and the NOTE's revisit condition ("If optimystic makes both schema-qualified…") has now tripped. The whole section, including its explicit-URI example `tree://default/Member`, belongs to the open `implement/retire-reserved-strand-table-names-refusal` ticket, which already lists that file and depends on this ticket. I left it for that ticket instead of editing the same text twice.
- **Other old-shape ids:** `strand-late-cadre-join.integration.ts:109` (`default/Data`), `strand-membership-closed-strand-e2e.integration.ts:1630` (`default/Revocation`) and `strand-removal-cuts-network.integration.ts:172` (`default/Data`) are dated measurements or quoted error messages. They record what was observed then, not current behaviour. None is asserted against, so I left them as they are. The implementer's annotation in `relay-only-control-addr` is optional, not a pattern that has to be applied everywhere.
- **cadre-core unit tests:** `control-read-retry.spec.ts` and `control-write-retry.spec.ts` already use `default/cadrecontrol/...`. Nothing is stale there.
- **Tests / lint:** ran `yarn eslint` on the three scenario files: clean. Ran `yarn vitest run src/scenarios/control-offline-read-after-restart.integration.ts` from `packages/integration-tests` once after my edits: 1/1 passed (11 s). The implementer's 3/3 isolated series stands. I didn't re-run the other two scenario files because only their comments changed.
- **Tripwires / new tickets:** none. The only remaining stale text belongs to an open ticket, as described above.
