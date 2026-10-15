description: On a two-member strand, reading an app table nobody has written asks the other member on every read (Optimystic caches no absence), and with the other member offline the read fails `cohort-unreachable`; on a phone-shaped link one such read took up to 31.7 s and an app's background step never reached its write. Make every declared app table exist from founding (GitHub #47).
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/cadre-core/src/strand-database.ts (`initialize` ~94-150, founder bootstrap ~173), packages/cadre-core/src/strand-membership-writer.ts (`bootstrapFounderMembership` ~532-561; the strand `Revocation` NOTE ~359-364), packages/quereus-plugin-sereus/src/compose-strand.ts (`applyAppSchema` ~409-441), packages/integration-tests/src/scenarios/ (the reporter's `strand-read-cost-over-relay.integration.ts`, in the issue), docs/strands.md (~239, the first residual under Joining)
----

# Unwritten app tables cost a cohort read, and fail offline

kjeib's scenario in gotchoices/sereus#47 (two relay-only parties, closed strand, founder writes every table but `CloseRequest`): `CloseRequest` reads cost a cohort round trip each (217 ms at 100 ms latency, up to 31.7 s on the phone arm, one failure), and with the joiner stopped the founder's read throws `BlockUnavailableError (cohort-unreachable)` 3 of 3. In the control arm the founder writes and deletes one `CloseRequest` row at founding, and every read is local in every arm with no failures.

Verified at 70b2dc1d:

- Optimystic keeps no absence ruling (`coordinator-repo.ts` ~863-895). The memo was removed upstream (`1-drop-the-settled-absence-memo`); re-adding it is optimystic `backlog/feat-a-cohort-member-remembers-a-settled-absence`. `network-transactor.ts` ~262-267 retries a flagged read once more, so each read consults twice.
- The founder writes `Header`, `Member` and `Manager` only (`bootstrapFounderMembership`). No `App` table gets a collection, and `applyAppSchema` refuses `seed` items.
- The control database solved the same thing for `Revocation` with a marker row (`complete/revocation-ledger-marker`). The strand schema's `Revocation`, `ConsumedInvite` and `CancelledInvite` are still never written at founding, and a joiner's `consumeInvite` CHECKs read them.

## Plan

1. Commit the reporter's scenario with its failing arms as `it.fails`.
2. At founding, create an empty collection for every table in the `App` schema and for the strand schema's never-written tables, so peer-join backfill ships them and no read of a declared table needs the cohort to prove absence. This also closes the "two machines invent one table" residual (`docs/strands.md` ~239). Find the cheapest way to create a collection without a row (an Optimystic API, or a marker row where constraints allow), and measure the founding cost it adds, as the residual asks.
3. A table added by a later schema version has the same problem. Decide whether a schema apply on a running strand creates its new tables' collections the same way.
4. Flip the scenario's arms to `it` and update `docs/strands.md`.
