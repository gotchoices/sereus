---
description: Two hosting services now reject a mistyped trusted key right away, in the reply to the request that supplied it, instead of accepting the request and letting the node they started fail silently at boot.
files: packages/cadre-provider/src/server/owner-key-validation.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/server/__tests__/create-container-owner-keys.test.ts, packages/cadre-host/src/donation/donation-service.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/src/server/__tests__/grants-route.test.ts, packages/cadre-core/src/ed25519-key.ts, packages/cadre-core/test/ed25519-key.spec.ts, docs/architecture.md, docs/cadre-host.md, docs/STATUS.md, packages/cadre-provider/README.md
---

# Owner-key pins validated where the caller supplies them

## What shipped

A node spawned into someone else's party is told up front whose signed
join-instructions it may trust: a list of **pinned owner keys** (base64url Ed25519
public keys, reaching the node as `CADRE_OWNER_KEYS`). Two network services take that
list from a caller and hand it to a node they spawn. Neither checked the strings were
shaped like keys, so a typo was answered "created" and then killed the node at boot,
where the caller could not see it.

Both boundaries now apply the node's own rule — base64url, decoding to exactly 32
bytes — before anything is provisioned. Curve membership stays unchecked in both,
matching `requireEd25519PublicKeyB64`.

- **cadre-provider `POST /containers`** — `validatePinnedOwnerKeys` rejects a bad
  entry with `400 INVALID_REQUEST` naming the offending value (echo capped at 64
  characters). No container record, no orchestrator call. The rule is deliberately
  restated over `uint8arrays` rather than imported from `@serfab/cadre-core`, because
  cadre-provider declares no `workspace:` dependencies; the tradeoff is written up at
  the code site.
- **cadre-host `DonationService.provision`** — validates `request.ownerKeys` before
  `serializeByGrant`, so a malformed request never waits behind another provision,
  never reaches the quota check and never writes a record. Mapped to
  `DonationError('invalid_request')` → 400. cadre-host already depends on cadre-core,
  so no duplication on this arm. `respawn` is exempt by design: it replays keys off a
  record written before the check existed.
