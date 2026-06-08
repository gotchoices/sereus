description: The responder-provisions fallback in StrandFormationManager.provisionAsResponder records no FormationUsage row, so single-use/TotalUses is NOT enforced for unbound invites; and a bound invite naming a strand this responder has not converged on throws ungracefully instead of cleanly rejecting.
files: packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/control-formation-recorder.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/strand-formation-consent.spec.ts
----

Surfaced during review of `formstrand-protocol-thread-consent-and-provision`. Two distinct
gaps on the responder formation path, both **pre-existing** (the manager never recorded usage
before that ticket) but now conspicuous because the bound provision-then-record path records
consent correctly while these do not.

## 1. Single-use not enforced on the responder-provisions fallback (security)

`StrandFormationManager.provisionAsResponder` has two paths:

- **bound (provision-then-record)** — `recorder.resolveStrand(token)` returns non-null → it
  calls `recorder.recordUsage(...)`, writing exactly one `FormationUsage` row. Single-use is
  enforced because the next session's `validateToken → isTokenUsed` sees the row.
- **fallback (unbound invite, or recorder without `resolveStrand`)** — it provisions a NEW
  strand via `strandProvisioner` (or returns a placeholder) and **never calls `recordUsage`**.

Because the fallback writes no `FormationUsage`, `ControlFormationUsageRecorder.isTokenUsed`
(`countFormationUsage(token) >= TotalUses`) always sees 0, so a `TotalUses: 1` **unbound**
invite can be redeemed repeatedly — each redemption minting another strand. The DB-level
`FormationUsage.Authorized` (`FI.TotalUses >= new.UseNumber`) backstop never fires because no
usage row is ever inserted on this path.

Expected behavior: the fallback must record consent for the strand it provisions (the old
`ControlDatabase.redeemInvitation` did exactly the atomic strand+usage insert; the recorder was
intentionally switched to record-only for the bound path). Decide whether the unbound/legacy
responder-provisions path should (a) record usage against the freshly provisioned strand
(restore `redeemInvitation`-style atomic create+record for that path), or (b) be removed
entirely in favor of provision-then-record (see also backlog
`formation-initiatorcreates-cover-or-remove`). Either way, single-use must hold on every
redemption path, and a regression test should drive a `TotalUses: 1` invite through the
fallback twice and assert the second is rejected.

## 2. Bound invite naming an unconverged/missing strand throws ungracefully (robustness)

`ControlFormationUsageRecorder.resolveStrand` returns `{ strandId, memberPrivateKey: null }`
whenever the invite carries a `StrandId`, even if `queryStrand` found no row (it only checks
`invite.strandId` truthiness, not strand existence). The manager then calls `recordUsage`,
whose `FormationUsage.StrandExists` deferred CHECK fails at commit → the insert throws →
`runSession` propagates → `handleStream` catches/logs and closes the stream **without writing a
result frame**. The initiator gets a read error/timeout rather than a clean `approved: false`
rejection.

This is reachable in the distributed control network: a responder node that has not yet
converged on the host strand row (the schema/`countRows` notes call out per-node convergence)
will hit exactly this. Decide the intended semantics (clean rejection? retry/await
convergence?) and make `resolveStrand` / the manager handle a bound-but-absent strand
deliberately instead of via an uncaught throw. Add a test for "bound invite, strand row absent
on the responder" once the behavior is decided.

Both are responder/networked-path concerns; the real two-node leg lives in the
(not-agent-runnable) `@serfab/integration-tests`, so add coverage there too.
