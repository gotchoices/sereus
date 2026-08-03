description: Add a field to the NativeScript phone app's Settings screen where you paste an invitation from a group leader, so the app will accept that group's join bundle instead of refusing every invitation and running alone forever.
files: packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-ns/scripts/run-e2e.mjs, packages/reference-app-ns/README.md, docs/reference-app-ns.md, docs/architecture.md, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/maestro/_setup.yaml
difficulty: medium
---

# NativeScript Settings: pin owner trust from a pasted enrollment invite

## Background — why the app currently cannot join anything

Joining an existing cadre means applying a **seed**: a signed bundle of peer
addresses and party identity handed over by an existing member. `applySeed`
verifies the seed's signature and then asks a **`SeedTrustPolicy`** whether the
key that signed it should be trusted. The default is `anchoredTrustPolicy()`
(`packages/cadre-core/src/seed-trust-policy.ts`), which trusts a signer only if
its key is already in the node's **trusted-owner anchor** — a node-local,
never-replicated per-party record. The anchor is deliberately not sourced from
replicated control state, because any connecting node can genesis-insert its own
key into the replicated `OwnerKey` table.

Two things normally write that anchor:

1. **Genesis self-trust** — a node started with an owner *private* key anchors
   its own public key.
2. **An invite pin** — the user pastes a `CadreInvite`, whose `ownerKeys` are
   handed to `CadreNode.trustOwnerKeys(keys, 'invite')` *and* to
   `pinnedKeyTrustPolicy(keys)` for the apply itself.

`reference-app-ns` does neither: `startPhoneNode` wires no owner private key,
and nothing in `src/` or `app/` calls `trustOwnerKeys` or passes a trust policy.
So its anchor is always empty and **Apply Seed always fails**. The app can only
run solo. This is pre-existing, not a regression from the durable-anchor work.

The React Native sibling already has the flow. This ticket ports it.

## What ships

### 1. Two new seams on `CadreViewModel` (`src/cadre-vm.ts`)

Mirror `packages/reference-app-rn/src/use-cadre.ts` exactly — that file is the
reference for both the shape and the ordering constraint.

```ts
/** Decode a pasted base64url CadreInvite and return its pinned owner keys (empty if none). */
ownerKeysFromInvite(encodedInvite: string): string[]

/** Apply a base64url seed, optionally pinning owner keys (e.g. from a CadreInvite). */
applySeed(encoded: string, pinnedOwnerKeys?: string[]): Promise<void>
```

`applySeed` keeps its current single-argument callers working (the second
parameter is optional) and gains the RN body:

```ts
const trustPolicy = pinnedOwnerKeys?.length ? pinnedKeyTrustPolicy(pinnedOwnerKeys) : undefined;
if (pinnedOwnerKeys?.length) {
    // Enrollment seam: anchor the invite's keys BEFORE the seed is applied, so the
    // anchor already holds them when seed trust consults it.
    await node.trustOwnerKeys(pinnedOwnerKeys, 'invite');
}
const result = await node.applySeed(seed, trustPolicy ? { trustPolicy } : undefined);
```

**The `trustOwnerKeys`-before-`applySeed` ordering is load-bearing** — do not
reorder or fold them together.

`ownerKeysFromInvite` calls `node.decodeInvite(encoded)` and returns
`invite.ownerKeys ?? []`. It throws `'Node not started'` before touching the node,
matching `applySeed`'s guard order.

**One deliberate difference from RN:** `CadreNode.decodeInvite` is a raw
`base64url → JSON.parse → cast` with no shape check, so a typo'd paste surfaces
as a bare `SyntaxError: Unexpected token …`. Wrap the decode in the NS view model
and rethrow with app-level copy naming what was expected, e.g.
`Enrollment invite could not be read (expected a base64url CadreInvite)`, with
the original as `cause`. This is UI error framing and belongs at the app layer —
do **not** add shape validation here beyond that.

