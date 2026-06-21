description: Flipped the "I am the founder" flag on in every real create-a-group flow so freshly created strands bootstrap their owner/membership rows correctly.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/src/chat-strand.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/test/chat-strand.spec.ts
----

## What was done

Added `founder: true` to every real strand-creator helper; every joiner helper is untouched.

### Source changes

| File | Function | Change |
|---|---|---|
| `packages/reference-app-web/src/lib/cadre-web.ts` | `createClosedChatStrand` (~L491) | `founder: true` alongside `mode:'networked'` (+ clarifying comment, added in review) |
| `packages/reference-app-web/src/lib/cadre-web.ts` | `addChatStrand` (~L724) | `founder: true` on the open solo strand |
| `packages/reference-app-rn/src/chat-strand.ts` | `createChatStrand` (~L99) | `founder: true` |
| `packages/reference-app-rn/src/chat-strand.ts` | `createClosedChatStrand` (~L157) | `founder: true` |
| `packages/reference-app-ns/src/chat-strand.ts` | `createChatStrand` (~L70) | `founder: true` |

### Tests added

- **`packages/cadre-core/test/publish-strand.spec.ts`** — CadreNode-seam block (3 tests): closed founder → Header/Member/Authority=1 with derived key; open founder → Header=1, Member=0, Authority=0, Type='o'; closed founder with null `MemberPrivateKey` rejects.
- **`packages/reference-app-rn/test/chat-strand.spec.ts`** — new file (3 tests): `createChatStrand` and `createClosedChatStrand` pass `founder:true`; `joinChatStrand` does NOT.

## Review findings

### Scope / completeness — checked, no gaps
- **Every real creator covered, every joiner left alone.** Grepped all `addStrand`/`publishStrand` call sites across `packages/*/src`. The five creator helpers (web `createClosedChatStrand`/`addChatStrand`, RN `createChatStrand`/`createClosedChatStrand`, NS `createChatStrand`) all set `founder: true`; the five joiners (web `joinViaInvitation`, RN `joinChatStrand`/`joinClosedChatStrand`/`joinClosedChatStrandFromFormation`, NS `joinChatStrand`) all omit it. Confirmed correct.
- **Generic pass-throughs are not missed creators.** `reference-app-rn/src/cadre-phone.ts:371` and `reference-app-ns/src/cadre-phone.ts:164` are thin `addStrand(config)` wrappers documented as attach-only ("strand must already exist in the control database"); they forward whatever the caller supplies and are not strand creators.
- **App callers route through the create helpers** (`use-cadre.ts`, NS `cadre-vm.ts`/`solo-smoke.ts`, web `store.svelte.ts`) — no caller bypasses the helpers to call `addStrand` directly for a create.
- **Integration-test `addStrand` sites** already set `founder` explicitly where founding is exercised (`strand-membership-closed-strand-e2e.integration.ts`); the others are pre-existing joiner/replication scenarios outside this ticket's scope.

### Correctness / edge cases — checked, sound
- Closed creators mint `MemberPrivateKey` before `addStrand`, so `founder:true` + `Type:'c'` always has the key the bootstrap derives the founding keypair from (the null-key reject is covered by the seam test).
- Idempotency holds: the bootstrap's insert-if-absent guards make web's repeated `addChatStrand(CHAT_STRAND_ID)` on reload, and any founder re-`addStrand`, a no-op (verified against the documented mechanism + existing plumbing tests).
- Open founders seat only `Header(o)`; `Member`/`Authority`/`Invite` are `OnlyClosed`, so the chat DML path is unperturbed.

### Docs — checked, accurate, no change needed
- `docs/architecture.md` (L505–528) already describes the founder bootstrap and names the founder as "the party that … calls `CadreNode.publishStrand`" — i.e. exactly the creator helpers this ticket wires. The docs describe the design intent, which is now actually realized; nothing in them is rendered false by the change. No other doc references the founder flag.

### Minor finding fixed inline
- The plan asked the web closed-creator to carry a comment noting the founder bootstrap; the implementer added the flag without it (while the adjacent `mode` flag was commented). Added a concise comment at `cadre-web.ts:494` documenting why this node is the founder and that the bootstrap is idempotent. Cosmetic; no behavior change.

### Tests / lint — pass
- `yarn workspace @serfab/cadre-core test publish-strand` → 1 file, 7 tests pass.
- `yarn workspace @serfab/reference-app-rn test` → 8 files, 133 tests pass.
- `npx eslint` on all five touched source/test files + the review edit → clean.

### Not fixed (acceptable, noted)
- **No major findings; no new tickets filed.**
- Web/NS have no vitest harness, so their creators rely on the CadreNode-seam test + this review (acknowledged in the original handoff; unchanged).
- RN caller test pins `joinChatStrand` as the joiner exemplar; `joinClosedChatStrand`/`joinClosedChatStrandFromFormation` are not separately pinned. Marginal — they share the same omit-the-flag shape — and not worth a dedicated regression test.
- Optional web-e2e `__cadre.readStrandMembership` hook and the unbound `StrandProvisioner` founder predicate remain out of scope (no such path is wired today).
