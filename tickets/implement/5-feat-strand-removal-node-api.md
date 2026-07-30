description: A party owner still has no way to remove one of the shared networks their party belongs to; add the node-level operation that performs the removal and makes every other node in the party stop running that network.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/control-schema.ts, packages/cadre-core/test/validation-key-enrollment.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/README.md, docs/architecture.md, docs/STATUS.md
difficulty: hard
----

# Party-wide strand removal — node API

## What already exists (do not rebuild)

- **The database writer.** `ControlDatabase.deleteStrand(strandId, ownerKey, signMessage)`
  (`control-database.ts:799`) does the whole guarded delete: reads the row's live `StampId`,
  has the owner sign the distinct `'remove'`-tagged digest over `(Id, StampId)`, and commits
  the delete plus the `Revocation` tombstone in one transaction. Absent row → silent no-op.
  Covered by `control-authorization-binding.spec.ts:627-740` (owner signature, non-owner
  refused, no-op, tombstone, closed strand, re-publish after removal).
- **The owner-signing helpers.** `CadreNode.requireOwnerSigningKey(action)`
  (`cadre-node.ts:3060`) and the module-level `signMessageWith(privateKeyB64)`. Every
  owner-signed node write already goes through them — `publishStrand` (`cadre-node.ts:2918`),
  `publishFormationInvite`, `enrollValidationKey`, `removeValidationKey`
  (`cadre-node.ts:3027`). **`removeValidationKey` is the exact shape to copy.**
- **Propagation.** `StrandWatcher` (`strand-watcher.ts:166-178`) already diffs the `Strand`
  table each poll (default 5 s) and calls `onStrandRemoved` for a row that vanished; that is
  wired to `CadreNode.handleStrandRemoved` (`cadre-node.ts:2541`), which untracks
  hibernation, drops the sApp config, stops the local strand instance and emits
  `strand:stopped`. So once the row is deleted, **every node in the party that is watching
  the table converges on its own** — no new propagation machinery is needed.

What is missing is only the write: nothing anywhere calls `deleteStrand`.

## Decisions already made — implement these, do not re-open

**1. Owner-only; no cross-party agreement.** A `Strand` row is *this party's* record of
participating in a shared network. Deleting it removes our participation only — other parties
in that strand keep their own rows and the strand network carries on. So this is an
owner-signed control-plane write like every other, and needs no sign-off from the other
parties. State this in the doc comment so nobody later mistakes it for "destroy the network".

**2. Two separate methods, not one method with a flag.** Local stop and party-wide removal
are different operations with different blast radii; a boolean that silently upgrades a local
stop into an irreversible party-wide destroy is a footgun. Rename for clarity instead:

- `CadreNode.removeStrand(strandId)` → **`stopStrand(strandId)`** — unchanged behaviour
  (untrack hibernation, drop sApp config, stop the instance, emit `strand:stopped`); joins the
  existing `addStrand` / `hibernateStrand` / `wakeStrand` family. Callers to update:
  `packages/cadre-core/test/cadre-node.spec.ts:145` and `:234`, and
  `packages/cadre-core/README.md:172`. No `src` callers outside `cadre-node.ts` (verified by
  grep). Repo rule is "no backwards compat yet", so no alias.
- **New `CadreNode.unpublishStrand(strandId)`** — the party-wide removal, the exact inverse of
  `publishStrand`.

**3. Where the owner approval comes from: the node's own owner key,** via
`requireOwnerSigningKey` — identical to `removeValidationKey`, `publishStrand` and
`SeedBootstrapService.removePeer`. The operator runs the command against their own owner
node; that *is* the approval. No new approval-prompt mechanism in this pass. A cadre-host UI
that prompts an owner is parked in `backlog/feat-cadre-host-strand-removal-ui`.

**4. Closed strands warn harder.** The confirmation gate lives in the CLI (the sibling ticket
`feat-strand-removal-cli`), not here — but this method's doc comment must state the
consequence, because it is permanent (see *Edge cases* below).

## `unpublishStrand` — shape

