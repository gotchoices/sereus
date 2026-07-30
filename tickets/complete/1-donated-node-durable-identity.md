---
description: Machines lent to another person's group now keep one network identity in their own folder instead of inventing a new one at every start, so the group keeps recognising them and they keep the addresses they need to dial back in.
files: packages/cadre-host/src/orchestrator/node-identity.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/orchestrator/__tests__/node-identity.test.ts, packages/cadre-host/src/__tests__/orchestrator-node-identity.test.ts, packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, docs/architecture.md, docs/cadre-host.md, docs/STATUS.md
---

# Donated nodes get a durable identity key in their workdir

## What shipped

Every node `HostProcessOrchestrator.createContainer` spawns for a requester (the node-donation
path) now gets its own libp2p identity key inside its own working directory, written on the
first spawn and reused on every later one.

- **`packages/cadre-host/src/orchestrator/node-identity.ts`** — `nodeIdentityPath(workdir)` and
  `ensureNodeIdentity(workdir)`. The latter loads `<workdir>/identity.key` when it exists and
  generates it when it does not, both delegating to `installer/identity.ts` (protobuf bytes,
  parent `mkdirSync`, `chmod 0600` on POSIX). No key handling is re-implemented.
- **`createContainer`** ensures the identity, then allocates ports, then spawns with
  `--identity-protobuf <path>`. That flag routes through `CADRE_IDENTITY_PROTOBUF` →
  `identity.protobufKeyFile`, which is the condition on which `cadre-cli start` opens
  `FileBootstrapPeerStore` and `FileTrustedOwnerStore` — both land beside the key, inside the
  workdir. `removeContainer` deletes the workdir, so identity and both stores die with the loan.
- **`ensureOwnerNode` is untouched** — the host's own owner node still carries the installer
  identity from `<dataDir>`, and acquires no second key.
- **Docs** — `docs/architecture.md` (cold-start-retries bullet: the "every `cadre-host`-spawned
  child" claim was false before this landed), `docs/cadre-host.md` (donated-node identity
  paragraph), `docs/STATUS.md` (node-donation checklist bullet, added during review).

Reuse — not rotation — is the load-bearing property: any future path that re-spawns a donated
node must reuse its `containerId`, or it lands on a fresh workdir and a fresh key, reproducing
the original bug.

## Review findings

### Checked

Read the implement diff before the handoff summary. Verified the flag→config→store chain by
reading `cadre-cli/src/commands/start.ts:147-164` and `config/loader.ts:283-285` rather than
trusting the handoff's inference. Reviewed resource cleanup around port allocation, the error
path when the key file is damaged, owner-node isolation, container-id reuse after
`removeContainer`, and the three docs the change touches plus `docs/STATUS.md`, which it should
have touched and did not. Ran `yarn workspace @serfab/cadre-host test` (57 files, 465 passed,
4 skipped), `yarn lint` (clean), `tsc --noEmit` on cadre-host and integration-tests (clean), and
`yarn workspace @serfab/cadre-host build` (clean).

### Fixed in this pass

- **Four ports leaked per failed provision.** `createContainer` allocated health, metrics, p2p
  and admin ports *before* awaiting `ensureNodeIdentity`, and nothing released them if that
  step threw — the identity step is the one fallible thing between allocation and `launchChild`
  (which does release on spawn failure). A damaged `identity.key` therefore burned four ports
  out of a bounded range on every retry, and `DonationService.provision` catches the throw and
  lets the grantee retry, so the leak compounds silently until provisioning stops working. The
  sibling `DockerOrchestrator` guards exactly this window, with a comment saying why. Fixed by
  moving the identity step above the allocation, so a failure reserves nothing. Regression test
  added: an orchestrator with a four-port range survives a failed create and still provisions a
  healthy container afterwards.
- **Redundant `mkdirSync`** of the workdir in `createContainer` — `generateIdentity` already
  creates the parent directory (behaviour the unit tests pin). Removed with the reorder.
- **Damaged key must fail, not re-key** — this was already the behaviour (`loadIdentity` throws
  on an undecodable file) but nothing pinned it, and a future "make it robust" edit that fell
  back to `generateIdentity` would silently reproduce the bug this module exists to fix. Unit
  test added asserting it throws and leaves the file untouched.
- **Owner-node isolation was listed as a use case with no test.** Added one: `ensureOwnerNode`
  passes the host's `identityPath` and its workdir gains no `identity.key`.
- **`docs/STATUS.md` node-donation checklist** did not record the change. Added a bullet, with
  the pointer to the still-open provider-side equivalent.

### Closed the handoff's largest gap (partially — see below)

The handoff was honest that both new specs use a fake CLI, so they prove the spawn argument and
the key file but not that the two node-local stores actually appear. It deferred that to a
sibling ticket, `node-state-dir-decoupled-from-identity-key` — **which does not exist**; the
slug appears only in the handoff text. So the gap had no owner.

`cadre-host-node-donation.integration.ts` already runs a real requester cadre and a real donated
node through a real seed, so the assertion belongs there and nowhere else. Added `step 6b`: the
donated node's workdir holds an `identity.key` whose peer id equals the one the requester
approved, plus a `bootstrap-peers.*.json` and a `trusted-owners.*.json`.

**That step compiles but was not executed** — the scenario starts two real libp2p children with
90-second startup budgets, beyond what this pass could spend. Filed as
`backlog/debt-verify-donated-node-store-assertions`, which also spells out how to read a
failure (missing key ⇒ defect in this change; key present but a store missing ⇒ a different
defect entirely).

### New tickets filed

- `backlog/debt-verify-donated-node-store-assertions` — run the scenario above and confirm the
  new assertions hold.

No other major findings. The two adjacent gaps the handoff named already have tickets and were
not re-filed: `backlog/bug-donated-nodes-never-respawned` (nothing in production re-spawns a
donated node yet, so the reuse property is exercised only by tests) and
`backlog/bug-provider-container-identity-not-persisted` (the same defect class on the
multi-tenant Docker provider, where `RestartPolicy: unless-stopped` makes it worse).

### Tripwires

- The p2p port is re-allocated on every spawn, so a re-spawned donated node keeps its peer id
  but may announce a different port. Parked by the implementer as a `NOTE:` at the allocation
  site in `host-process-orchestrator.ts`; verified it is still there and still accurate after
  the reorder. Recoverable on its own (the node dials its retained bootstrap peers and
  republishes its `CadrePeer` row), so it stays a note rather than a ticket.
- Nothing else new. Concurrent `createContainer` calls for one `containerId` would race on the
  key, but the class already documents `createContainer` as the single producer per workdir and
  donation ids are unique, so there is no condition under which it trips.

### Known, accepted, unchanged

- Donated nodes already running before this landed have no `identity.key`, so their first
  restart under this code generates one and changes their peer id once. They had no stable id
  to begin with; this is an improvement, not a migration.
- On Windows the key is left at inherited directory ACLs — `chmodSync` is a no-op there. That is
  pre-existing behaviour of `installer/identity.ts`, shared with the host's own identity key.
- Donated nodes now also keep a durable trusted-owner store. Harmless: the host re-supplies the
  pinned owner key via `CADRE_OWNER_KEYS` on every spawn, so the anchor recovered on its own
  before and merely persists now too.
