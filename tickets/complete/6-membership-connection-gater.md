----
description: Cadre nodes now refuse network connections from devices they can positively tell are not authorized members, while still letting brand-new devices in during invitation and enrollment. Reviewed, hardened, and one significant hole in the exemption logic handed on as its own ticket.
files:
  - packages/cadre-core/src/membership-connection-gater.ts (gater + stranger allowlist + bounded admission decision)
  - packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection, openEnrollmentWindow, getBootstrapPeerIds, createControlNode wiring, createInvite window hook)
  - packages/cadre-core/src/types.ts (network.connectionGater doc), src/index.ts (exports)
  - packages/cadre-core/test/membership-connection-gater.spec.ts (19 tests)
  - packages/integration-tests/src/scenarios/membership-connection-gater.integration.ts (wire-level deny/admit/window)
  - tickets/plan/7-narrow-formation-stranger-carveout.md (NEW — review finding)
  - tickets/blocked/control-repo-protocol-stream-authz-optimystic.md (upstream seam, filed at implement)
  - docs/architecture.md, docs/STATUS.md
----

# Complete: control-network membership connection gater (chain step 6)

Layer 2 of the membership hardening chain. Steps 4–5 remain the primary fixes
(read-time voucher predicate, anchored seed trust); this adds connection-level
refusal of positively-known outsiders on the control network, with carve-outs for
the legitimate stranger paths.

## What shipped

**The gater** (`membership-connection-gater.ts`): `createMembershipConnectionGater(policy, base?, decisionTimeoutMs?)`
composes onto any caller-supplied `network.connectionGater`. All base hooks are
preserved; on `denyInboundEncryptedConnection` (the earliest checkpoint with an
authenticated PeerId, before protocol negotiation) a deny from either the base
gater or the membership policy denies. Errors — and now slow decisions — ADMIT
(fail-open by design; the per-stream gates are the fail-closed layer). The module
header is the single documented **stranger allowlist**: `/sereus/seed/1.0.0` and
`/sereus/formation/1.0.0`, each with its own in-protocol trust check.

**The policy** (`CadreNode.admitInboundControlConnection`) admits when ANY: node
not fully up; trusted-owner anchor absent/empty; enrollment window open;
strand-formation responder registered; peer is a configured bootstrap/relay node;
authorized-member set empty (cold start — the authorizing rows arrive by
replication over these very connections); or the peer IS an authorized member.
Otherwise deny, logged.

**The enrollment window**: `CadreNode.createInvite` opens it until the invite's
`expiresAt` (or now + `DEFAULT_ENROLLMENT_WINDOW_MS` = 30 min for expiry-less
invites; an already-expired invite opens nothing). Public
`openEnrollmentWindow(untilEpochMs)` is extend-only and serves out-of-band flows.

**Wiring**: control node only — strand cohort nodes keep the raw configured gater
(their peers are legitimately cross-party). Outbound dials are never gated.

