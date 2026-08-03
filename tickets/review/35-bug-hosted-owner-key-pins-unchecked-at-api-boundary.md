----
description: Two hosting services now reject a mistyped trusted key right away, in the reply to the request that supplied it, instead of accepting the request and letting the node they started fail silently at boot.
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/package.json, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/donation/__tests__/donation-service.test.ts, packages/cadre-host/src/donation/__tests__/donation-supervisor.test.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-core/src/ed25519-key.ts, docs/architecture.md, docs/cadre-host.md, docs/STATUS.md, packages/cadre-provider/README.md
difficulty: medium
----

# Review: owner-key pins validated where the caller supplies them

## What "a pinned owner key" is, in one paragraph

A node spawned into someone else's party must be told up front whose signed
join-instructions it may trust. That list is **pinned owner keys** — base64url
Ed25519 public keys, reaching the node as the `CADRE_OWNER_KEYS` environment
variable. Two network services accept that list from a caller and hand it to a node
they spawn on the caller's behalf. Before this change neither checked the strings
were shaped like keys, so a typo was answered "created" and then killed the node at
boot, where the caller could not see it.

## What landed

Both request boundaries now apply the node's own rule — **base64url, decodes to
exactly 32 bytes** — before anything is provisioned. Curve membership stays
unchecked in both places, matching `requireEd25519PublicKeyB64`.

**cadre-provider — `POST /containers`.** `validatePinnedOwnerKeys`
(`src/server/routes.ts`) now checks each entry and returns the trimmed values;
a bad one is `400 INVALID_REQUEST` with a message naming the offending value
(capped at 64 characters, so a tenant cannot turn one junk string into a megabyte
of log line). No container record, no orchestrator call. The function is now
`export`ed so the drift test can drive it directly.

The rule is **restated locally over `uint8arrays`** rather than imported from
`@serfab/cadre-core` — that was the ticket's recorded decision (option B), taken
because cadre-provider declares zero `workspace:` dependencies today and adding one
would (a) drag libp2p + quereus + optimystic into a thin Docker-host service's
install closure and (b) invalidate the note at the top of
`packages/cadre-provider/vitest.config.ts` saying this package needs no stale-build
guard. `uint8arrays@^5.1.0` (already the monorepo's base64url codec, and what
cadre-core itself uses) was added to `package.json`; it is not a workspace package,
so that note stays true and no `test/global-setup.ts` was needed.

**cadre-host — `DonationService.provision`.** Validates `request.ownerKeys` at the
very top, *before* `serializeByGrant`, so a malformed request never waits behind
another provision's lock, never reaches the quota check, and never writes a record.
A `requireEd25519PublicKeyB64` throw is mapped to `DonationError('invalid_request')`,
which `server/error-handler.ts` already renders as 400. The trimmed keys are
threaded forward into `provisionLocked`, so the persisted record and the child's
`CADRE_OWNER_KEYS` carry exactly what was validated. cadre-host already depends on
cadre-core, so there is no duplication on this arm.

`DonationService.respawn` is deliberately untouched — it replays keys off a record
written before this check existed, and validating there would make such a record
permanently un-respawnable.

**Drift containment for the duplicated rule** (the thing most worth a reviewer's
skepticism): a comment at each of the two definitions names the other, and
`create-container-owner-keys.test.ts` now asserts the same accept/reject table as
`packages/cadre-core/test/ed25519-key.spec.ts`. If the two rules diverge, that test
fails rather than the divergence passing silently.

**Deliberate behaviour change.** `POST /containers` with `pinnedOwnerKeys: [""]`
was a 201 (`ContainerService.normalizePinnedOwnerKeys` trimmed it away); it is now a
400. A caller who genuinely wants to trust no seed signer omits the field, which
stays valid and stays a 201. `normalizePinnedOwnerKeys` is unchanged and still
guards direct `ContainerService` callers; only its docstring was updated to say the
route now rejects blanks ahead of it. No new emptiness rule was added anywhere:
`POST /grants` keeps its existing "ownerKeys required, non-empty" check, and
`POST /containers` still accepts both an absent field and an empty array.

## How to exercise it

```bash
# cadre-provider: rejected at the boundary, nothing provisioned
curl -X POST $URL/api/v1/containers -H 'Authorization: Bearer ...' \
  -d '{"partyId":"p","bootstrapNodes":["/ip4/127.0.0.1/tcp/4001"],
       "pinnedOwnerKeys":["this-is-not-a-key"]}'
# → 400 {"ok":false,"error":{"code":"INVALID_REQUEST",
#        "message":"pinnedOwnerKeys entries must be base64url-encoded Ed25519 public
#                   keys (could not decode \"this-is-not-a-key\" as base64url)"}}

# cadre-host: same, and no grant quota slot consumed
curl -X POST $HOST/grants -H "Authorization: Bearer $GRANT" \
  -d '{"partyId":"p","bootstrapNodes":["/ip4/.../p2p/12D3Koo..."],
       "ownerKeys":["this-is-not-a-key"]}'
# → 400 {"ok":false,"error":{"code":"invalid_request", ...}}
```

A valid key for hand-testing: `node -e "console.log(Buffer.alloc(32,7).toString('base64url'))"`.

The observed decoder table the tests encode:

| value | result |
| --- | --- |
| `'A'.repeat(43)` | 32 bytes — accepted |
| `'A'.repeat(43) + '=='` | accepted (padding tolerated, and returned as given) |
| `'k'.repeat(44)` | 33 bytes — rejected on length |
| `'owner-key-1'`, `'key-1'`, `'this-is-not-a-key'` | rejected, "could not decode" |
| `'not base64!!'`, `'abc$def'`, `'has+slash/and=pad'` | rejected, "could not decode" |
| `''`, `'   '`, `'\t\n'` | rejected, blank-value message |

