----
description: A workspace can be created as open to anyone, but no test has ever run one with strangers joining it. We do not know whether an open workspace works in practice, and we already know it is not yet defended.
prereq: harness-topology-builder
files: packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, schemas/strand.qsql, schemas/control.qsql, packages/cadre-core/src/control-formation-recorder.ts, docs/architecture.md
difficulty: hard
tradeoffs: The security model for open workspaces is an unresolved design question (feat-open-strand-witness-policy), so a functional test written now can only assert that the happy path works — and a maintainer may reasonably want the policy settled first so the scenario can be written once instead of twice.
----

# A public (open) strand with unrelated parties joining it

## The use case

A workspace created as **open** rather than invitation-only: anyone who learns of it can join and
participate. Small public network first — three or four unrelated parties — then a medium one.

## What exists and what does not

Open strands are real and structural, not aspirational. The open/closed flag is recorded
immutably in two places (`Strand.Header.Type` in `schemas/strand.qsql`, `CadreControl.Strand.Type`
in `schemas/control.qsql`), an open strand has no member list at all, and an unbound invitation
takes the responder-provisions path where the recorder mints a fresh open strand and records its
single consent row atomically (`docs/architecture.md`, `control-formation-recorder.ts`).

Coverage is one test. `strand-formation-e2e.integration.ts:259-265` exercises open formation in
`responderCreates` mode with a mock provisioner. Nothing beyond that: no test has several
unrelated parties join one open strand, write to it, and converge; no test has a party join an
open strand it did not form.

## The thing to be clear-eyed about before writing this

`feat-open-strand-witness-policy` (backlog, `difficulty: hard`) states the problem plainly: an
open workspace today gets exactly the same protections as an invitation-only one, and two of
those protections are only defensible under invitation-only assumptions — the corroboration floor
can fall to a single voter, and rule-carrying changes commit on a super-majority of machines that
an attacker chooses how many of to bring. Its uncomfortable observation is that a **small** open
workspace is the cheapest thing in the system to attack, because joining is free and an attacker
can be most of a small group with a handful of machines.

So a scenario written now can honestly assert that open strands **function**. It cannot assert
that they are **safe**, and it should not pretend to. Say so in the scenario's own header rather
than leaving a future reader to infer that a green run means an open strand is defended.

That is also the argument for deferring: once the witness policy is decided, the admission and
voting rules an open strand runs under will change, and a scenario written against today's rules
would need rewriting. The counter-argument is that a functional test now would tell us whether
open strands work at all before we invest in defending them — which is not currently known.

## What the scenario should prove, if written before the policy lands

- Three or four unrelated parties join one open strand from a published seed, without any of them
  holding an invitation minted for them specifically.
- Every party can write, and writes converge to all of them.
- A party that joins after data exists receives that data.
- Leaving works: a party that stops serving the strand does not wedge the others.
- The negatives that *are* meaningful today: an open strand must reject a member key
  (`MemberKeyClosedOnly` is enforced in schema), and the membership tables that are closed-only
  (`Member`, `Manager`, `Invite`) must remain unusable on it.

## Medium public, later

The medium public case is this scenario at the size of `feat-scenario-medium-private-network`,
and it inherits both that ticket's scale constraints and this one's policy caveat. It is not
worth writing until both are settled.
