description: When a machine's strand join is only half saved (the invitation is recorded as used but the membership row is not), the membership loop mistakes it for an already-used invitation and quietly gives up, leaving the party permanently outside the strand with nothing reported. Detect this case by error type and report it loudly.
files: packages/cadre-core/src/strand-membership-reconciler.ts (`DEAD_INVITE_REJECTION` :112, `classifyConsumeFailure` ~451, `noteIdlePass` warn ~503), packages/cadre-core/src/control-write-retry.ts (`reportsPossiblyStoredWrite` ~290, the type-match precedent and its bundling NOTE), packages/cadre-core/src/control-retry.ts (`causeChain` ~263), packages/cadre-core/test/strand-membership-reconciler.spec.ts, docs/strands.md
repro: verified
----
# The reconciler classifies a half-committed join as a dead invitation

## What happens

The membership reconciler redeems a staged invitation with `consumeInvite`, which writes `Strand.Member` and `Strand.ConsumedInvite` in one SQL transaction. On a networked strand, optimystic commits those tables as separate collections and can report `CoordinatorPartialCommitError` (from `@optimystic/db-core`), or `PartialCommitError` from the plugin's legacy path (`@optimystic/quereus-plugin-optimystic`). In that case some collections are durable and the rest are not. Optimystic documents this as a permanent property of session-mode commits, not a transient bug: the error "IS that guarantee's reporting surface", and callers must reconcile (`../optimystic/packages/db-core/src/transaction/errors.ts` ~40-80). It shows up often right now because of an upstream regression (see `tickets/.pre-existing-known.md`, Delta 2026-09-17). Observed on 2026-09-17: `ConsumedInvite` committed, `Member` failed.

`classifyConsumeFailure` tests `DEAD_INVITE_REJECTION = /NotExpired|NotCancelled|ConsumedInvite/i` against the message. The partial-commit message names the collection `default/strand/ConsumedInvite`, so it matches. The reconciler logs "the staged invitation is dead (expired, cancelled, or consumed elsewhere)" on the debug channel only, clears the staged invitation, and waits for membership to arrive some other way. The invitation really is spent at that point: `ConsumedInvite(InviteKey, MemberKey = this party)` is durable, and `Member.Authorized`'s invite branch needs a fresh same-transaction consumption. So the party can never be seated from it. Only a manager's direct admission recovers it, and nothing tells anyone that one is needed. This is what `blind-relay-phone-to-phone-e2e` (3/3 runs) and the first test of `strand-chat-participants-converge` time out on.

Whether sereus should be able to recover such a party itself is a separate decision (`blocked/strand-half-committed-join-recovery`). This ticket only makes the failure correctly classified and visible.

## Required behaviour

- `classifyConsumeFailure` walks the error's `causeChain` (control-retry.ts) and checks for `CoordinatorPartialCommitError` / `PartialCommitError` **by type, before any message regex**. Import them the way `control-write-retry.ts` does, and keep its NOTE about the plugin's two entries sharing one class in mind.
- On a half-committed join:
  - Emit one `console.warn` (sereus-prefixed, like `noteIdlePass`). It names the strand, the committed collections (`committedCollections` / `persisted`) and the failed ones (`failedCollections` / `unpersisted`), and states the consequence plainly: the invitation is spent, this party has no `Member` row, and a manager must admit it directly (`addMemberByManager`) unless the membership row arrives by other means.
  - Clear the staged invitation. It is spent, and a retry could only fail on the `ConsumedInvite` primary key.
  - Keep the loop running as it does after a dead invitation: a manager admission seats the party and the next pass then writes the `MemberPeer` binding.
  - Handle a partial commit whose committed set does **not** include `ConsumedInvite` (e.g. `Member` durable, `ConsumedInvite` not) too. Warn the same way. The next pass's `isStrandMember` check decides what happens after that (the member row exists, so the burn arm runs), so do not special-case it beyond the message.
- Anchor `DEAD_INVITE_REJECTION` to the actual constraint-failure texts, not the bare table name. Read the real messages from the existing reconciler/invite specs: the second-holder case at `strand-membership-reconciler.spec.ts` ~365 gives the `ConsumedInvite` primary-key text, and there are expired and cancelled cases. Pin each message in the spec so a wording change in Quereus fails a test rather than silently reclassifying.
- If `strand-writer-transactions-indivisible` has landed first, its `StrandTransactionBusyError` classification stays ahead of the regex too. Order: sealed → busy → half-commit → dead → retry, or whatever order keeps typed checks before text checks.

## Tests

In `strand-membership-reconciler.spec.ts`, inject a `consumeInvite` failure carrying a `CoordinatorPartialCommitError` (construct it directly, as `control-write-retry.spec.ts` ~591 does, with `['default/strand/ConsumedInvite']` committed and `['default/strand/Member']` failed). If the reconciler has no injection seam for the writer, wrap it in a Quereus-style error with `cause`, or add the smallest seam that fits the deps interface. Assert:

- one `console.warn` naming both collection lists,
- the staged invitation is cleared,
- the loop keeps running (not finished),
- the dead-invite debug line is not emitted.

Also assert that a real dead invitation (the second-holder case) is still classified as dead with the anchored regex.

## TODO

- Type-based partial-commit detection in `classifyConsumeFailure`, with the warn and stage-clear described above.
- Anchor `DEAD_INVITE_REJECTION` to the constraint texts and pin them in specs.
- Spec coverage as above. Run cadre-core tests, `yarn lint`, and the type check.
- docs/strands.md: next to the reconciler paragraph (~214), one sentence saying a half-committed join is reported with a warning and needs a manager admission.
