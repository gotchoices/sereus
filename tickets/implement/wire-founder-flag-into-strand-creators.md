description: When someone creates a private (or public) group, the app never tells the system "I'm the founder", so the group is born with no owner and can never let anyone in. Flip that "I am the founder" signal on in every real create-a-group flow and prove a freshly created private group ends up with its owner seated.
prereq:
files: packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-rn/src/chat-strand.ts, packages/reference-app-ns/src/chat-strand.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-founder-bootstrap.spec.ts, packages/cadre-core/test/publish-strand.spec.ts, packages/reference-app-rn/test/strand-selection.spec.ts
difficulty: easy
----

## Context

`strand-membership-founder-bootstrap` (complete) threaded a caller-supplied `founder`
flag from `CadreNode.addStrand` → `launchStrand` → `StrandInstanceManager.startStrand` →
`StrandDatabase.initialize`, which runs `bootstrapFounderMembership` once at bring-up:

- **Closed strand** (`Type:'c'`) founder seats `Strand.Header(Type='c')` **plus** the founding
  `Strand.Member` and `Strand.Authority` (both keyed on `strandMemberKeyPair(MemberPrivateKey).publicKeyB64`).
- **Open strand** (`Type:'o'`) founder seats `Strand.Header(Type='o')` only (`Member`/`Authority`/`Invite`
  are `OnlyClosed`).
- Every write is insert-if-absent (row-count guarded) → idempotent across restart / re-`addStrand`.
- A joiner leaves `founder` false/unset and writes nothing; its rows arrive via Optimystic sync.

The plumbing is fully wired and tested at the `StrandInstanceManager` seam
(`packages/cadre-core/test/strand-founder-bootstrap.spec.ts`). **No cadre-core source change is
needed** — `StrandConfig.founder` (`packages/cadre-core/src/types.ts:465`) already flows end to end.

**The gap is purely that no production caller sets `founder: true`.** Every real closed-strand
creator pairs `publishStrand(id,'c',memberKey)` with an `addStrand` that omits the flag, so the
founder bootstrap never fires: a freshly created closed strand has **no** `Header`, no founding
`Member`, no founding `Authority`, and can therefore never admit anyone via the invite/authority
flows. The feature is dead in production until a real caller opts in. This ticket flips the flag on.

## Decisions (resolved during plan — do not re-litigate)

1. **Founder predicate = the creator helper (the node that calls `publishStrand`).** All three apps'
   *create* helpers are distinct from their *join* helpers, so there is exactly one founder per
   strand. Pass `founder: true` from the create helpers; leave every join helper untouched.

2. **Formation responder/host needs no separate wiring.** The reference apps only use the
   **bound-invite / provision-then-record** flow, where the host strand is the one
   `createClosedChatStrand` already created and published — so flipping that helper covers the host
   side. There is **no unbound `StrandProvisioner` (responder-provisions-at-redemption) path wired
   in the reference apps or `cadre-host`** (verified: zero `provisionStrand`/`founder` matches in
   `packages/cadre-host/src` and the apps). If such a path is wired later, the provisioner that mints
   + publishes the strand becomes the founder there — out of scope now, noted for the future.

3. **Open-strand creators also found (seat `Header(o)` only).** Rationale: the bootstrap was
   explicitly built to handle `type==='o'`; leaving it unused is dead code and an inconsistent
   genesis story; the write is idempotent and low-risk (no `Member`/`Authority`, no gating); and it
   keeps "creator ⇒ founder" a single uniform rule rather than "closed creators found, open creators
   don't." **Rejected alternative:** leaving open strands unfounded — smaller diff, but perpetuates an
   empty `Header` table for every open strand and a split rule. The open solo web strand
   (`CHAT_STRAND_ID`, not published to any control network) still founds locally — `founder` means
   "run the local genesis bootstrap," independent of whether the row is also published.

4. **Joiner paths stay `founder:false`.** `joinViaInvitation` (web), `joinClosedChatStrandFromFormation`
   / `joinClosedChatStrand` / `joinChatStrand` (RN), `joinChatStrand` (NS): must NOT pass `founder`.

## Edge cases & interactions

- **Closed founder requires `MemberPrivateKey`.** All `createClosedChatStrand` paths mint the key
  before `addStrand`, so `founder:true` + `Type:'c'` always has the key the bootstrap derives the
  founding keypair from. (A closed `founder:true` with no key throws and tears the runtime down — by
  design; not reachable here.)
- **Idempotency / restart & reload.** Web uses persistent IndexedDB; `addChatStrand` re-runs for the
  fixed `CHAT_STRAND_ID` on every reload, and a founder may re-`addStrand`. The bootstrap's
  insert-if-absent guards make every re-run a no-op (no duplicate `Header`/`Member`/`Authority`).
  The web `reload-persistence` e2e must still pass.
- **Open-chat round-trip unaffected.** Founding an open strand adds only a `Header(o)` row; it must
  not perturb `Member`/`Message` DML. Re-run the web open-chat `messages-roundtrip` e2e (or reason
  about it) to confirm seating a `Header(o)` is inert to the chat path.
