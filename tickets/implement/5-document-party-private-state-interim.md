----
description: Consumers are asking where per-user, cross-device, strand-invisible state belongs. There is no such place yet and none is coming before the release. Write down the interim answer and its privacy caveat so nobody ships a leak by accident.
files: docs/strand-contracts.md, docs/strands.md, docs/cadre-consistency.md, schemas/chat-simple.qsql
prereq:
difficulty: easy
tradeoffs: documenting a workaround legitimizes it; the alternative is consumers inventing worse ones silently
likelihood: certain
----

# Document the interim answer for party-private app state

Answers **gotchoices/sereus#6**. The feature itself is deferred past this release and lives in
`backlog/feat-party-private-app-state`. This ticket is the release-relevant half: consumers are
choosing a home for read position / drafts / preferences *now*, and if we say nothing they will
either leak it into the strand database without realizing, or push it into node-local storage where
it silently fails to follow the user to their second device.

## The answer to write down

Per the owner: **there is no party-private app-state facility yet, and one is not coming before the
initial release. The interim workaround is to store the data in the shared strand database under a
per-user key.**

The caveat is the important part and must be stated in the same breath, not in a footnote:

> The strand database replicates in full to **every member of the strand**. A per-user key
> partitions the data by owner; it does **not** hide it. Anything stored this way is readable by
> every other party in the strand. Do not put anything there whose disclosure to a counterparty
> would matter.

And the third option must be ruled out explicitly, because it looks correct and is not:
node-local storage (`packages/cadre-core/src/node-local-snapshot.ts`) is **never replicated**, so
state kept there does not follow the user to their other machines — which is usually the whole
requirement.

## Where it goes

`docs/strand-contracts.md` is the natural home (it already reasons about what apps may put where);
cross-reference from `docs/strands.md` where the strand database's replication scope is described,
so a reader who arrives from either direction meets the caveat. Check `docs/cadre-consistency.md`
for any statement about per-member visibility that this contradicts or completes.

Keep it short — a subsection, not an essay — and do not create a new doc file.

## Edge cases & interactions

- **Do not imply the cap or API of the future facility.** The shape is undecided
  (`backlog/feat-party-private-app-state`); promising a shape here creates an expectation we may
  break. Say "planned, shape undecided", or say nothing about the future at all.
- **Migration.** A reader taking the workaround will one day want to move. One sentence saying the
  data will need migrating when the real facility lands is honest and cheap; a migration *plan* is
  out of scope.
- **The reference app.** `schemas/chat-simple.qsql` is what consumers read as the worked example. If
  it already stores anything per-user, the doc should point at it as the illustration; if it does
  not, do **not** add a speculative table to it just to have an example.
- **Wording that survives the feature landing.** Phrase the caveat so it stays true after the
  facility ships (it describes the *strand database*, which will still be public to members).

## TODO

- [ ] Add the subsection to `docs/strand-contracts.md` with the answer, the visibility caveat, and
      the node-local ruling-out.
- [ ] Cross-reference from `docs/strands.md` at the strand-database replication-scope description.
- [ ] Reconcile with anything in `docs/cadre-consistency.md` that speaks to per-member visibility.
- [ ] Confirm no existing doc already claims a party-private store exists.
