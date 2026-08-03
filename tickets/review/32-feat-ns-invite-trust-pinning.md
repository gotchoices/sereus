---
description: Review the new Settings field on the NativeScript phone app where you paste a group leader's invitation, which lets the app accept that group's join bundle instead of refusing every invitation and running alone forever.
files: packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/app/app.css, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-ns/scripts/run-e2e.mjs, packages/reference-app-ns/README.md, docs/reference-app-ns.md, docs/architecture.md
difficulty: medium
---

# Review: NativeScript Settings — pin owner trust from a pasted enrollment invite

## What the change does, in plain terms

Joining an existing cadre means applying a **seed** — a signed bundle of peer
addresses handed over by an existing member. The node only accepts a seed whose
signer it already trusts, and "already trusts" means the signer's key sits in a
node-local record called the **trusted-owner anchor** (never replicated, so a
stranger cannot write itself into it over the network).

Before this change `reference-app-ns` had no way to put anything into that
anchor, so every seed it was handed was rejected and the app could only ever run
solo. This change ports React Native's fix: an optional text field in Settings
where the user pastes an **enrollment invite** (a `CadreInvite`, handed over
out-of-band by whoever runs the cadre). Its owner keys are written into the
anchor and used as the trust policy for that one seed apply.

## Where the code landed

| File | Change |
|---|---|
| `src/cadre-vm.ts` | new `ownerKeysFromInvite(encoded): string[]`; `applySeed` widened to `(encoded, pinnedOwnerKeys?)` |
| `app/settings/settings-view-model.ts` | new `enrollInviteInput` two-way property; `onApplySeed` rewritten |
| `app/settings/settings-page.xml` | hint `Label` + field `Label` + `TextView automationText="input-enroll-invite"` inside the Seed Bootstrap block |
| `app/app.css` | new `.hint` class (muted copy under a field; mirrors RN's `styles.hint`) — **not in the ticket's file list, added because the hint label needed a style** |
| `src/test-ids.ts` | `enrollInviteInput: 'input-enroll-invite'` |
| `scripts/run-e2e.mjs` | `ENROLL_INVITE: testData.enrollInvite` added to `maestroEnv` |
| `docs/reference-app-ns.md`, `docs/architecture.md`, `packages/reference-app-ns/README.md` | ⚠️ paragraphs rewritten; automationText inventory + Maestro env-var list updated; device-smoke step 7 rewritten |

Ordering that is load-bearing and must not be "cleaned up":
`node.trustOwnerKeys(keys, 'invite')` runs **before** `node.applySeed(...)`, so
the anchor already holds the keys when seed trust consults it. Commented at the
call site (`src/cadre-vm.ts:259-271`).

## Gates run

```
yarn workspace @serfab/reference-app-ns typecheck        → exit 0
yarn workspace @serfab/reference-app-ns test:bundle      → "0 errors, 0 warnings"
yarn eslint src/cadre-vm.ts src/test-ids.ts app/settings/settings-view-model.ts scripts/run-e2e.mjs
                                                         → 0 errors
```

`scripts/run-e2e.mjs` is outside the ESLint project's include patterns and was
reported as `File ignored because of a matching ignore pattern` — it was **not**
actually linted. Pre-existing condition of the repo's flat config (tracked
separately as `backlog/debt-tooling-scripts-unlinted-and-unchecked`), not
introduced here. The bundle check does not cover it either (it is a Node script,
not part of the app import graph), so that one-line edit is eyeball-verified
only: the field name `testData.enrollInvite` matches what the fixture writes at
`packages/reference-app-rn/test-fixture/start.mjs:147`.

## Known gaps — please treat these as the starting point, not the finish line

1. **No unit test covers any of the new code.** `packages/reference-app-ns` has
   no unit-test runner at all (only `typecheck`, `test:bundle`, `test:e2e`).
   Introducing one is `tickets/plan/33-debt-ns-unit-test-harness.md`, which had
   not landed when this was implemented. The seven cases that ticket should pick
   up, against a fake `CadreNode`, are listed under **Tests owed** below.
2. **The Maestro e2e path is device-only** — it needs an emulator, a built APK,
   `adb`, and the Maestro CLI, none of them agent-runnable. It is additionally
   blocked by `backlog/debt-ns-maestro-flow-parity-gaps`.
3. **No device run happened.** Nothing here has been executed on a phone. In
   particular, whether Maestro's `id:` matcher resolves NS `automationText` at
   all is still the open, documented, device-only risk in
   `docs/reference-app-ns.md` § "The one real NS-specific risk: test-id
   resolution" — `input-enroll-invite` inherits that risk like every other id.