- **Exactly one founder per strand.** Two browsers attaching the same shared open `CHAT_STRAND_ID`
  each found locally (solo bootstrap DBs that don't converge); on any later convergence the singleton
  `Header` PK + insert-if-absent collapse to one. No double-genesis.
- **Joiner regression.** Adding `founder:true` to a *join* helper by mistake would make a joiner
  double-write rows that should arrive via sync — keep the flag strictly on create helpers.
- **NS has no closed creator.** `reference-app-ns/src/chat-strand.ts` only has the open
  `createChatStrand` + `joinChatStrand`; only the open-founding decision applies there.

## TODO

### Flip the flag in the production creators

- **web** (`packages/reference-app-web/src/lib/cadre-web.ts`):
  - `createClosedChatStrand` (~line 491): add `founder: true` to the `addStrand` call (alongside
    `mode:'networked'`). Update the comment to note the founder bootstrap now seats Header/Member/Authority.
  - `addChatStrand` (~line 720): add `founder: true` to the open solo strand's `addStrand`.
  - Leave `joinViaInvitation` (~line 589) `founder`-free.
- **RN** (`packages/reference-app-rn/src/chat-strand.ts`):
  - `createClosedChatStrand` (~line 156): add `founder: true` to `addStrand`.
  - `createChatStrand` (~line 99): add `founder: true` to the open `addStrand`.
  - Leave `joinChatStrand`, `joinClosedChatStrand`, `joinClosedChatStrandFromFormation` untouched.
- **NS** (`packages/reference-app-ns/src/chat-strand.ts`):
  - `createChatStrand` (~line 70): add `founder: true` to the open `addStrand`.
  - Leave `joinChatStrand` untouched.

### Tests

- **CadreNode-seam end-to-end (required, no relay infra)** — add to
  `packages/cadre-core/test/publish-strand.spec.ts` (or a sibling spec reusing its self-authority
  node harness): bring up a self-signing `CadreNode`, then
  `node.addStrand({ strandRow:{Id, MemberPrivateKey, Type:'c'}, sAppConfig: <signed>, mode:'bootstrap', founder:true })`
  and assert the strand instance's DB has `Strand.Header`=1, `Strand.Member`=1, `Strand.Authority`=1,
  with `Member.Key` / `Authority.MemberKey` == `strandMemberKeyPair(MemberPrivateKey).publicKeyB64`.
  Add the open counterpart: `Type:'o'`, `founder:true` → `Header`=1, `Member`=0, `Authority`=0,
  `Header.Type='o'`. This proves the public `addStrand` threading the reference apps actually call
  (one layer above the existing `StrandInstanceManager` plumbing test). Use a **signed** sApp like
  `strand-founder-bootstrap.spec.ts` (`signedSApp()`), or set `requireSignedSchemas:false`.
  - Expected outputs: closed → `{Header:1, Member:1, Authority:1}` with matching derived key; open →
    `{Header:1, Member:0, Authority:0, Header.Type:'o'}`; a closed `founder:true` with null
    `MemberPrivateKey` rejects (mirror the existing teardown assertion).
- **RN caller pins the flag (required)** — add a vitest unit test (new file under
  `packages/reference-app-rn/test/`, e.g. `chat-strand.spec.ts`) that calls `createClosedChatStrand`
  and `createChatStrand` against a fake `CadreNode`
  (`{ publishStrand: vi.fn(), addStrand: vi.fn().mockResolvedValue(<stub instance>), peerId:{toString:()=>'p'} }`)
  and asserts `addStrand` was called with `expect.objectContaining({ founder: true })`. `assignLocalMemberRole`'s
  `insertMember` may throw against the stub instance — it's caught/logged, so the test still passes;
  `generateStrandMemberKey` is real and needs no mock. This is the cheap regression guard that the
  *callers* keep passing the flag (web/NS have no vitest harness, so they rely on the CadreNode-seam
  test + code review; an optional web-e2e membership-read hook is noted below, not required).

### Validate

- `yarn workspace @serfab/cadre-core test` (run the founder-bootstrap + publish-strand specs;
  stream with `2>&1 | tee`).
- `yarn workspace @serfab/reference-app-rn test`.
- `yarn lint` (touched files) and the relevant `tsc`/build for the three reference apps.
- If a failure is plainly pre-existing / outside this diff, follow the `.pre-existing-error.md`
  flow rather than chasing it here.

## Out of scope / optional

- The bootstrap mechanism itself (landed + tested) and the invite/peer/rotation writers.
- The unbound `StrandProvisioner` (responder-provisions-at-redemption) founder predicate — not wired
  anywhere today; revisit when that path is added.
- **Optional web-e2e proof:** a read-only `__cadre.readStrandMembership(strandId)` hook
  (Header/Member/Authority counts) asserted in the distributed `formation-convergence` e2e where a
  host closed strand is actually created (`createInvitation` needs a relay reservation, so it can't
  run solo). Park as a follow-up if relay infra makes it flaky/non-agent-runnable — the CadreNode-seam
  test already proves the end-to-end bootstrap without infra.
