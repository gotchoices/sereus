description: Fixed several code comments that called a current, working code path "legacy" — which made live design look like leftover cruft — and recorded one already-declined removal as an explicit accepted tradeoff so it stops looking like an oversight.
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-solicitation.ts, docs/architecture.md
difficulty: easy
---

# Say "legacy" only where something is actually legacy

Comment-only ticket. No executable statement, schema DDL, or signed digest byte
changed — `FormationInvite` authorization digests sign column *values*, not
comments, so nothing here alters what peers agree on.

## What changed

1. **`FormationInvite.StrandId` nullable column** — `control-schema.ts:490` and
   its mirror `schemas/control.qsql:479` (must stay byte-identical, verified with
   `diff` after edit) previously said `null => legacy responder-provisions path`.
   Reworded to describe the live design: null means an **unbound** invite, where
   the responder provisions a fresh open strand and atomically records its one
   consent row. Same fix at `control-database.ts:1919` (the `insertFormationInvite`
   doc comment).

2. **`strand-formation-manager.ts` `provisionUnbound` arm 2** — was called "the
   legacy/mock contract"; it's the mock/transport-test contract (a
   `StrandProvisioner` with no real recorder, used by unit/integration tests, not
   an old version of anything). Reworded, and added a greppable
   `NOTE: accepted tradeoff — …` line at the same doc comment recording the
   plan-stage decision to keep this arm over removing it (removal would churn
   ~6 unit + ~6 integration sites for no production benefit), with its revisit
   condition (production starts publishing unbound invites, or the
   mock-transport tests go away). Also dropped a dangling reference to a backlog
   ticket slug (`formation-initiatorcreates-cover-or-remove`) that does not exist
   anywhere in `tickets/` — the `NOTE:` now carries what that pointer was for.

3. **`types.ts:411`** (`CadreNodeConfig.keyStore` doc) — "Absent ⇒ legacy
   behavior" reworded to state the actual precedence: falls back to `privateKey`
   when set, else libp2p generates an ephemeral key. Mirrored in
   `docs/architecture.md` at the `CadreNodeConfig` code block (`privateKey?:
   PrivateKey; // Direct keypair injection`, dropped `(legacy path)`) and in the
   numbered identity-resolution list (steps 3 and 4, dropped `(legacy
   behavior)` from both).

4. **`control-database.ts:845` and `:913`** (`queryPeerRecord` /
   `queryDeviceToken` doc comments) — "Missing/legacy column values are
   coalesced" reworded to "Missing/null column values are coalesced" — this is
   defensive handling for a row that was never published, not for a row written
   by an older build.

5. **`strand-solicitation.ts:44`** — found during the closing grep sweep, not
   in the original file list. The `unbound` result of `resolveStrand`'s
   discriminated union was parenthetically labeled "legacy/open" — the exact
   same live path as item 1, just a second site. Reworded to "unbound/open".

## What was left alone, and why

Ran `grep -ri legacy` across `packages/cadre-core/src`, `schemas/`, and
`docs/architecture.md` after the edits above. Remaining hits, all confirmed
genuinely legacy (not touched):

- `push-notifier-fcm.ts:5` — Google's actual deprecated FCM server-key HTTP
  API, contrasted with the HTTP v1 API this file uses instead.
- `strand-solicitation.ts:289` and `:299` — `formStrand(invitation: OpenInvitation
  | string, ...)` accepting a bare token string is a real superseded API shape
  (only exercised by unit tests today; production callers pass the richer
  `OpenInvitation` object). Judgment call: this reads as genuinely legacy (an
  older parameter shape kept working, not a live design mislabeled), so left
  as-is. Flagging here in case a reviewer weighs it differently — it's the one
  edge case in this sweep that isn't clear-cut.
- `docs/architecture.md:1114` and `:1148` — the one-time migration off the old
  plaintext LevelDB identity store into the secure-enclave `KeyStore`. That
  plaintext store genuinely is legacy (superseded, being migrated away from).

No hits belonging to `strand-proto` were found in the scanned paths (that
package is owned by ticket `publish-deprecated-strand-proto-decision`,
untouched here).

## How to verify

- `diff` the `StrandId text null` comment line between `control-schema.ts` and
  `schemas/control.qsql` — must be byte-identical (checked during implement).
- Re-run `grep -ri legacy packages/cadre-core/src schemas docs/architecture.md`
  and confirm every hit is one of the three "left alone" cases above, or a new
  genuine legacy reference introduced by unrelated work since this ticket.
- `yarn lint` — clean.
- `yarn workspace @serfab/cadre-core test` — 104 test files, 1644 passed / 1
  pre-existing skip, all green (comment-only change, no behavioral surface to
  regress).

## Known gaps for the reviewer

- The `strand-solicitation.ts:289`/`:299` call is a judgment call (see above) —
  worth a second look since "no backwards compat yet" is a stated project
  convention and this reads like a kept-for-compat shim.
- Did not go looking for "legacy" outside `packages/cadre-core/src`,
  `schemas/`, and `docs/architecture.md` (e.g. other packages, other docs) —
  ticket scope was cadre-core + its schema + its main doc, so that's what was
  swept.