4. **`.hint` styling is unverified visually.** The class was added to
   `app.css` by analogy with RN's `styles.hint`; nobody has looked at it
   rendered.

## Tests owed (hand to `debt-ns-unit-test-harness`)

Against a fake `CadreNode`:

- `ownerKeysFromInvite` on an invite with two keys returns both, in order.
- `ownerKeysFromInvite` on an invite without `ownerKeys` returns `[]`.
- `ownerKeysFromInvite` on garbage text throws a message containing
  "enrollment invite" (not a bare `SyntaxError`), with the original as `cause`.
- `applySeed(encoded, keys)` calls `trustOwnerKeys` **before** `applySeed` —
  assert call *order*, not merely that both happened.
- `applySeed(encoded)` with no keys calls neither `trustOwnerKeys` nor passes a
  `trustPolicy`.
- `applySeed(encoded, [])` behaves as the no-keys case (empty array is not a pin).
- A rejected `applySeed` result surfaces `result.error` as the thrown message.

## Manual / device verification the reviewer may want to request

Two-node drone smoke, per `packages/reference-app-ns/README.md` § "Device smoke"
step 7: paste the drone's enrollment invite + seed → expect the modal
`Seed applied` / `Pinned 1 owner key(s); peer cache updated`. Then a **second**
Apply Seed with the invite field **blank** must also succeed — that is the
acceptance criterion proving the pin actually reached the durable anchor rather
than only the per-call trust policy.

## Behaviours to check during review

Each of these is an intended behaviour, not an oversight — confirm the code
actually does it.

- **Blank invite field** → no pin, no `trustOwnerKeys` call, no `trustPolicy`
  override. Modal reads "Peer cache updated (no owner keys pinned)".
- **Invite present but `ownerKeys` absent or `[]`** → identical to blank; the
  modal must not claim a pin succeeded.
- **Malformed / truncated invite** → `ownerKeysFromInvite` throws first (it runs
  before `applySeed` in `onApplySeed`), so `trustOwnerKeys` is never reached, the
  anchor is untouched, and the seed is not applied. Assert the *anchor is
  unchanged*, not merely that an error appeared.
- **Invite with one malformed key among good ones** → `trustOwnerKeys` is
  all-or-nothing (`requireEd25519PublicKeyB64` per key), so nothing is anchored,
  the error names the bad value, and `applySeed` never runs.
- **Invite whose keys do not cover the seed's signer** → the pins *are* anchored
  anyway (deliberate; see below), then `pinnedKeyTrustPolicy` rejects the seed.
- **Failure leaves both fields populated; success clears both.** A user who
  mistypes the seed must not lose the pasted invite.
- **Apply Seed tapped twice quickly** — the button is not disabled during the
  apply (same as RN today). `trustOwnerKeys` is idempotent and a re-applied seed
  is accepted again, so this is benign; no spinner was added, by design.
- **Cross-subsystem:** `applySeed` also feeds the durable bootstrap-peer store
  and calls `refreshMembershipGate`. Anchoring a new owner key flips
  already-synced rows into the authorized set, so a successful pin can move
  membership/strand state with no new row arriving. Expected, nothing to fix.

## Decisions already settled upstream — not open for relitigation

- **A pin sticks even when the seed that motivated it is rejected.** Pasting the
  invite *is* the out-of-band trust act; the seed is a separate artifact that may
  be stale, for another party, or corrupt. RN behaves this way; NS matches.
  Commented at the call site.
- **No owner private key / genesis self-anchor for this app.** NS has no
  Keychain/Keystore integration, so an owner private key would sit in the same
  plaintext SQLite blob as the identity key — and the app does not need one
  (solo forming works; enrolling now works via the invite).
- **No new validation in `cadre-core`.** `trustOwnerKeys` already validates every
  key all-or-nothing with a message naming the offending value.
- **Party-id persistence stays out of scope.** Consequence, documented not fixed:
  a pin survives a relaunch only if the user retypes the same party id, because
  both node-local records are party-scoped. Tracked in
  `backlog/feat-rn-persist-node-start-options` (which carries an NS arm).

## Tripwire parked in code

`src/cadre-vm.ts:230` (`NOTE:` at `ownerKeysFromInvite`) — a hand-crafted invite
whose `ownerKeys` is a non-array (say, a number) yields a falsy `.length`, so no
pin is attempted and the seed is then rejected by the default anchored policy.
Safe, but the resulting error names the anchor rather than the bad invite. If
that ever confuses a real user, the fix is shape validation inside
`CadreNode.decodeInvite` — one site, serving both phone apps — not a second
guard in the NS view model.
