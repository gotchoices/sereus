description: The NativeScript phone app can now join an existing group — Settings has a field where you paste the group leader's invitation, which lets the app accept that group's join bundle instead of refusing every invitation and running alone forever.
files: packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/app/app.css, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-ns/scripts/run-e2e.mjs, packages/reference-app-ns/README.md, docs/reference-app-ns.md, docs/architecture.md
---

# NativeScript Settings — pin owner trust from a pasted enrollment invite

## What shipped

Joining an existing cadre means applying a **seed** — a signed bundle of peer
addresses handed over by an existing member. A node accepts a seed only when its
signer's key already sits in the node's **trusted-owner anchor**, a node-local
record that is never replicated (so a stranger cannot write itself into it over
the network).

`reference-app-ns` previously had no way to put anything in that anchor, so every
seed it was handed was rejected and the app could only run solo. Settings' Seed
Bootstrap section now carries an optional **"Paste enrollment invite (for
trust)"** field. Its owner keys are anchored via `trustOwnerKeys(keys, 'invite')`
*before* the seed is applied, and are also handed to `pinnedKeyTrustPolicy` for
that one apply. Because the anchor is durable, a *later* seed from the same owner
is accepted with the invite field left blank.

| File | Change |
|---|---|
| `src/cadre-vm.ts` | `ownerKeysFromInvite(encoded): string[]`; `applySeed(encoded, pinnedOwnerKeys?)` |
| `app/settings/settings-view-model.ts` | `enrollInviteInput` two-way property; `onApplySeed` rewritten |
| `app/settings/settings-page.xml` | hint `Label` + field `Label` + `TextView automationText="input-enroll-invite"` |
| `app/app.css` | `.hint` class (muted copy under a field) |
| `src/test-ids.ts` | `enrollInviteInput: 'input-enroll-invite'` |
| `scripts/run-e2e.mjs` | `ENROLL_INVITE: testData.enrollInvite` in the Maestro env |
| `docs/reference-app-ns.md`, `docs/architecture.md`, `packages/reference-app-ns/README.md` | anchor-writer paragraphs, automationText inventory, Maestro env list, device-smoke step 7 |

Load-bearing and not to be "tidied": `trustOwnerKeys` runs **before**
`applySeed`, so the anchor already holds the keys when seed trust consults it.
Commented at the call site.

## Review findings

### Gates

| Gate | Result |
|---|---|
| `yarn workspace @serfab/reference-app-ns typecheck` | exit 0 (re-run after review edits) |
| `yarn workspace @serfab/reference-app-ns test:bundle` | `0 errors, 0 warnings` |
| `yarn eslint` on the three changed TS files | exit 0 (re-run after review edits) |

**No unit tests were run, because the package has none to run.** Its
`package.json` scripts are `typecheck`, `test:bundle`, `test:bundle:native`,
`test:e2e` — no unit runner exists in this workspace at all. `test:e2e` needs an
emulator, a built APK, `adb`, and the Maestro CLI, so it is not agent-runnable.
No pre-existing failures were encountered (nothing that could fail was run
beyond the three gates above), so `tickets/.pre-existing-error.md` was not
written.

### Checked and correct

- **Parity with `reference-app-rn`.** `cadre-vm.ts:254-276` matches
  `reference-app-rn/src/use-cadre.ts:282-309` statement for statement, and
  `onApplySeed` matches `reference-app-rn/app/settings.tsx:59-79`, including the
  message wording. The NS hint text correctly drops RN's trailing sentence about
  the closed-strand "Paste invite" field, which NS does not have.
- **Every behaviour the handoff asked to confirm.** Blank invite → no pin, no
  policy override, modal says so. Invite with absent/empty `ownerKeys` → same.
  Malformed invite → throws in `onApplySeed` before `applySeed` is reached, so
  the anchor is untouched. One bad key among good ones → `trustOwnerKeys`
  validates all-or-nothing (`cadre-node.ts:977-985`) so nothing is anchored.
  Failure keeps both fields; success clears both.
- **The Maestro contract closes end to end.** `_setup.yaml:50-52` types
  `${ENROLL_INVITE}` into `input-enroll-invite`; `run-e2e.mjs` supplies it from
  `testData.enrollInvite`; the fixture writes that field at
  `reference-app-rn/test-fixture/start.mjs:147`; the id matches
  `settings-page.xml:65`. The flow's `assertVisible modal-title "Seed applied"`
  still matches — only the modal *message* changed.
