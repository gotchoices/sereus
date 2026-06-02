description: Ported the strand-formation transport off the deprecated `@serfab/strand-proto` onto a native cadre-core protocol service, carrying the real disclosure/token/cadre-addrs end-to-end, disclosing responder identity only after validation, and validating the initiator's result. Reviewed and completed.
files: packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-solicitation.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-solicitation.spec.ts, packages/cadre-core/test/strand-formation-protocol.spec.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, docs/architecture.md, packages/cadre-core/README.md
----

# Native strand-formation transport — completed

The strand-formation transport was ported off the deprecated `@serfab/strand-proto` onto a
native cadre-core protocol service (`strand-formation-protocol.ts`, protocol id
`/sereus/formation/1.0.0`), mirroring `seed-bootstrap.ts` (length-prefixed JSON frames over
libp2p streams). It fixes the four source defects: the disclosure was dropped, the token never
reached identity validation, both parties' cadre addrs were `cadre-*.local` placeholders, and
the initiator's result validation accepted everything.

- **Responder** (`FormationListener`): per inbound stream runs token → disclosure validation →
  provision → result, disclosing its real `partyId` + `cadrePeerAddrs` **only after both
  validations pass**; every rejection (bad token, bad disclosure, over the concurrency cap)
  sends `approved:false` + reason and **no** responder cadre.
- **Initiator** (`dialFormation` / `StrandFormationManager.formStrand`): sends the real token +
  disclosure + initiator cadre, then validates the responder's result. The built-in structural
  `FormationResponseValidator` rejects unapproved / missing-identity / empty-or-placeholder-cadre
  / missing-or-empty-strandId / non-responder-created results; apps can supply a stricter one.

Build, 167 cadre-core unit tests, and 6 strand-formation E2E integration tests all pass.

## Review findings

Adversarial pass over the implement diff (commit `6987a71`), read before the handoff summary.
Scrutinized for disclosure-timing correctness, the validator rejection matrix, stream/frame
lifecycle, DRY, resource cleanup, error handling, type safety, and doc accuracy.

### Verified correct (no action needed)

- **Disclosure timing — all three rejection paths.** `FormationListener.runSession` writes only
  `{ approved:false, reason }` on invalid token and invalid disclosure; `handleStream` does the
  same over the concurrency cap. `getResponderIdentity()` is not even called on those paths, so
  no `partyId`/`cadrePeerAddrs` can leak. **Was untested — now covered (see below).**
- **Validator rejection matrix** (`isValidResponderCreatesResult`) matches the ticket's required
  matrix: unapproved, missing `partyId`, empty/`cadre-*.local` cadre, missing `provisionResult`,
  empty `strandId`, and `createdBy !== 'responder'` all reject. **Was untested — now covered.**
- **`FrameReader` correctness.** Handles chunk coalescing and leftover-frame retention; the
  `DataView` is built with `(buffer, byteOffset, byteLength)`, so length reads are correct even
  after `subarray` advances the view past a consumed frame. `maxLength` guards the declared size.
- **Concurrency-cap check** has no race (the check + `activeSessions++` run synchronously before
  the first `await`), and the counter is restored in `finally`.
- **Stream close ordering** matches the proven `seed-bootstrap` pattern (request/response on one
  live stream; dialer does not half-close before reading); E2E exercises the concurrent path.
- **`strand-proto` fully removed from cadre-core** (no lingering imports; dependency dropped from
  `package.json`; lockfile reconciled; build green).
- **Docs reflect the new reality.** `docs/architecture.md` (formation section, dependency graph,
  deprecation note) and `packages/cadre-core/README.md` (dropped the strand-proto related-package
  line) were read against the changed code and are accurate.

### Found and fixed in this pass (minor)

- **Missing coverage of the ticket's central security guarantee.** The existing tests asserted
  the *positive* disclosure (cadre delivered on success) and initiator-side rejection of bad
  responders, but **nothing asserted that the responder withholds its cadre on a rejection** —
  the headline property of the ticket. Added `packages/cadre-core/test/strand-formation-protocol.spec.ts`
  (11 tests, pure/in-memory mock stream, no libp2p): the three rejection paths each assert no
  `partyId`/`cadrePeerAddrs` and that responder identity is never read; the success path asserts
  identity + `provisionResult` are disclosed only after both validations; and the full
  `isValidResponderCreatesResult` rejection matrix is exercised directly.

### Noted, not actioned (acceptable as-is)

- **`createDefaultFormationResponseValidator` is parallel to, not used by, the default path.**
  The manager's default calls `isValidResponderCreatesResult` directly; the factory (app-facing
  API) re-wraps the same check and adds a `validateDatabaseResult` that is never wired. Mild DRY
  smell with drift potential, but it is intentional public surface — left as-is.
- **`dialFormation` dials only `responderAddrs[0]`** (no fallback to later addrs), unlike
  `seed-bootstrap.dialInvite`. Consistent with `deliverSeed`; acceptable for now. Relatedly, the
  implementer's note stands: a responder with empty `cadrePeerAddrs` (NAT/relay-only) now gets
  rejected by the structural default — confirm control nodes always have dialable multiaddrs.
- **`withTimeout` rejects but does not abort the underlying op**; the stream is still closed in
  the `finally`, so resources are released. Acceptable.
- **Plain `JSON.stringify` at the wire** (not `canonicalJson`) and **`void node.handle(...)`
  registration not awaited** both deliberately match `seed-bootstrap`; nothing is signed at the
  transport layer. Acceptable per the ticket.

### Filed as new ticket (deferred work)

- **`tickets/backlog/formation-initiatorcreates-cover-or-remove.md`** — the `initiatorCreates`
  3-message mode is fully implemented but unreachable through the public API (manager hardcodes
  `responderCreates`) and untested over the wire. Decide whether to add an end-to-end test +
  expose mode selection, or remove the dead surface.

### Orthogonal / tracked elsewhere (not in scope)

- `sAppId` is still `''` into `StrandProvisioner.provisionStrand` — tracked by
  `formationinvite-fix-curve-and-wire-consent` (same two shared files).
- The deprecated `strand-proto` package remains in the monorepo (root `pub` script,
  `docs/strand-proto.md`); only cadre-core's dependency on it was removed, as intended.