```ts
/**
 * Remove this party's `Strand` row from the shared control database — the owner-signed
 * inverse of {@link publishStrand}.
 *
 * Party-wide, unlike {@link stopStrand}, which only stops the strand on THIS node: every
 * cadre node watching the table sees the row vanish on its next poll and stops its own
 * instance. Removes OUR party's participation only — other parties in the strand keep their
 * rows and the strand network continues.
 *
 * Irreversible for a closed strand: the row carries `MemberPrivateKey`, this party's
 * membership secret for that network, and it is stored nowhere else. ...
 *
 * No-op (no throw, no tombstone) when the row is already absent.
 */
async unpublishStrand(strandId: string): Promise<void>
```

Body, in order:

1. `const signingKey = this.requireOwnerSigningKey(\`unpublish strand ${strandId}\`)` —
   also narrows `this.controlDatabase`.
2. `requireNonBlank(strandId, 'strand id')`.
3. `await this.controlDatabase!.deleteStrand(trimmed, signingKey.publicKeyB64, signMessageWith(signingKey.privateKeyB64))`.
4. **Alone warning.** If `this.committedAlone()` (`cadre-node.ts:1948`), log loudly, matching
   the wording style of `noteControlWrite`'s `remove` branch (`cadre-node.ts:1970-1974`): the
   deletion is local-only, other nodes may keep running the strand until re-replication, and
   a physical delete cannot be replayed without a schema tombstone — see
   `tickets/plan/10-control-delete-while-alone-tombstone.md`. Do **not** enqueue it in
   `pendingPeerWrites`; that queue is keyed by peer id and is `CadrePeer`-only. A log line is
   the honest surface here.
5. **Converge locally now** rather than waiting up to a poll interval:
   `await this.strandWatcher?.forcePoll()`, then if `this.strandManager.getInstance(strandId)`
   is still present, `await this.stopStrand(strandId)`. The second half covers the node whose
   `strandFilter` never tracked this strand (`mode:'none'`, or an `sAppId` filter that does not
   match) — the watcher will never fire `onStrandRemoved` for a strand it never knew, so
   without this the local instance keeps running against a row that no longer exists.
   `StrandInstanceManager.stopStrand` is a no-op for an unknown id (`strand-instance-manager.ts:433`),
   so the two paths cannot double-stop into an error.
6. `log(...)` the removal with the owner key, like `removeValidationKey` does.

## Edge cases & interactions

Name each in the tests or in a doc comment; the reviewer will look for them.

- **Already-absent row** — `deleteStrand` is a silent no-op. `unpublishStrand` must not throw,
  must not emit `strand:error`, and must still stop a locally-running instance of that id.
- **Blank / whitespace strand id** — refused before any write (`requireNonBlank`), same as
  `removeValidationKey`.
- **Node not started / no owner signing key** — `requireOwnerSigningKey` throws with the
  two-part message; nothing is written. Pin both, as `validation-key-enrollment.spec.ts:225-237`
  does.
- **Non-owner signer** — already refused at the database layer
  (`control-authorization-binding.spec.ts:717`). The new path must not weaken it; a node whose
  key is not in `OwnerKey` gets the constraint failure and the row survives.
- **Replay of the original add-approval** — the tombstone retires the row's `StampId`, so
  `Strand.NotRevoked` refuses a replayed insert. Already pinned at the DB layer; do not
  re-test, but do not bypass `deleteStrand` either (a hand-rolled `delete` would trip
  `RevocationRecorded`).
- **Owner re-publish after removal works; unsigned consent re-seat never does.** A fresh
  owner-signed `publishStrand` with a new stamp re-seats the id
  (`control-authorization-binding.spec.ts:700`). The *consent* branch of
  `Strand.AuthorizedInsert` (`control-schema.ts:198-207`) permanently forecloses a second
  unsigned seating of an id that was ever consent-formed. Worth one sentence in the doc
  comment: the id is not blacklisted, only its unsigned re-seat is.
- **Closed strand (`Type='c'`) — permanent secret loss.** `MemberPrivateKey` lives only in this
  row (`control-schema.ts:137`). It is what derives the founding `Member`/`Manager` keys
  (`strand-database.ts:45`, `strand-member-key.ts:strandMemberKeyPair`) and what
  `ControlFormationUsageRecorder.resolveStrand` hands to a validated invitee
  (`control-formation-recorder.ts:198-212`). Removing the row destroys it: the party can never
  again admit a member to that closed strand, and a re-published row would carry a *different*
  key that does not match the membership already written into the strand's RBAC layer.
