description: The reference app's chat database schema is hand-copied into three apps and a design document, nothing checks the copies against each other, and two of them have already fallen behind the original.
files: schemas/chat-simple.qsql, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-web/src/lib/chat-strand.ts, packages/reference-app-ns/src/chat-strand.ts, packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts, packages/quereus-plugin-sereus/test/helpers/qsql-body.ts
tradeoffs: The three apps embed the schema as a string constant on purpose — the React Native bundler cannot read a `.qsql` off disk — so a maintainer may argue the copies are load-bearing and a guard is bureaucracy for a demo app nobody ships.
----

# `chat-simple.qsql` has four hand-maintained copies and no drift guard

## What is wrong

`schemas/chat-simple.qsql` is the schema the reference chat app runs. It exists four more
times, each hand-typed:

- `packages/reference-app-rn/src/chat-strand.ts` — a `CHAT_SCHEMA` string constant
- `packages/reference-app-web/src/lib/chat-strand.ts` — same, its own copy
- `packages/reference-app-ns/src/chat-strand.ts` — same, its own copy
- `docs/reference-app-rn.md` — a fenced SQL block in the "Simplified Chat Schema" section

Nothing compares any of them to the file, or to each other. Two have already fallen behind:
the `Member.Role` column (`text not null default 'member' check (Role in ('owner','member'))`)
is present in `schemas/chat-simple.qsql` and in the React Native copy, and **absent** from
both the web and NativeScript copies. The documentation copy had drifted the same way and was
brought back in line during the review of `repair-the-chat-reference-schema`; the three code
copies were left alone because reconciling them is this ticket's job, not that one's.

Nothing is broken *today*: neither the web nor the NativeScript app reads or writes
`Member.Role` (`grep -rn '\bRole\b' packages/reference-app-web/src packages/reference-app-ns/src`
returns nothing). It breaks the moment either app grows the owner/member behaviour the RN app
already has — a schema that does not declare the column, against code that expects it.

## Why a guard, not just a reconciliation

Retyping the two missing columns fixes today's divergence and leaves the mechanism that
produced it fully intact. The same class is already solved once in this repo, for the
security-critical strand schema: `packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts`
compares the embedded `STRAND_SCHEMA` constant against the body of `schemas/strand.qsql` and
fails on any difference. The comment/string-aware extractor it uses was moved out to
`packages/quereus-plugin-sereus/test/helpers/qsql-body.ts` and is already shared, so a second
guard is mostly wiring.

The chat case has one wrinkle the strand case does not: the guard would have to reach across
package boundaries, from a test in `quereus-plugin-sereus` into three reference apps. Either
the test reads the three files by relative path (simple; couples the packages at test time
only), or each app grows its own small guard next to its own constant (more files, no
cross-package reach). The shape of the assertion is the same either way, and either is
acceptable — pick one and apply it consistently.

Whichever is chosen, the documentation block in `docs/reference-app-rn.md` should be covered
too. It is the copy a reader is most likely to trust and the one with no compiler behind it.

## Expected end state

- All four copies agree with `schemas/chat-simple.qsql`, column for column and constraint for
  constraint.
- A test fails if any of them stops agreeing.
- The guard normalizes only whitespace and comments — not structure — so a real difference
  cannot hide inside a reformat.