## Tests added

`packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts`
— placeholder pins (`'owner-key-1'`) replaced with a local `ownerKey(fill)` helper
building real 32-byte values; new route cases for a malformed key (400, bad value
named in the message), a blank entry (400), and "no container provisioned" across
malformed / blank / wrong-length. Second suite `validatePinnedOwnerKeys (the
provider copy of the cadre-core rule)` drives the validator directly over the whole
table above, including the 5000-character echo cap.

`packages/cadre-host/src/donation/__tests__/donation-service.test.ts` — fixtures now
use a real `OWNER_KEY` constant; new cases assert a malformed entry rejects with
code `invalid_request` and the message names the bad key, with `orch.createCalls`
empty, `store.list()` empty and `store.liveNodeCount(token)` at 0 (the "no quota slot
burned" point); a blank entry rejects the same way; and a padded/whitespace-wrapped
key is threaded onto both the record and the child **trimmed**.

`packages/cadre-host/src/server/__tests__/grants-route.test.ts` — new malformed-key
case beside the existing empty-`ownerKeys` one.

`donation-supervisor.test.ts` fixtures updated to real keys (the `['k']` rows at
what were lines 281/301 were below the boundary and did not have to change; they
were updated anyway so no reader mistakes `['k']` for a valid pin).

## Verification run

| command | result |
| --- | --- |
| `yarn workspace @serfab/cadre-provider typecheck` | clean |
| `yarn workspace @serfab/cadre-provider test` | 20 files / 148 tests pass |
| `yarn workspace @serfab/cadre-host typecheck` | clean |
| `yarn workspace @serfab/cadre-host test` | 65 files / 588 pass, 4 skipped |
| `yarn lint` | clean |
| `yarn workspace @serfab/cadre-core test` | 89/91 files pass; **5 failures, all pre-existing** |

The cadre-core failures are `control-revocation-reissue.spec.ts` (4) and
`control-revocation-replay.spec.ts` (1) — already listed in
`tickets/.pre-existing-known.md` against the blocked slug
`10-revocation-reissue-same-pk-update-unique-collision`, same files and same count.
Not re-reported, and `.pre-existing-error.md` was deliberately not written.

## Known gaps — please treat the above as a floor

- **No integration coverage of the new 400s.** Both cross-package scenarios
  (`cadre-host-node-donation`, `provider-seed-accepted`) already derive real keys, so
  they exercise the happy path and needed no change — but neither drives a rejection.
  The rejection paths are covered only at the unit/route level.
- **The duplicated rule is only as good as its alarm.** The drift test compares
  behaviour, not text: if someone changes cadre-core's rule in a way the table does
  not distinguish, nothing catches it. Worth a reviewer's eye on whether the table is
  discriminating enough.
- **Error-message wording diverges between the two arms** by design (the provider says
  `pinnedOwnerKeys entries must be…`, cadre-host says `A donation owner key (ownerKeys)
  must be…`). Each names its own field, which seemed more useful to a caller than
  identical strings, but it is a judgement call.
- **The provider's decoder `catch` logs via `debug` and returns a string**, so the
  underlying decoder error is not carried as a `cause` the way cadre-core does — the
  HTTP envelope has nowhere to put one. Visible with `DEBUG=cadre:provider:routes`.
- **`yarn workspace @serfab/cadre-provider build` was run** to satisfy cadre-host's
  stale-build guard; no build artifacts are in the diff.
- **Sibling-repo noise during validation.** `../quereus` has uncommitted join-planner
  work in flight (`rule-join-physical-selection.ts`), which repeatedly tripped the
  stale-build guard mid-run; a `yarn workspace @quereus/quereus clean && … build`
  there was needed once, exactly as `test-harness/build-freshness.ts` documents. This
  is unrelated to the diff but explains why suites had to be re-run. A reviewer
  re-running the cadre-host or cadre-core suites may hit it again.

## Docs updated

- `packages/cadre-provider/README.md` — the "Seed trust: pin the tenant's owner key
  at create time" section previously stated outright that encoding is *not* validated
  and that a typo yields a 201; rewritten to state the new 400 and what is still not
  checked.
- `docs/cadre-host.md` — validation paragraph added under the donation flow's
  owner-key-pinning rule, including the respawn exemption.
- `docs/architecture.md` — the trusted-owner-anchor entry claimed cadre-provider's
  create route "still forwards unchecked strings"; corrected, with the duplication
  decision recorded. The "Delivery and trust are separate gates" paragraph gained a
  sentence.
- `docs/STATUS.md` — the enrollment/pin shape-check entry extended with the two
  hosted boundaries. No new doc created.

## For the reviewer

Points where an adversarial read is most likely to pay off:

- Whether restating the rule (rather than taking the `@serfab/cadre-core` dependency)
  was the right call — the tradeoff is written up on `validateOwnerKey` in
  `routes.ts` and in `docs/architecture.md`; if you disagree, that is a decision to
  reopen, not a defect to patch.
- Whether the `[""]` → 400 change can break a real caller. The argument is that
  trusting nobody is spelled by omitting the field, which is still a 201 and is
  asserted as such. No caller in this repo sends `[""]`.
- Whether validating *before* `serializeByGrant` in `provision` can reorder anything
  observable. The validation is synchronous and touches no shared state, so it should
  not — but it does move work outside the per-grant lock.
- `respawn`'s exemption: currently justified by "the pins are already inside the trust
  boundary". If a reviewer thinks a record can carry pins that never passed the new
  check *and* that this matters, that is a real finding.
