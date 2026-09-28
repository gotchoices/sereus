description: A node now remembers the shared workspaces (strands) it joined from another person's party, secret key included, and offers them again on every start, so apps no longer keep their own list.
architecture: docs/strands.md#closed-strand-member-key-handling
files: packages/cadre-core/src/joined-strand-store.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/key-store.ts, packages/cadre-core/test/joined-strand-store.spec.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, docs/strands.md, docs/api.md, docs/architecture.md, .release-notes.pending.md
----

## What landed

gotchoices/sereus#18: a strand joined from another party has no row in the joiner's control database, so nothing re-offered it after a restart and every app kept its own `{Id, MemberPrivateKey, Type}` list. cadre-core now records those joins itself and re-offers them through the existing `strand:discovered` path.

- `joined-strand-store.ts` (new, cross-platform): `JoinedStrandRecord`, the `JoinedStrandStore` interface, `MemoryJoinedStrandStore` (warns once at its first record), `KeyStoreJoinedStrandStore` (one KeyStore slot per join at `cadre/joined-strand/<base64url partyId>/<strandId>`, loaded once then written through, junk slots dropped, load errors rethrown), and `JoinedStrandRows`, the strand watcher's per-session view (control row wins a collision and the stale record is forgotten; a revoked join keeps being offered until the session ends; a failed list reuses the last good one).
- `CadreNode`: store chosen at `start()` from `config.joinedStrands.store`, else a KeyStore store over `config.keyStore`, else memory; a store scoped to another party fails `start()`. The watcher polls control rows plus joined rows. `formStrand` records the join last and throws a spent-token error if that fails. A joining `addStrand` of a row the node did not offer and the control database does not hold records it, best-effort. New public `forgetJoinedStrand(id)`. Self-revocation forgets the record after this session.
- `CadreNodeConfig.joinedStrands?: { store?: JoinedStrandStore }`; exports from the package index.
- React Native `claimDiscovered` also claims a closed row when it carries `MemberPrivateKey`, through `joinChatStrand` with the offered row unchanged.
- Docs: `strands.md` "What a joiner's node remembers", `api.md` (`forgetJoinedStrand`, `formStrand`), `architecture.md` (watcher and KeyStore sections), `key-store.ts` interface doc, release-note bullet.

Deviations from the plan, all accepted in review: party-scoped slots (one RN KeyStore serves every party the user switches between), the per-session `JoinedStrandRows` state, recording after `adoptFormationMembershipInvite`, best-effort recording in `addStrand`, RN re-attach through `joinChatStrand` rather than `joinClosedChatStrand`, and the load-once cache.

## Review findings

Read the full implement diff (`92b704ab`), then `addStrand`, `foundStrand`, `formStrand`, `stopStrand`/`detachStrand`, `handleStrandAdded`, the `StrandWatcher` removal/suppression paths, RN `SecureStoreKeyStore`, `chat-strand.ts` and every `addStrand` caller across `packages/*/src`.

- **Defect, fixed:** `addStrand` recorded a row passed with `founder: true` as a join from another party whenever the control database had no row for it. Many integration scenarios found strands exactly that way (a synthetic row with `founder: true`, never published), and any embedder doing the same would, after a restart over a durable KeyStore, get the strand re-offered with `FounderOwnerKey: null` and relaunched as a joiner. `addStrand` now skips remembering when `founder === true` (`cadre-node.ts`, the `rememberable` flag). This also drops the extra `queryStrand` round trip from every `foundStrand` that founds. The rule is restated in the `addStrand` doc comment, `CadreNodeConfig.joinedStrands` doc and `docs/strands.md`. No test added: the fix is a one-condition guard on a path whose only observable effect is a KeyStore write on the next restart, and a node-level test would need a real founder launch; the existing node-level restart test still covers the recording path.
- **Correctness, checked, no change:** `foundStrand` publishes the row before its `addStrand`, so own-party strands are never recorded. `forgetJoinedStrand` forgets, then stops; a watcher poll landing between the two detaches the strand first and the `stopStrand` becomes a no-op, which is harmless. `formStrand` requires `controlNode`, which is created after `initializeJoinedStrandStore`, so its non-null assertion holds. RN `SecureStoreKeyStore` supports `list()` through its index and base64url-encodes ids, so the `/` in slot ids and the ~200-byte JSON records fit (value limit ~2048 bytes).
- **Tests:** the five new tests each pin a branch a type cannot enforce (junk-slot drop, party-prefix isolation, control-row-wins union, revoked-join kept for the session, restart re-offer end to end); none restate the implementation or verify a mock. Kept all. The RN test replacement matches the new claim rule.
- **Error handling:** every catch logs; `formStrand` fails loudly, `addStrand` warns and continues, as designed.
- **Resource cleanup:** the store survives `stop()` like the other node-local stores; the per-session view is rebuilt each `start()`. Nothing to release.
- **Tripwires:** the implementer's three `NOTE:` comments (direct re-admission after revocation, a claim of a just-unpublished row, gated-KeyStore load retry every poll) are genuinely conditional; left in place.
- **Size:** `cadre-node.ts` is 7639 lines (`wc -l`); this change added about 120. Appended as evidence to the existing `debt-cadre-node-single-file-size` backlog ticket rather than filing a new one.
- **Docs:** read every doc the change touched; all match the code after the `founder` wording fix. The web and NativeScript reference apps are unchanged (the web app still keeps `formedStrands` in memory and has no `strand:discovered` handler), as the plan said.
- **Security:** the read secret is stored only through the KeyStore seam, party-scoped; no new logging of the secret (log lines print ids and type only).

## Validation

- `yarn lint`, `yarn typecheck`: clean.
- `yarn workspace @serfab/cadre-core test`: 141 files, 2287 passed, 1 skipped.
- `reference-app-rn` `test/react/use-cadre.spec.ts`: 23/23.
- Integration scenarios not re-run in review: the fix only skips a KeyStore write on the founder path; the implement stage ran `strand-formation-cross-party-seed` and `blind-relay-phone-to-phone-e2e` (4/4).

## Still open (outside this ticket)

- Restart replication for a re-attached join still needs the strand address book (`strand-peer-book-local`, `strand-peer-book-swap`); that ticket builds its store as `new KeyStoreJoinedStrandStore(keyStore, partyId)`.
- cadre-cli and cadre-host get the memory store (they pass `privateKey`, not `keyStore`) and call neither `formStrand` nor `addStrand` today.
- FileKeyStore file-name length for a very long party id plus a 128-character dotted strand id is not measured.
