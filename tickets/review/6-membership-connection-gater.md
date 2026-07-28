----
description: Outsiders are now refused at the network door of the control network — a device we do not recognize as authorized cannot even open a connection to talk to us — while brand-new devices joining through an invitation or enrollment still get through. Review the door policy and its carve-outs.
prereq: membership-authorized-predicate-and-gates
files:
  - packages/cadre-core/src/membership-connection-gater.ts (NEW — gater + stranger allowlist, the one documented place)
  - packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection, openEnrollmentWindow, getBootstrapPeerIds, createControlNode wiring, createInvite window hook, new fields)
  - packages/cadre-core/src/types.ts (network.connectionGater doc), src/index.ts (exports)
  - packages/cadre-core/test/membership-connection-gater.spec.ts (NEW — 14 tests: composition, fail-open, decision matrix)
  - packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts (NEW — wire-level deny/admit/window)
  - tickets/blocked/control-repo-protocol-stream-authz-optimystic.md (NEW — the upstream seam this ticket could not land)
  - docs/architecture.md (seed-validation section: new connection-gate bullet), docs/STATUS.md (step-6 landed update)
----

# Implemented: control-network membership connection gater (chain step 6)

Defense-in-depth layer the user asked for ("shouldn't even be in the
conversation"). The primary fixes remain steps 4–5 (read-time voucher predicate,
anchored seed trust); this adds connection-level refusal of positively-known
outsiders, with enrollment carve-outs.

## What shipped

**The gater** (`membership-connection-gater.ts`): `createMembershipConnectionGater(policy, base?)`
composes onto any caller-supplied `network.connectionGater` — all base hooks
preserved; on `denyInboundEncryptedConnection` (earliest checkpoint with an
authenticated PeerId) a deny from either the base or the membership policy
denies. Policy errors ADMIT (fail-open by design — this layer only refuses on a
positive determination; the per-stream gates are the fail-closed layer). The
module header is the single documented **stranger allowlist**: `/sereus/seed/1.0.0`
and `/sereus/formation/1.0.0`, each with its own in-protocol trust check.

**The policy** (`CadreNode.admitInboundControlConnection`) admits when ANY:
node not fully up; trusted-owner anchor absent/empty (un-enrolled node must
accept its seed); enrollment window open; strand-formation responder registered
(stranger-serving by design); peer is a configured bootstrap/relay node
(peer ids parsed lazily from `controlNetwork.bootstrapNodes`); authorized-member
set empty (cold start — the authorizing rows arrive by replication over these
very connections); or the peer IS an authorized member. Otherwise: deny, logged.

**The enrollment window**: `CadreNode.createInvite` opens it until the invite's
`expiresAt` (or now + `DEFAULT_ENROLLMENT_WINDOW_MS` = 30 min for expiry-less
invites — an expired/negative-expiry invite opens nothing). Public
`openEnrollmentWindow(untilEpochMs)` (extend-only) serves out-of-band flows.
All production invite paths route through `CadreNode.createInvite` (verified:
cadre-cli admin route, cadre-host trust-circle via the owner-node client).

**Wiring**: control node only. Strand cohort nodes keep the raw configured
gater — their peers are legitimately cross-party. Browser default-gater behavior
is preserved (libp2p only fills `denyDialMultiaddr` when the supplied gater
lacks it — verified against the installed libp2p source). Outbound dials are
never gated (resolvePeerAddrs' trust policy already gates what we dial; seed
delivery dials not-yet-members by design).

**What this ticket could NOT land — the pollution-at-source stream gate.** The
Optimystic control-DB protocols (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}`)
expose no per-stream authz seam in `@optimystic/db-p2p` (verified in
`RepoService.handleIncomingStream` and siblings), and wrapping their handlers
would mean re-implementing protocol framing (ruled out by the ticket). Filed as
`blocked/control-repo-protocol-stream-authz-optimystic` (outside-repo
dependency) with the exact seam request and the sereus-side wiring to do once it
lands. Until then the connection gate is the outermost defense for those
protocols. Honest boundary (per ticket): a row can still reach us via a trusted
hub, and during any open-admission state an outsider can still connect — rows
remain disbelieved at read time either way.

## Deny semantics a reviewer should know (found empirically)

Noise negotiates the muxer in the security handshake's early data, so a denied
DIALER's `dial()` may RESOLVE (its upgrade completes first); the receiver's
upgrade then dies at the gate — the receiver never registers the connection,
never creates its muxer (so no protocol can ever be negotiated), and the dialer
sees the connection close moments later. Documented on the gater; the
integration test asserts this real observable (no surviving connection either
side + `dialProtocol` cannot complete), not a naive `dial().rejects`.

## Validation (all run in this session)

- `yarn lint`, `yarn typecheck` clean at root.
- cadre-core unit: **716 passed / 1 skipped** (52 files; +14 new). cadre-cli 94,
  cadre-host 448 / 3 skipped.
- NEW integration scenario (2/2): steady-state outsider denied at the wire +
  authorized member admitted + `createInvite` re-opens for the outsider; an
  un-enrolled node admits a stranger (seed-delivery precondition). Deterministic —
  no cross-node replication used, so immune to the blocked convergence bug.
- Do-not-break suites: `enrollment-e2e` + `deliver-seed-cross-network` (14),
  `push-wake-e2e` scenarios 3+4, `cadre-host-owner-node` + `cadre-host-trust-circle`
  (12), `cadre-host-node-donation` (5), `strand-formation-e2e` phases 1/3/4 (14)
  — all green.
- Pre-existing failures encountered, all already tracked in
  `.pre-existing-known.md` against `control-db-convergence-optimystic-p2p`
  (not re-reported, nothing skipped): push-wake scenarios 1–2, formation
  phase-2 (both).
- One transient infra flake: a single cadre-core full-suite run failed 33 files
  with "Failed to resolve entry for package @quereus/quereus" (vite cold-cache
  race); not reproducible — every file passes individually and the full suite
  passed on immediate re-run with zero changes.

## Known gaps / judgement calls for the reviewer

- **Formation-responder mode suspends stranger denial entirely, forever.**
  `initializeStrandSolicitation` has no teardown short of stop(), and
  `formStrand` (the INITIATOR side) lazily calls it too — so a node that ever
  formed a strand as initiator also becomes stranger-admitting. Narrowing this
  needs an "unexpired open invitations outstanding" query that cadre-core's
  solicitation service cannot answer (invitation tracking lives in the injected
  usage recorder). Judged acceptable for defense-in-depth v1; reviewer may feel
  differently — the fix direction would be an invitation registry in
  `StrandSolicitationService`.
- **Enrollment window is in-memory.** Survives stop()/start() of the same
  instance (deliberate), but a process restart mid-invite closes the door until
  the owner re-mints or the invitee is authorized. Judged acceptable (invites
  are typically redeemed promptly; re-minting is cheap).
- **A legit sibling whose row has not replicated to us yet is transiently
  denied** until the row converges (typically via the owner); either side's next
  outbound reconcile dial re-establishes the link. NOTE at the decision method.
- **Per-inbound-connection control-DB read** (`listAuthorizedMembers`) — NOTE
  tripwire at the decision method: memoize briefly if inbound upgrade latency
  ever shows up.
- Wire-level integration covers deny/admit/window/un-enrolled; the
  bootstrap-peer and formation-responder admits are covered at unit level only.
  No RN/browser runtime run in this session (typecheck + preserved-default
  analysis only).
