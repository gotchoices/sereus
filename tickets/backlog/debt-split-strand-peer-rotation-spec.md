description: One test file for strand membership rotation has grown to over 1,500 lines covering two different features (peer registration and manager rotation); consider splitting it into two files so each stays focused.
files: packages/cadre-core/test/strand-membership-peer-rotation.spec.ts
difficulty: easy
----

`packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` measured at 1,517 lines
(`wc -l`, 2026-08-02). Per its own file-header comment it covers two features: `MemberPeer`
registration (a member binding its own network nodes) and `Manager` rotation
(promote/remove/resign). Parked while working
`tickets/implement/21-debt-strand-spec-helpers-duplicated.md` (which hoists this file's
duplicated setup helpers into a shared module) — that ticket deliberately left the split out
of scope as an orthogonal structural change.

Whoever picks this up should re-measure the actual line split between the two `describe`
blocks (not assumed here) before deciding whether a two-way split is warranted, and should
pull in whatever the shared-helpers work landed as `strand-spec-helpers.ts` rather than
re-duplicating setup into the new file.
