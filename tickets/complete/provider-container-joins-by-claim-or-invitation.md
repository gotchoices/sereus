description: A rented node joins the user's cadre the same two ways a home-hosted node does: the app claims it with a one-time code, or the node redeems an invitation at a member that is already online. The hosting service never handles owner keys or seeds for these containers.
prereq: provider-drone-reachable-by-phone, cadre-invitations-redeemable-by-any-member
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/create-request-validation.ts, packages/cadre-provider/src/server/invitation-validation.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-join.ts, packages/cadre-provider/src/service/container-env.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/service/node-code.ts, packages/cadre-provider/src/service/multiaddr-destination.ts, packages/cadre-provider/src/service/orchestrator.ts, packages/cadre-provider/src/service/billing-service.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/index.ts, packages/cadre-provider/README.md, packages/integration-tests/src/harness/provider-process-orchestrator.ts, docs/architecture.md
difficulty: hard
----

# A provider container joins by claim or by invitation (complete)

First of the `provider-client-and-sign-up` chain. `POST /containers` takes `join: { kind: 'claim' }` or `join: { kind: 'invitation', invitation }`; a claim container starts with a provider-minted claim secret and the placeholder party `unclaimed`, and `GET /containers/:id/code` hands its owner the node code the phone claims it with; an invitation container starts with the bundle and redeems it itself. Every `/status` read the provider makes goes through `ContainerService.readStatus`, which folds the join state the node reports onto the record (`joinState`, and for a claim the real `partyId` and `ownerKey`). The seed path is untouched until `provider-retires-the-seed-path`. Implemented in `ticket(implement): provider-container-joins-by-claim-or-invitation`; the handoff's description of the request shape, types, service, environment, route and docs stands, with the review changes below.

Nothing here has run against a real node yet. `provider-join-scenarios-phone-shaped-requester` is the wire proof; the `/status` fields the fold reads were taken from cadre-cli's `health.ts` by reading and match it.

## Review findings

**Checked.** The implement diff file by file, with fresh eyes, before the handoff. The request validator against the spec (field exclusions, where the party comes from, the public-host rule); the invitation shape rule against cadre-core's `isWellFormedCadreInvitation` and the three documented differences; the node-code encoder and address rule against cadre-core's `encodeNodeClaimPayload`, `canonicalJson` and `selectNodeClaimAddresses`; the fold against cadre-cli's `/status` payload (`health.ts`), including the in-process restart window where `claim` is `claimed` but `partyId` is still the placeholder or empty; the claim-conflict rules in cadre-cli's `start.ts`; the Docker entrypoint's handling of an empty `CADRE_BOOTSTRAP_NODES` and the placeholder party; the two stores' `getContainer` semantics; every route for a log line that could carry the secret or the bundle (none does); the downstream tickets' expectations of this API (`nodeCode`, `/code`, `joinState`, `UNCLAIMED_PARTY_ID`); and both docs against the code. Ran `yarn lint`, the provider typecheck, the provider suite (34 files, 288 tests), the provider build, and the integration-tests and cadre-host typechecks. All pass.

**Found and fixed inline (minor).**

- `getContainerStatus` claimed its response carried the folded record, but that was true only because both stores hand out the same object they keep; a store returning copies would have shown the pre-fold record beside a post-fold `health`. The response now re-reads the record after the fold.
- The handoff's gap that a direct `createContainer` caller could pass a real `partyId` beside a claim is closed at the service: a claim record always carries the placeholder, and `provisionContainer` hands the orchestrator the record's party rather than the request's (one new test in `container-owner-keys.test.ts`, beside the existing create-to-orchestrator fixture).
- `buildNodeEnv`'s refusal of pins beside a join said cadre-cli refuses `CADRE_OWNER_KEYS` beside either join. cadre-cli refuses it beside a claim only (`refuseClaimConflicts`); beside an invitation it would start with a trust anchor the owner never chose. The comment and the message now give that reason.
- The type and fold comments justified the record's duplicated `partyId` and `ownerKey` by "the list filter and billing"; neither reads them. The README and `docs/architecture.md` said "a list filtered by party" where the API has no party filter. All four now say a list row names the real cadre without the node's report, and that a client picking containers by party must use `joinState` instead.
- `invitation-validation.ts` re-cast the parsed bundle to pull the party out after the shape check; the shape check now returns the party it validated.
- `container-service.ts` had grown past 1,000 lines (1,039 by `wc -l`). The pure join helpers (`joinFor`, `joinStateFrom`, `sameJoinState`, the `NodeCode` and `NodeCodeRefusal` types) moved to `service/container-join.ts`; `routes.ts` and `index.ts` import them from there. The service is 957 lines after the move.

**Major findings.** None. No class-level invariant is missing: the two credentials are redacted by one function every container response passes through, the one minting site and the one `/status` read site are each a single function, and the validator's exhaustiveness is already enforced by the typed return.

**Tripwires recorded in code.** `container-service.ts` → `nodeCode`: `NOTE` that without a `publicHost` the code is `not-ready` for ever and only a direct caller can reach that; answer a distinct refusal if one does. The implementer's three stand: `reapTtlMsFor` (an unclaimed `running` container is never reaped and is billed until deleted), `joinStateFrom` in `container-join.ts` (a spent invitation leaves the container running and there is no retry route), and the `node-code.ts` header (the encoder mirrors cadre-core's and is kept in step by hand; the test decodes against the sorted-key JSON cadre-core emits).

**Considered and left as is.**

- `Container.ownerKey` and `partyId` duplicate the claimed `joinState`'s two values. The spec asked for both: the record fields are what a list row shows without the node's report, the `joinState` is the node's self-contained report. Not worth a ticket; the type comment says which is which.
- The fold stamps `updatedAt`, which the stuck-record reap reads. A join state changes at most twice per container, so the TTL slips by at most one interval.
- `nodeCode` answers `already-claimed` from the stored state after a live read, so a container claimed on an earlier read still says so while its node is briefly down. Intended: the phone must not be handed a code the node would refuse.
- The invitation validator is stricter than cadre-core on `members` (non-empty, each dialable and naming its peer). A bundle cadre-core's settings-screen decoder accepts can be refused here; the module header says why, and the node would refuse to dial such a member anyway.
- The route test covers two refusals and 404; `ALREADY_CLAIMED` and `CONTAINER_GONE` are pinned at the service and the mapping is one table in `routes.ts`.

**Tests.** None cut: each added test pins a contract (the env variable names cadre-cli reads, the field exclusions and party source of the request, the redaction of both credentials, the fold's restart-window rule, the code's canonical JSON) rather than restating the implementation. One added, for the placeholder-party invariant above.

**Pre-existing failures.** None surfaced.