- **Outstanding `FormationInvite` rows bound to the removed strand** (`FI.StrandId = <id>`)
  become unredeemable while the row is absent: `resolveStrand` returns `missing` and the
  formation manager rejects cleanly rather than half-recording. Note it; no new handling.
- **Delete-while-alone** — a removal committed with zero control connections is local-only and
  does not propagate when siblings return. Inherited limitation, documented under
  "Delete-while-alone durability" in `docs/architecture.md` and tracked in
  `tickets/plan/10-control-delete-while-alone-tombstone.md`. **Do not fix it here**, and do not
  let the doc comment or log wording imply durability the layer beneath does not deliver.
- **Convergence lag** — a sibling that has not yet synced keeps running the strand. Same
  caveat `enrollValidationKey`'s doc comment already carries; state it, don't try to close it.
- **`stopStrand` (local) leaves the row intact**, so on the next node restart the row is
  rediscovered and surfaces as `strand:discovered`. That is pre-existing behaviour, now worth
  one line in `stopStrand`'s doc comment since the rename puts the two methods side by side.

## Tests

New spec `packages/cadre-core/test/strand-unpublish.spec.ts`. Copy the `startSelfOwnerNode`
harness from `validation-key-enrollment.spec.ts:43-60` verbatim (fresh libp2p key → node →
`insertOwnerKey(publicKeyB64)`; `profile: 'transaction'`; 60 s timeouts per case).

- `publishStrand` → `queryStrands()` contains it → `unpublishStrand` → `queryStrands()` is
  empty, and the `Revocation` row `(TableName='Strand', StampId=<row's stamp>, RowKey=<id>)`
  exists. (Read the stamp before removal; `revocationRow` helper at
  `validation-key-enrollment.spec.ts:62` is the pattern.)
- `unpublishStrand` on an id that was never published resolves and writes no tombstone.
- Blank / whitespace-only id rejects before any write.
- Stopped node → both `stopStrand` and `unpublishStrand` throw the "must be started" shape.
- Closed strand: publish with a `generateStrandMemberKey()` value, unpublish, assert the row
  and its `MemberPrivateKey` are gone.
- Re-publish after unpublish succeeds with a fresh stamp (guards the "id is not blacklisted"
  claim in the doc comment).
- Local convergence: with a strand instance running, `unpublishStrand` leaves
  `node.getStrands()` without it by the time the promise resolves (this pins step 5 — the
  reason the method forces a poll instead of trusting the 5 s timer). If standing a real strand
  instance up in this spec is disproportionate, pin it in `cadre-node.spec.ts` against the
  existing manual-strand fixture (`cadre-node.spec.ts:133-145`) instead, and say so.

Also update the two renamed call sites in `cadre-node.spec.ts` (`:145`, `:234`).

## TODO

- [ ] Rename `CadreNode.removeStrand` → `stopStrand`; update `cadre-node.spec.ts:145,234` and
      `packages/cadre-core/README.md:172`. Add the "row stays; rediscovered on restart" line to
      its doc comment.
- [ ] Add `CadreNode.unpublishStrand` per the shape above, including the alone-log and the
      force-poll + still-running fallback.
- [ ] Write `packages/cadre-core/test/strand-unpublish.spec.ts` covering the cases listed.
- [ ] `packages/cadre-core/README.md` — update the strand API table (`removeStrand` row at
      `:172`) and add `unpublishStrand`.
- [ ] `docs/architecture.md` — in the control-database / `Strand` narrative, state that
      party-wide removal is owner-signed, removes this party's participation only, and that a
      closed strand's `MemberPrivateKey` is destroyed with the row. Cross-reference the
      existing "Delete-while-alone durability" note rather than restating it.
- [ ] `docs/STATUS.md` — the entry claiming nothing calls `deleteStrand` needs correcting;
      record what now calls it and that the operator-facing command lands in the sibling ticket.
- [ ] `yarn build`, `yarn lint`, `yarn dep-check`, and `yarn --cwd packages/cadre-core test`
      (stream with `2>&1 | tee`, never a silent redirect).