- **Deliberate behaviour change** — `POST /containers` with `pinnedOwnerKeys: [""]`
  was a 201 and is now a 400. Omitting the field (the way to say "trust no seed
  signer") is still a 201.

Verified by unit + route tests on both arms, and by a table test on each side of the
duplicated rule. Docs updated: `packages/cadre-provider/README.md`,
`docs/cadre-host.md`, `docs/architecture.md`, `docs/STATUS.md`.

## Review findings

Read the implementation diff (`ac3918b`) before the handoff summary. Checked: both
validation sites against cadre-core's rule; every other place `pinnedOwnerKeys` /
`ownerKeys` enters either package; test coverage (happy path, edge, error, the
"nothing provisioned" regression); every doc the change touched plus the ones it
should have; source hygiene; lint and the three affected suites.

**Fixed in this pass (minor):**

- *A non-string owner key reached the caller as an internal JavaScript error.*
  `POST /grants` checked `Array.isArray(body.ownerKeys)` but not the element types,
  so `ownerKeys: [42]` reached `requireEd25519PublicKeyB64`, threw
  `value.trim is not a function`, and — because `validateOwnerKeys` catches
  everything — was rendered back as a 400 whose message describes our internals
  rather than their request. The route now rejects non-string entries with
  `ownerKeys must be an array of strings`, matching what the provider route already
  did. Test added in `grants-route.test.ts`. (cadre-provider had no equivalent gap.)
- *The drift alarm was described as stronger than it is.* Four places (both rule
  docstrings, the provider test header, `docs/architecture.md`, `docs/STATUS.md`)
  said a divergence between the two copies of the rule "fails a test rather than
  passing silently". Neither suite can see the other package, so a change made in
  cadre-core does not fail anything in cadre-provider. What the tests actually give
  is a per-side tripwire: each suite pins its own copy to the same accept/reject
  table, so an edit fails *that* package's tests and lands the editor on the comment
  naming the other copy. Wording corrected everywhere; a matching pointer added to
  `cadre-core/test/ed25519-key.spec.ts`, which previously had none.
- *The key rule lived inside the routing file.* ~100 lines of validation sat at the
  top of `cadre-provider/src/server/routes.ts`, and the route module had to export
  `validatePinnedOwnerKeys` purely so a test could reach it. Extracted to
  `src/server/owner-key-validation.ts` (own debug namespace,
  `cadre:provider:owner-keys`); `routes.ts` imports it and is back to routing.
  References in `ed25519-key.ts`, `container-service.ts` and `docs/architecture.md`
  updated to the new path. No behaviour change — the same 148 provider tests pass.

**Filed as a new ticket (major):**

- `backlog/bug-hosted-create-routes-accept-unusable-bootstrap-addresses` — the same
  two request boundaries check that `bootstrapNodes` is a non-empty array but not
  that the entries are strings, nor that they are addresses anything can dial; a
  mistyped address is accepted and forwarded into the child exactly the way a
  mistyped owner key used to be. Also covers cadre-provider's `partyId`, which is
  tested for truthiness where cadre-host tests its type. Filed rather than fixed
  here because a multiaddr check needs a parser, and whether cadre-provider takes
  that dependency is the same judgement call this ticket already made once for
  cadre-core. Marked `repro: static` — read from the code, not observed; the ticket
  names what would confirm it.

**Recorded as a tripwire, not a ticket:**

- `validateOwnerKeys` in `donation-service.ts` wraps its whole `map` in one `try`
  and reports every throw as the caller's fault. That is true today, and the route
  in front of it now guarantees the entries are strings — but if
  `requireEd25519PublicKeyB64` ever grows a failure of its own (a lookup, a curve
  check), a host-side fault would be answered 400. `NOTE:` comment at the site.

**Checked and found nothing to fix:**

- *Ordering.* Moving validation ahead of `serializeByGrant` reorders nothing
  observable: it is synchronous, touches no shared state, and every other caller
  path is unchanged. Confirmed `provision` has exactly one caller.
- *The `respawn` exemption.* A record can only carry unvalidated pins if it was
  written before this change or by a direct `DonationService` caller; respawning it
  fails at child boot exactly as it did before, and validating would make such a
  record permanently un-respawnable. Status quo, documented at the site.
- *The `[""]` → 400 behaviour change.* No caller in this repo sends it; both
  integration scenarios that exercise these paths (`cadre-host-node-donation`,
  `provider-seed-accepted`) derive real keys, and no client outside cadre-host posts
  to `/grants` at all. Confirmed by reading both scenarios and grepping the repo.
- *Docs.* Every claim in the four updated files was checked against the code,
  including the previously-wrong statements they replaced (the README's "encoding is
  not validated" and architecture.md's "still forwards unchecked strings"). Only the
  drift-alarm sentence was inaccurate; fixed above. `docs/reference-app-*.md` mention
  owner keys but only via invites, so they needed no change.
- *Service-level tests still using placeholder keys* (`container-owner-keys.test.ts`,
  `docker-orchestrator-push.test.ts`). Correct as-is: those drive `ContainerService`
  and the orchestrator directly, and the design decision is that the route — not the
  service — is the validating boundary. `normalizePinnedOwnerKeys` remains the guard
  for direct service callers.
- *Source size.* `routes.ts` was 437 lines before the extraction, 338 after
  (`wc -l`); `grants.ts` is 210. `donation-service.ts` is 916 and grew by ~50 here — large, but
  pre-existing and not made structurally worse by this change, so no size ticket.

**Empty categories:** no security finding (the change only tightens what is accepted,
adds no new echo of caller data beyond the existing capped one, and the cap is
tested at 5000 characters); no performance finding (validation is a decode of ≤ a
few dozen short strings per request); no resource-cleanup finding (the new code path
allocates nothing and returns before any resource is reserved — which is the point of
where it sits).

## Verification

| command | result |
| --- | --- |
| `yarn lint` | clean |
| `yarn workspace @serfab/cadre-provider typecheck` | clean |
| `yarn workspace @serfab/cadre-provider test` | 20 files / 148 tests pass |
| `yarn workspace @serfab/cadre-host typecheck` | clean |
| `yarn workspace @serfab/cadre-host test` | 65 files / 589 pass, 4 skipped (588 + the new non-string case) |
| `yarn workspace @serfab/cadre-core test` | 89/91 files, 1481 pass, **5 fail — all pre-existing** |

The five cadre-core failures are `control-revocation-reissue.spec.ts` (4) and
`control-revocation-replay.spec.ts` (1), already listed in
`tickets/.pre-existing-known.md` against the blocked slug
`10-revocation-reissue-same-pk-update-unique-collision` — same files, same count, same
`context.OwnerKey isn't a column` assertion. Not re-reported; no
`.pre-existing-error.md` written.

`@serfab/cadre-provider` and `@serfab/cadre-core` were rebuilt (dependents run real
compiled output). The stale-build guard also required a `@quereus/quereus` rebuild in
the sibling `../quereus` workspace, which has unrelated work in flight — expect to
hit that again when re-running the cadre-core or cadre-host suites.

## Known gaps carried forward

- **No integration coverage of the new 400s.** Both cross-package scenarios exercise
  the happy path only. Judged acceptable: both rejection paths are covered through
  the real route stack (fastify `inject`) plus the validator directly, so an
  integration test would re-prove the same code with a slower harness.
- **Error-message wording differs between the two arms** by design — each names its
  own field (`pinnedOwnerKeys entries must be…` vs `A donation owner key (ownerKeys)
  must be…`).
- **The provider's decoder rejection does not carry the underlying error as a
  `cause`** the way cadre-core does; it is logged under `DEBUG=cadre:provider:owner-keys`
  instead, since the HTTP envelope has nowhere to put one.