**Not landed, blocked upstream**: a per-stream authorization check inside the
Optimystic control-DB protocols (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}`).
`@optimystic/db-p2p` exposes no inbound-stream authz seam and wrapping the
handlers would mean re-implementing protocol framing. Filed at implement time as
`blocked/control-repo-protocol-stream-authz-optimystic`; that ticket was
re-read during review and is accurate and actionable as written.

## Review findings

**Checked:** the full implement diff read before the handoff summary; the gater's
composition and fail-open contract against libp2p's actual `upgrader.js` and
`config/connection-gater{,.browser}.js` in `node_modules`; every carve-out in
`admitInboundControlConnection` against its real dependency
(`listAuthorizedMembers`, `hasAnchoredVoucher`, `TrustedOwnerStore`,
`strandSolicitationService` lifecycle, `config.controlNetwork.bootstrapNodes`);
every caller of `createInvite`, `initializeStrandSolicitation`,
`createOpenInvitation`, `formStrand` and `connectionGater` across all packages;
`CadreInvite.expiresAt` units; whether `bootstrapNodes` is ever mutated at
runtime (it is not, so the lazy `bootstrapPeerIds` cache is sound); AutoNAT
dial-back reachability under the new gate (dial-backs come from already-connected
peers, i.e. members or bootstrap infra — not broken); the unit + integration
tests; and `docs/architecture.md` / `docs/STATUS.md` against the code.

**Major — filed as a ticket:**

- *The strand-formation exemption is far wider than intended, and disables the
  gate entirely on the phone reference app.* The exemption condition is "a
  responder object exists", which is process-lifetime (only `stop()` clears it);
  `formStrand` opens it on the **initiator** side that never needs inbound
  strangers; and `reference-app-rn`'s `initializeFormationResponder` is called
  unconditionally during node bring-up, so that client's gate denies nobody
  (`reference-app-web` opens it permanently after the first formation action).
  Nothing is unsafe — steps 4–5 still hold — but the defense-in-depth layer buys
  nothing on the primary client. The implementer flagged the shape of this and
  invited disagreement; the caller audit is what makes it major rather than a
  judgement call. Narrowing needs design (outstanding-invitation state does not
  exist in `StrandSolicitationService` today; it lives behind the injected
  `FormationUsageRecorder` seam), so it is filed as
  `plan/narrow-formation-stranger-carveout` and called out at the decision site,
  in the gater's module doc, in `docs/architecture.md` and in `docs/STATUS.md`.

**Minor — fixed in this pass:**

- *Unbounded admission decision inside libp2p's inbound upgrade.* libp2p awaits
  `denyInboundEncryptedConnection` **without** racing its inbound-upgrade timeout
  signal (unlike the pre-encryption `denyInboundConnection` hook, which is wrapped
  in `raceSignal`). The real policy reads the control DB, and Optimystic pulls on
  read — so a decision that never settles wedges that inbound upgrade forever and
  keeps the connection-manager's inbound slot taken (`afterUpgradeInbound()` runs
  in a `finally` that is never reached). That is a fail-**closed** hang, the
  opposite of the documented contract. Fixed: `ADMISSION_DECISION_TIMEOUT_MS`
  (2s) bounds the decision and admits on expiry, timer always cleared.
- *Test gaps.* Added: a peer whose `CadrePeer` row is addressable but **unvouched**
  is denied while a real member is admitted (the step-4 "having a row is not
  membership" distinction at the connection layer); a peer vouched by a key that
  is not in this node's anchor is denied; the `createInvite` → enrollment-window
  wiring (window set to the invite's own expiry, the 30-minute fallback for an
  expiry-less invite, nothing opened for an already-expired invite, and an open
  window never shrunk); and fail-open on a decision that outstays its deadline.
  Also replaced two tautological assertions — `STRANGER_OPEN_PROTOCOLS` now locks
  the literal wire ids so widening or renaming the allowlist cannot pass
  silently, and `DEFAULT_ENROLLMENT_WINDOW_MS > 0` became a real assertion about
  the window `createInvite` opens. 14 → 19 unit tests.
- *Docs.* `docs/architecture.md` and `docs/STATUS.md` described the formation
  exemption as merely "cross-party by design"; both now state that it is
  process-lifetime and inert on `reference-app-rn`, and STATUS records the
  bounded-decision fix.

**Tripwires — recorded, not ticketed:**

- The enrollment window is in-memory, so a **process** restart mid-invite closes
  the door until the owner re-mints. `NOTE:` on the `enrollmentWindowUntil` field
  with the fix direction (persist it, or derive it from the issued-invite records
  `SeedBootstrapService` already keeps). Fine while invites are short-lived.
- `base` is spread into the composed gater, so a gater passed as a **class
  instance** would lose its prototype methods. Every caller in this repo and
  libp2p's own default supply plain objects; `NOTE:` on
  `createMembershipConnectionGater` says to delegate per-hook if that changes.
- The implementer's two existing tripwires were re-read and left as they are: the
  per-inbound-connection `listAuthorizedMembers` read (memoize if inbound upgrade
  latency shows up — now also bounded by the deadline above), and the transient
  deny of a sibling whose membership row has not replicated yet (self-heals on
  either side's next outbound reconcile dial).

**Checked and found sound (no action):**

- Browser/RN default-gater behavior is genuinely preserved. Verified in
  `node_modules/libp2p/dist/src/config/connection-gater.browser.js`: libp2p fills
  `denyDialMultiaddr` only when the supplied gater lacks it, and the composed
  gater lacks it exactly when the caller supplied none — same before and after.
  `reference-app-web`'s permissive `denyDialMultiaddr` survives the composition.
- `@optimystic/db-p2p`'s `createLibp2pNode` passes `connectionGater` straight
  through and defines no default of its own, so making the option unconditional
  overrides nothing.
- `CadreInvite.expiresAt` is epoch ms (`seed-bootstrap.ts` mints `now + expiresIn`),
  matching the window arithmetic.
- `getBootstrapPeerIds` takes the **last** `/p2p/` component, which is the dial
  target on a circuit address — correct, since relayed inbound connections carry
  the target's PeerId and the relay itself is only ever dialed outbound. The
  lazy cache is safe because nothing mutates `controlNetwork.bootstrapNodes`.
- All production invite paths do route through `CadreNode.createInvite`
  (cadre-cli `admin-server`, cadre-host trust-circle via `owner-node-client`);
  cadre-provider has no invite path.
- `STRANGER_OPEN_PROTOCOLS` has no production consumer — it is a deliberate
  documentation anchor with a test that locks its contents. Left as is.

**Empty categories:** no security-regression, resource-leak or type-safety
findings beyond the wedged-upgrade issue above (which was both); no dead code or
duplication to remove; no source file over-size concerns (the new module is 150
lines, all of it interface + rationale).

## Validation (this review pass)

- `yarn lint` — exit 0. `yarn typecheck` — exit 0.
- cadre-core full suite: **721 passed / 1 skipped** (52 files) — was 716 + the 5
  new tests.
- Gater unit spec: 19/19.
- Gater integration scenario: 2/2 at the wire level.
- Do-not-break: `enrollment-e2e` + `deliver-seed-cross-network` — 14/14.
- No pre-existing failures encountered in this pass; nothing skipped or loosened.
  The convergence failures tracked under
  `control-db-convergence-optimystic-p2p` in `.pre-existing-known.md` were not
  re-triggered (none of the suites run here depend on cross-node replication).
