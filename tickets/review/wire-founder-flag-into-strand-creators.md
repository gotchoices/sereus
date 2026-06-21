description: Flip the "I am the founder" flag on in every real create-a-group flow so freshly created strands bootstrap their Header/Member/Authority rows correctly.
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/src/chat-strand.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/test/chat-strand.spec.ts
----

## What was done

Added `founder: true` to every real strand-creator helper; every joiner helper is untouched.

### Source changes

| File | Function | Change |
|---|---|---|
| `packages/reference-app-web/src/lib/cadre-web.ts` | `createClosedChatStrand` (~L491) | Added `founder: true` to the `addStrand` call alongside `mode:'networked'` |
| `packages/reference-app-web/src/lib/cadre-web.ts` | `addChatStrand` (~L723) | Added `founder: true` to the open solo strand `addStrand` call |
| `packages/reference-app-rn/src/chat-strand.ts` | `createChatStrand` (~L99) | Added `founder: true` to `addStrand` |
| `packages/reference-app-rn/src/chat-strand.ts` | `createClosedChatStrand` (~L156) | Added `founder: true` to `addStrand` |
| `packages/reference-app-ns/src/chat-strand.ts` | `createChatStrand` (~L70) | Added `founder: true` to `addStrand` |

### Tests added

**`packages/cadre-core/test/publish-strand.spec.ts`** — new describe block `CadreNode.addStrand founder bootstrap (node-level seam)` with 3 tests:
- Closed founder → Header=1, Member=1, Authority=1 with derived `MemberPrivateKey` key
- Open founder → Header=1, Member=0, Authority=0, Header.Type='o'
- Closed founder with null `MemberPrivateKey` → rejects with `/MemberPrivateKey/i`

**`packages/reference-app-rn/test/chat-strand.spec.ts`** — new file, 3 tests:
- `createChatStrand` passes `founder: true` to `addStrand`
- `createClosedChatStrand` passes `founder: true` to `addStrand`
- `joinChatStrand` does NOT pass `founder: true`

## Validation

- `yarn workspace @serfab/cadre-core test` — 47 files, 647 tests, all pass
- `yarn workspace @serfab/reference-app-rn test` — 8 files, 133 tests, all pass
- `yarn lint` — clean

## Use cases for testing

1. **Closed group creation** — call `createClosedChatStrand`; after `addStrand` the strand DB should have `Strand.Header`=1, `Strand.Member`=1, `Strand.Authority`=1. The founding member key should match `strandMemberKeyPair(memberPrivateKey).publicKeyB64`.
2. **Open group creation** — call `createChatStrand`; the strand DB should have `Strand.Header`=1, `Strand.Member`=0, `Strand.Authority`=0.
3. **Join paths** — `joinChatStrand`, `joinClosedChatStrand`, `joinClosedChatStrandFromFormation`, `joinViaInvitation` should NOT pass `founder: true` (rows arrive via sync).
4. **Idempotency** — re-running `addStrand` with `founder: true` on the same strand is a no-op (insert-if-absent guards in the bootstrap).

## Known gaps / out of scope

- Web and NS have no vitest harness; they rely on the CadreNode-seam test + code review.
- Optional web-e2e `__cadre.readStrandMembership` hook in the `formation-convergence` e2e is deferred (requires relay infra, non-agent-runnable).
- Unbound `StrandProvisioner` (responder-provisions-at-redemption) founder predicate — not wired anywhere; out of scope.