Add a `NOTE:` tripwire comment at `ownerKeysFromInvite`: a hand-crafted invite
whose `ownerKeys` is a non-array (e.g. a number) yields a falsy `.length`, so no
pin is attempted and the seed is rejected by the default policy — safe, but the
error names the anchor rather than the bad invite. If that ever confuses a real
user, the fix is shape validation inside `CadreNode.decodeInvite` (one site, both
apps), not a second guard here.

### 2. Settings page state + action (`app/settings/settings-view-model.ts`)

- New two-way bound property `enrollInviteInput` (same getter/setter/notify shape
  as `seedInput`; it does **not** feed `canApplySeed` — the seed alone gates the
  button, matching RN's `disabled={!seedInput.trim()}`).
- `onApplySeed` gains the RN body: read the trimmed invite, derive
  `pins = invite ? this.cadre.ownerKeysFromInvite(invite) : undefined`, call
  `this.cadre.applySeed(seed, pins)`, clear **both** fields on success only, and
  report:
  - `pins?.length` → `Pinned ${pins.length} owner key(s); peer cache updated`
  - otherwise → `Peer cache updated (no owner keys pinned)`

  Modal **title stays exactly `'Seed applied'`** — `_setup.yaml` asserts that
  string. Failure path stays `showAlert('Seed failed', String(err))` and leaves
  both fields populated so the user can correct and retry.

### 3. Settings XML (`app/settings/settings-page.xml`)

Inside the existing connected-only `Seed Bootstrap` block, between the seed
`TextView` and the Apply Seed `Button`:

- A hint `Label` (`textWrap="true"`, reuse the existing `label` class or add a
  `hint` class in `app/app.css` if the muted style is wanted) carrying copy
  equivalent to RN's: optional; paste an enrollment invite (`CadreInvite`) to pin
  its owner keys as the trust anchor for this seed; a cold node rejects a seed
  signed by another cadre unless its key is pinned.
- `<Label text="Paste enrollment invite (for trust)" class="label" />`
- `<TextView text="{{ enrollInviteInput }}" hint="base64url CadreInvite (optional)"
  class="input textarea" automationText="input-enroll-invite" />`

### 4. Automation id (`src/test-ids.ts`)

Add `enrollInviteInput: 'input-enroll-invite'` to `TEST_IDS.settings`, matching
`packages/reference-app-rn/src/test-ids.ts:14`. (The XML uses the literal string —
NS XML cannot reference a TS constant — but the constant keeps the two apps'
id lists comparable and is what the docs' id inventory is checked against.)

### 5. e2e wiring (`scripts/run-e2e.mjs`)

`packages/reference-app-rn/maestro/_setup.yaml:50-53` already taps
`input-enroll-invite` and types `${ENROLL_INVITE}`, and the NS runner reuses those
flows verbatim — but the NS `maestroEnv` object never sets `ENROLL_INVITE`
(the RN runner does, at `scripts/run-e2e.mjs:217`). Add
`ENROLL_INVITE: testData.enrollInvite` to the `maestroEnv` literal. The fixture
already writes `enrollInvite` into `test-data.json`
(`packages/reference-app-rn/test-fixture/start.mjs:147`).

This is not speculative parity work: without both this and the XML field, the NS
e2e setup flow fails at its first `tapOn: id: "input-enroll-invite"`.

### 6. Docs

- **`docs/reference-app-ns.md`** — the ⚠️ paragraph in *Node-local records*
  ("Nothing in this app writes the anchor yet… tracked as
  `feat-ns-invite-trust-pinning`") is now false in its invite half. Rewrite: the
  invite pin is the anchor's writer; the app still wires no owner private key, so
  there is no genesis self-anchor (it does not need one — it either forms solo or
  enrolls via invite). Keep the party-id caveat and point it at
  `feat-rn-persist-node-start-options`. Also add `input-enroll-invite` to the
  automationText inventory in *§ The one real NS-specific risk: test-id
  resolution*, and mention `ENROLL_INVITE` alongside the other env vars in the
  Maestro orchestrator step list.
- **`docs/architecture.md:202`** — the trailing ⚠️ sentence ("The NativeScript
  app's anchor is durable but nothing in that app ever *writes* it… tracked as
  `feat-ns-invite-trust-pinning`") must be updated to say the invite-paste field
  now exists and the anchor fills from it, exactly as React Native's does. Leave
  the *other* ⚠️ (party-id persistence) alone.
- **`packages/reference-app-ns/README.md`** — device-smoke step 7 (drone) should
  mention pasting the drone's enrollment invite before Apply Seed.

## Design decisions already made — do not relitigate

- **A pin sticks even when the seed that motivated it is then rejected.** RN
  behaves this way and NS matches it. Pasting an invite *is* the out-of-band
  trust act; the seed is a separate artifact that may be stale, for another
  party, or corrupt. Rolling the anchor back on a seed failure would make the
  user re-paste the invite for every retry. This is not "silently widening
  trust" — the widening is exactly what the user asked for by pasting. Say so in
  a comment at the call site.
- **No owner private key / genesis self-anchor for this app.** Out of scope. NS
  has no Keychain/Keystore integration, so an owner private key would sit in the
  same plaintext SQLite blob as the identity key; and the app does not need one
  (solo forming works today, enrolling works via this ticket).
- **No new validation in `cadre-core`.** `trustOwnerKeys` already runs
  `requireEd25519PublicKeyB64` over every key, all-or-nothing, with a message
  naming the offending value (see `tickets/complete/25-debt-pinned-owner-keys-accept-malformed-values.md`).
  Nothing to add.
- **Party-id persistence stays out.** The plan ticket asked whether to fold it
  in; the answer is no — it is a distinct root cause affecting both phone apps
  and is tracked in `backlog/feat-rn-persist-node-start-options`, to which an
  NS arm has been appended. Consequence to document (not fix): a pin survives a
  relaunch only if the user retypes the same party id.

## Edge cases & interactions

The reviewer will check each of these.

- **Blank invite field** — no pin, no `trustOwnerKeys` call, no `trustPolicy`
  override; seed evaluated against whatever the anchor already holds. Today's
  behavior, unchanged. Modal says "no owner keys pinned".
- **Invite present but `ownerKeys` absent or `[]`** (older invite) — identical to
  blank: no pin attempted, and the modal must *not* claim a pin succeeded.
- **Malformed / truncated invite** — decode throws; the wrapped app-level message
  is shown, `trustOwnerKeys` is never reached, the anchor is untouched, and the
  seed is **not** applied. Assert the anchor is unchanged, not merely that an
  error appeared.
- **Invite carrying one malformed key among good ones** — `trustOwnerKeys` is
  all-or-nothing: nothing is anchored, the error names the bad value, and
  `applySeed` never runs.
- **Invite whose keys do not cover the seed's signer** — the pins *are* anchored
  (per the decision above), then `pinnedKeyTrustPolicy` rejects the seed with
  "neither an anchored nor a pinned owner". User-actionable.
- **Second seed from the same owner with a blank invite** — must now succeed:
  the first apply persisted the key into the durable anchor, so
  `anchoredTrustPolicy` clears it. This is the acceptance criterion that proves
  the pin actually reached the store rather than only the per-call policy.
- **Node not started** — both `ownerKeysFromInvite` and `applySeed` throw
  `'Node not started'` before dereferencing the node. The seed section is inside
  the connected-only `StackLayout`, so this is defense-in-depth, not a live path.
- **Failure leaves both fields populated; success clears both.** A user who
  mistypes the seed must not lose the pasted invite.
- **Apply Seed tapped twice quickly** — the button is not disabled during the
  apply (same as RN today). `trustOwnerKeys` is idempotent and a re-applied seed
  is accepted again, so this is benign; do not add a spinner in this ticket, but
  do not make the second tap crash on cleared fields either.
- **Cross-subsystem:** `applySeed` also feeds the durable **bootstrap-peer**
  store and calls `refreshMembershipGate`. Anchoring a new owner key flips
  already-synced rows into the authorized set — so a successful pin can change
  membership state without any new row arriving. Nothing to implement; do not be
  surprised by strand/membership state moving after a pin.
- **Bundle graph:** `pinnedKeyTrustPolicy` is a new import into the NS bundle
  from `@serfab/cadre-core`. It is a pure function already exported from the
  package entry and used by RN, so it must not pull anything Node-only — the
  bundle check is what confirms this.

## Testing

`packages/reference-app-ns` has **no unit-test runner** (only `typecheck`,
`test:bundle`, `test:e2e`). Introducing one is a sibling plan ticket,
`debt-ns-unit-test-harness`; it is *not* a prereq of this ticket and this ticket
must not wait on it.

Agent-runnable gates for this pass — stream both, never silently redirect:

```
yarn workspace @serfab/reference-app-ns typecheck 2>&1 | tee /tmp/ns-typecheck.log
yarn workspace @serfab/reference-app-ns test:bundle 2>&1 | tee /tmp/ns-bundle.log
yarn eslint <each touched .ts file>
```

`test:bundle` must report **0 errors and 0 warnings** — `scripts/bundle-check.js`
treats any warning as fatal.

If `debt-ns-unit-test-harness` has already landed when this is picked up, write
these tests now; otherwise list them in the review handoff so that ticket picks
them up. Against a fake `CadreNode`:

- `ownerKeysFromInvite` on an invite with two keys returns both, in order.
- `ownerKeysFromInvite` on an invite without `ownerKeys` returns `[]`.
- `ownerKeysFromInvite` on garbage text throws a message containing
  "enrollment invite" (not a bare `SyntaxError`).
- `applySeed(encoded, keys)` calls `trustOwnerKeys` **before** `applySeed` — assert
  call order, not just that both happened.
- `applySeed(encoded)` with no keys calls neither `trustOwnerKeys` nor passes a
  `trustPolicy`.
- `applySeed(encoded, [])` behaves as the no-keys case (empty array is not a pin).
- A rejected `applySeed` result surfaces `result.error` as the thrown message.

Device verification (out-of-band, not agent-runnable): the two-node drone smoke in
the package README — paste the drone's enrollment invite + seed, expect
"Seed applied / Pinned 1 owner key(s)", then a **second** seed apply with the
invite field blank must also succeed.

## TODO

### Phase 1 — view-model seams

- Import `pinnedKeyTrustPolicy` from `@serfab/cadre-core` in `src/cadre-vm.ts`.
- Add `ownerKeysFromInvite(encodedInvite: string): string[]` with the wrapped
  decode error and the `NOTE:` tripwire comment.
- Widen `applySeed` to `(encoded: string, pinnedOwnerKeys?: string[])`; anchor the
  pins via `trustOwnerKeys(keys, 'invite')` **before** `node.applySeed`, and pass
  `{ trustPolicy: pinnedKeyTrustPolicy(keys) }` when pins exist.
- Comment the ordering constraint and the pin-survives-a-failed-seed decision at
  the call site.

### Phase 2 — Settings UI

- Add the `enrollInviteInput` two-way property to `settings-view-model.ts`.
- Rewrite `onApplySeed` per § 2 (derive pins, clear both fields on success only,
  pin-count-aware modal message, title unchanged).
- Add the hint `Label`, the field `Label`, and the `TextView`
  (`automationText="input-enroll-invite"`) to `settings-page.xml`.
- Add `enrollInviteInput: 'input-enroll-invite'` to `src/test-ids.ts`.

### Phase 3 — e2e + docs

- Add `ENROLL_INVITE: testData.enrollInvite` to `maestroEnv` in
  `scripts/run-e2e.mjs`.
- Update `docs/reference-app-ns.md` (⚠️ paragraph, automationText inventory,
  Maestro env-var list), `docs/architecture.md:202` (NS anchor-writer ⚠️), and
  `packages/reference-app-ns/README.md` (device-smoke step 7).

### Phase 4 — validate

- `typecheck`, `test:bundle` (0 errors / 0 warnings), `eslint` on touched files.
- Write the review handoff: state plainly that no unit test covers the new code
  in this package yet, list the seven test cases above for
  `debt-ns-unit-test-harness`, and note that the Maestro e2e path remains
  device-only and additionally blocked by the gaps in
  `backlog/debt-ns-maestro-flow-parity-gaps`.
