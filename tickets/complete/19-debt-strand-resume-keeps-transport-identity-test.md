description: Added a test proving that when a sleeping group connection wakes back up, it comes back under the same network name it had before instead of a brand-new one.
prereq:
files: packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/src/strand-instance-manager.ts (unchanged; subject under test), docs/architecture.md (hibernation wake bullet)
difficulty: easy
----

# Waking a hibernated strand reuses its transport identity — pinned by tests

A cadre node runs each strand it participates in as its own libp2p node with its own network
identity (peerId), derived once at launch from the cadre identity key plus the strand id. Idle
strands hibernate and wake on demand. Waking rebuilds the runtime from a launch config the manager
retained at launch — that retention is what makes the woken strand come back under the *same*
peerId, keeping relay reservations and peer-store entries valid.

This ticket is test-only. No production behavior changed.

## What shipped

`describe('StrandInstanceManager resume transport identity')` in
`packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts` — five tests, reusing the
file's existing `vi.mock` doubles for `createLibp2pNode` and `StrandDatabase`:

- same private key bytes on the rebuilt libp2p node after quiesce → resume
- resume overrides (`bootstrapNodes`, `mode`) replace only those fields, key untouched
- the key survives **repeated** hibernate/wake cycles (added at review — see below)
- a strand launched with no private key resumes with none (resume does not synthesize one)
- a full `stopStrand` drops the retained config, so a same-id relaunch uses its own key

Plus a one-line documentation of the guarantee in `docs/architecture.md` (hibernation wake bullet).

## Review findings

**Verified the tests are not vacuous.** Mutated `resumeStrand` to build its resume config with
`privateKey: undefined` instead of carrying the retained one; tests 1 and 2 failed with a byte-array
vs `undefined` diff, then reverted the mutation and re-confirmed green. Byte comparisons are
`toEqual` on real `Uint8Array`s, not reference identity, and every assertion has a positive form
(`toBeUndefined` / `.not.toEqual(realBytes)`) so none passes on two `undefined`s.

**Fixed inline (minor):**

- *Duplication.* The new `describe` block copied ~35 lines of setup verbatim from the pre-existing
  one — `testSchema`/`testVersion`, the author keypair `beforeEach`, `createStrandRow`,
  `createSAppConfig`, `createStartConfig`. Hoisted all of it (plus the new
  `lastCreateLibp2pNodeArgs` helper) to module scope; both blocks now share one copy. Net −35 lines.
- *Coverage gap: repeated cycles.* `resumeStrand` writes its merged config back over the retained
  one, so cycle N+1 rebuilds from cycle N's *output*, not from the original launch config. Every
  submitted test exercised exactly one cycle, so a merge that dropped the key only on the rewritten
  config would have passed. Added `'the key survives repeated hibernate/wake cycles, not just the
  first'` — two cycles, different bootstrap seed each time, key asserted byte-equal after both.
- *Undocumented guarantee.* `docs/architecture.md` described waking as "reconstructs the libp2p node
  + StrandDatabase" without stating that identity is preserved — the exact property now under test.
  Extended that bullet to state the peerId is stable across hibernation, that only a full
  `stopStrand` drops it, and where the test lives.

**Major findings: none.** No new tickets filed. The implementation is test-only against a subject
that already behaved correctly; no defect surfaced in `strand-instance-manager.ts`.

**Tripwires: none recorded.** Nothing conditional came up — the tests use mocked doubles with no
resource, performance, or scale dimension that could trip later.

**Known gap, accepted (flagged by the implementer, confirmed correct):** this suite mocks
`createLibp2pNode` entirely, so it proves the *config* handed to libp2p is right, not that libp2p
honors it end-to-end. Launch-time peerId derivation is covered by
`test/cadre-node-strand-launch-key.spec.ts`; end-to-end peerId stability by the real-node
integration suites. Out of scope by design for a mocked unit suite, not a missed case.

**Cross-checks that came up clean:** helper naming and function size are fine post-hoist; no
`any` (the one cast is `unknown[][]`, forced by the mock factory having no declared parameter
type, and is comment-free but self-evident at the call site); no resource-cleanup or error-path
concern (tests own no real handles); no other doc file describes strand transport identity, so
`architecture.md` was the only one needing the update.

## Verification

- `yarn vitest run test/strand-instance-manager-hibernation.spec.ts` (`packages/cadre-core`):
  **12/12 passed**.
- Full `yarn vitest run` (`packages/cadre-core`): **83 files, 1324 passed, 1 skipped**. The skip is
  `test/key-store.spec.ts:231`, a pre-existing `it.skipIf(process.platform === 'win32')` on a POSIX
  file-permission assertion — unrelated to this ticket, not newly disabled.
- `yarn typecheck` (`packages/cadre-core`): clean, exit 0.
- `yarn lint packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts` (repo root):
  clean, exit 0.
