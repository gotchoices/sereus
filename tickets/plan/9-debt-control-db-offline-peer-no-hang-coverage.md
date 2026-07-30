----
description: When a node has other known members that are currently switched off or unreachable, reading or writing its own settings must either fail quickly or answer from local data — it must never freeze. Nothing tests that today.
prereq:
files: packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, docs/STATUS.md
difficulty: hard
----

# Coverage: control-DB reads/writes with known-but-offline peers must not hang

## What is missing

A node that is the only member of its group — a "cadre of one" — is now covered end to end by
`packages/cadre-core/test/control-database-solo.spec.ts`: genesis, read-back, a local write, a
read-back of that write, and a warm restart, for both node profiles, with a no-listen-address
network configuration.

The next shape along is **not** covered anywhere: a group with more than one member, where the
node doing the work knows about the other members but none of them are currently reachable
(phone offline, laptop asleep, a peer that has moved network). This is the ordinary state of a
multi-device setup most of the time, not an exotic one.

The behaviour it must have is the same requirement the solo work was filed under: a control
read or write in that state **must either fail fast with a clear error, or answer from local
state — and must never hang.** No test asserts any of the three outcomes today, so we do not
actually know which one happens.

## Why it is worth a ticket rather than a note

The original report that prompted the solo work was a freeze, and the reporter had wrapped
their calls in manual time-boxes to survive it. We closed the solo half of that question and
could not reproduce a hang there. The offline-peer half is the remaining place the same freeze
could live, and it is the shape most likely to be hit in the field. Leaving it unasserted means
the next such report is again unanswerable from our own test suite.

Note that a failure here is a *finding*, not necessarily a test bug: if the new test hangs, it
has found the defect the solo spec went looking for and did not find.

## Suggested shape (not prescriptive)

- Two nodes in one group; the second registers itself, then is stopped, leaving its address
  record behind so the first still believes it exists.
- The first node then does the full set of control operations — owner-key read, peer list, a
  write, a read-back of that write — each under an explicit per-operation deadline so a freeze
  reports as a *named* failure rather than a bare test timeout. `control-stream.ts`'s
  `withTimeout` is the helper for this; the solo spec shows the pattern.
- Assert the outcome explicitly for each operation: resolved-locally, or rejected with a
  recognisable error. "Did not hang" alone is too weak — a silent empty result where the local
  row exists is also wrong.
- Both node profiles (`transaction` and `storage`), since they take different paths.

## Adjacent gap worth folding in if cheap

The solo spec uses a WebSockets-only transport list. The reference apps add circuit-relay and
WebRTC transports (web and NativeScript add both; React Native adds both as well). A hang whose
trigger is a *transport* rather than the missing listen address would slip past everything we
have. If the harness for the above is easy to parameterise over transport lists, do so;
if not, say so and leave it.

## Relationship to existing known failures

`tickets/.pre-existing-known.md` lists a large set of integration-test failures against the
blocked ticket `control-db-convergence-optimystic-p2p`. Those are about data **not replicating
between** nodes once a group forms. This ticket is a different question — a single node's
liveness when its peers are absent — and should not be folded into that one. If the new test
turns out to fail for the same underlying substrate reason, record that link rather than
duplicating the blocked ticket.
