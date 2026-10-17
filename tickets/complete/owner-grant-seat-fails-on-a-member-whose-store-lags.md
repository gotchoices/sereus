description: A machine already in the cadre that was offline when an owner grant was made could not redeem the grant right after coming back, because copying the grant into its own records failed with a duplicate-key error. That copy now counts as already done, and a machine that still cannot read the grant gets a named "try again" refusal.
architecture: docs/architecture.md#owner-grants
files: packages/cadre-core/src/control-database.ts (IssuedRowNotHereYetError, keyConflictPattern / isIssuedRowKeyConflict, seatIssuedRow + adoptCohortHeldRow, redeemCadreInvite / redeemOwnerGrant missing-row throws), packages/cadre-core/src/cadre-node.ts (refusingUnsyncedGrant, redeemOwnerGrantLocally), packages/cadre-core/src/member-redemption.ts (writeFailureRefusal), packages/cadre-core/src/owner-grant-protocol.ts, packages/cadre-core/src/cadre-invite-protocol.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-owner-grant.spec.ts, docs/architecture.md
----

# Seating an issued row from its bundle on a member whose store lags the cohort

## What was wrong

`ControlDatabase.seatIssuedRow` (the body of `seatOwnerGrant` and `seatCadreInvite`) inserts a bundle's signed row only when its own read finds nothing. On a member whose store had not caught up, that read missed the row, and a cohort member that already held it refused the commit with `UNIQUE constraint failed: OwnerGrant.Key`. The raw error reached `CadreNode.redeemOwnerGrant`'s local path with no code, and cadre-cli reported the redemption as final. Reported with real cadre-cli nodes: owner A, member C stopped, grant minted on A, C restarted with `CADRE_OWNER_GRANT=<grant>`.

## What changed

- `keyConflictPattern(table)` (was `idConflictPattern`) reads the key column from `GUARDED_KEY_COLUMN`; the new exported `isIssuedRowKeyConflict(error, table)` matches `UNIQUE constraint failed: <Table>.Key` on the error chain, text-matched and failing closed.
- `seatIssuedRow` hands a key conflict to `adoptCohortHeldRow`, which re-reads the stamp unlocked. Found → returns `false` ("already seated"). Not found → throws the new `IssuedRowNotHereYetError` (exported), with the conflict as `cause`.
- `redeemOwnerGrant` / `redeemCadreInvite` throw `IssuedRowNotHereYetError` for a missing row instead of a plain `Error`.
- Local grant path: `refusingUnsyncedGrant` maps the error to `OwnerGrantRejectedError('conflict')` (retryable) around both the seat and the redemption write. The seat still runs before the signer's approval.
- Member handlers: `writeFailureRefusal` maps the error to `conflict` (it was `internal` before; both retryable).
- Docs: the invitation-seat paragraph, the owner-grant seat sentence, the local-path bullet, and both refusal tables' `conflict` rows; the `conflict` doc comments in both protocol files.

## Review findings

Read the diff of `ticket(implement): owner-grant-seat-fails-on-a-member-whose-store-lags` first, then the fix-stage ticket (`ticket(fix): …`) it implemented. Every TODO there is done as specified.

**Correctness (checked; no defect found).**
- The adoption is safe: it only returns `false` once this node reads a row under the key, and the redemption then judges that locally held row (not the bundle's copy). So a key conflict alone never admits anything.
- The issuer-unauthorized check still runs before the key-conflict check.
- The write funnel does not retry `UNIQUE` failures: `RETRIABLE_CONTROL_WRITE_MATCHERS` excludes constraint text.
- An indeterminate commit (the seat landed, the reply was lost) that the caller re-runs now also ends in adoption rather than the raw error. That is an improvement.
- `REDEEM_CONSTRAINT_CODES` in both protocols match only `CHECK constraint failed:` names. The new error's cause chain therefore cannot be captured as `grant-spent` or `invite-spent` before `writeFailureRefusal` sees it.
- Every caller of `seatOwnerGrant`, `seatCadreInvite`, `redeemOwnerGrant` and `redeemCadreInvite` was traced (cadre-node local path, both handlers). cadre-cli's `describeRedemptionFailure` returns `err.retryable` for `OwnerGrantRejectedError`. Both apps' rejection tables map `conflict` to "try again". No caller needed a change.
- Nothing matched the old "seatOwnerGrant first" message text.

**Design choice (accepted).** The handler mapping lives once, in `writeFailureRefusal`, rather than as an `instanceof` in each of the four catch blocks. Same behaviour from one site, which fits the "stay DRY" rule; kept.

**Tests.**
- Kept the one new case in `control-owner-grant.spec.ts`. It pins text from another repository (the optimystic engine's unique-constraint message) that the fix depends on. It also shows that a verbatim copy, whose `StampId` repeats too, is reported on `OwnerGrant.Key`. The fix-stage ticket called for it.
- The adoption branch itself has no test. The fix stage showed the race cannot be forced in-process, and mocking the control database is ruled out.
- No test added in review; no defect was found that a test would reproduce.
- Ran and passed: `control-owner-grant.spec.ts`, `cadre-node-owner-grant.spec.ts`, `cadre-invite-protocol.spec.ts` (27 tests together); `control-cadre-invite.spec.ts` and `owner-grant-codec.spec.ts` alongside them; `yarn lint`; `yarn workspace @serfab/cadre-core typecheck`.
- The real cadre-cli reproduction was not re-run (it needs several real processes). The end-to-end fix is verified by reading, not by observation.

**Docs.**
- Fixed in this pass: the two sentences inserted into the invitation-seat paragraph of `docs/architecture.md` broke the antecedent of the next sentence. "Such a member admits the device's connection only provisionally" had come to refer to the lagging member, when it means a member without the row. It now reads "A member without the row…", and the inserted sentence says "the seat then re-reads", with "(retryable)" rather than "(retried)".
- The owner-grant section, both refusal tables and the protocol doc comments were read and are accurate.
- `docs/schema-guide.md`'s "match on the text" guidance already covers the classifier.

**Tripwire.** `adoptCohortHeldRow`'s re-read takes the committed, non-refreshing path while another locked write body is running, so it can miss the row and refuse a retryable `conflict`. Parked as a `NOTE:` at that site in `control-database.ts`.

**Cosmetic, left alone.** cadre-cli still prints `⚠ Control write abandoned [owner-grant-seat] … (declined): UNIQUE constraint failed: OwnerGrant.Key` before the seat succeeds by adoption. The funnel's abandonment listener fires before `seatIssuedRow`'s catch. `publishStrand`'s id-conflict branch behaves the same way. Changing it would mean teaching the funnel about caller-side recovery, which this ticket does not justify.

**Hygiene.**
- `control-database.ts` is 5,147 lines and `cadre-node.ts` 10,628 (`wc -l`). This change adds about 50 lines.
- File size is already tracked by `backlog/debt-cadre-node-single-file-size.md`, which records `control-database.ts` as evidence. No new ticket.
- The new methods are small and single-purpose, and the comments say why rather than narrating.

**Resource cleanup, performance, type safety.** Nothing applies beyond the above. The conflict path adds one extra read, and only on failure. The error carries typed `table` and `key` fields. No new `any`.