- **Docs match the code.** The automationText inventory
  (`docs/reference-app-ns.md:369`), the Maestro env-var list, the architecture
  paragraph's stale "has no invite-paste field" claim, and README device-smoke
  step 7 were all updated. Grepped for other stale claims: `docs/STATUS.md:961`
  ("`reference-app-ns` … needs no owner genesis") remains true, and the two
  ticket-file mentions of this slug are a legitimate cross-reference and an
  archived record.
- **Foreign-party invites.** Pasting an invite for party B while running party A
  anchors B's keys into A's anchor. Not a new hole and not this ticket's to fix:
  `seed-bootstrap.ts:695-700` already carries a `NOTE:` explaining that
  `seed.partyId` is deliberately unchecked and what would have to change first.

### Fixed in this pass (minor)

- **`docs/reference-app-ns.md:94` overstated the sticky pin.** It said a pin
  sticks "even if the seed that motivated it is rejected", but a seed that fails
  to *decode* throws before `trustOwnerKeys` runs, so that one case anchors
  nothing. Reworded to distinguish rejected-by-policy from failed-to-decode, and
  to note the retry is free because the fields survive a failure. Code left
  as-is: the ordering matches `reference-app-rn`, and the code comment already
  said "then rejected", which is accurate.
- **The parked `NOTE:` at `cadre-vm.ts` was incomplete.** It covered an
  `ownerKeys` that is a number (falsy `.length`, no pin) but not one that is a
  bare string, which has a *truthy* `.length` and so takes the other branch —
  `trustOwnerKeys` then rejects it naming its first character. Broadened the
  note to cover both; the recommended fix is unchanged (shape validation inside
  `CadreNode.decodeInvite`, one site serving both phone apps).

### Filed elsewhere (major)

- **No test covers any of the new code**, and the ticket that would make testing
  possible did not know this code existed. Appended a second arm to
  `plan/33-debt-ns-unit-test-harness` (same root cause — the package has no unit
  runner — so an arm, not a new ticket) listing the seven view-model cases and
  two screen-level cases, and added `src/cadre-vm.ts` to its `files:`. The
  call-*order* assertion is called out explicitly there, since that ordering is
  exactly what a well-meaning cleanup would destroy.
- **The seed section grew two elements and the shared flow never scrolls.**
  Appended an arm to `backlog/debt-ns-maestro-flow-parity-gaps` (already open
  against `_setup.yaml` + the NS screens): the NS settings screen is one long
  scrolling column with no tab bar, so `btn-apply-seed` may now fall below the
  fold on a short emulator, and the flow taps it without scrolling first.
  Unproven either way — device-only.

### Tripwires (recorded, not filed)

- The broadened `NOTE:` at `ownerKeysFromInvite` in
  `packages/reference-app-ns/src/cadre-vm.ts` — malformed `ownerKeys` shapes are
  safe but report poorly; fix belongs in `CadreNode.decodeInvite` if it ever
  confuses a real user.

### Deliberately not raised

- `applySeed` evaluates `pinnedOwnerKeys?.length` twice (once for the policy,
  once for the anchor call). Hoisting it would read marginally better but would
  diverge from `reference-app-rn`'s identical shape; lockstep between the two
  reference apps is worth more here than one saved expression.
- The comment-to-code ratio in `cadre-vm.ts:220-276` is high, but the prose is
  load-bearing rationale (ordering, sticky-pin policy, the malformed-shape note)
  rather than restatement of the code.
- `src/test-ids.ts` gained an entry no NS code reads — the XML hard-codes the
  literal string, since NS XML cannot reference a TS constant. That is the
  pre-existing pattern for every other settings id, and the file's stated job is
  parity with RN.

## Still open after this review

- **Nothing here has run on a device.** Whether Maestro's `id:` matcher resolves
  NS `automationText` at all remains the documented, device-only risk in
  `docs/reference-app-ns.md` § "The one real NS-specific risk: test-id
  resolution"; `input-enroll-invite` inherits it like every other id. The
  `.hint` style has likewise never been seen rendered.
- **The two-node drone smoke is the real acceptance test**
  (`packages/reference-app-ns/README.md` § Device smoke, step 7): paste invite +
  seed → *Seed applied / Pinned 1 owner key(s)*; then a **second** Apply Seed
  with the invite field blank must also succeed, proving the pin reached the
  durable anchor rather than only the per-call trust policy.
- **A pin survives a relaunch only if the user retypes the same party id** —
  both node-local records are party-scoped and the app does not persist the party
  id. Tracked in `backlog/feat-rn-persist-node-start-options` (which carries an
  NS arm).
