----
description: Control writes fail because one machine in the party is holding a different copy of the data than everyone else, under the same version number. The machine got there by applying an update on top of an old copy after missing the updates in between, and the code that would prevent that is in another repository.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts
repro: verified
----

# Blocked (b): a control write is rejected by a cohort member holding forked content

**Category (b) — dependency outside this repo.** The fork is created and must be prevented inside
`@optimystic/db-p2p`; nothing on this side can guard it.

**Upstream ticket:** `../optimystic/tickets/fix/1-a-commit-over-a-gapped-base-forks-the-block.md`.
Its sibling `2-a-coordinator-commits-a-rival-its-own-member-refused.md` covers a second, less
well-evidenced mechanism that produces the same end state.

**Unblock condition:** the commit-tier base guard lands upstream and `../optimystic` is rebuilt.
Then run `control-write-degraded-cohort-member` several times — the `content-digest-mismatch`
fingerprint should be gone entirely — and remove this file's entry from
`tickets/.pre-existing-known.md`.

## What this looks like from here

Two tests in `control-write-degraded-cohort-member.integration.ts` fail:

- `commits with a healthy three-member cohort (authorize AND remove)`
- `commits with a member delayed under the response deadline`

both with:

```
Transaction rejected by validators (1/3 rejected): 12D3Koo…: content-digest-mismatch
```

## What it actually is

Not a test problem and not a new bug. Optimystic 0.29.0 added a member-side content-digest check:
cohort members independently re-compute what a write will produce and vote against it when the
author's declaration disagrees. That check is working. What it found is that a party machine can be
holding **different content than its siblings under the same revision number**.

It gets there by applying an update over a gap. A machine that missed revisions 8 and 9 still accepts
the commit for revision 10, applies it to the revision 7 it holds, and records the result as
revision 10. Nothing at either the pend tier or the commit tier refuses a member that is *behind* —
only one that is ahead. Measured over three isolated runs, every one of 122 captured mismatch records
had `previewBaseRev === declaredBaseRev`, which rules out a base-revision race: the two nodes applied
the same transform to what each called the same revision and produced different bytes.

The full lineage, the ruled-out alternatives and the recommended one-block fix are in the upstream
ticket. Do not re-derive them here.

## Why this matters more than a red test

Before 0.29.0 this fork happened silently. The machines simply disagreed and nothing said so. The
new check is the first thing in the system that notices. So the correct reading of these two failures
is *"a data-integrity defect that was already present is now visible"*, not *"0.29.0 broke control
writes"* — and the release decision should be made on that basis.

## What was ruled out on this side

- **The forced cohort is not the cause.** `forceFullCohort`/`pinCoordinator`
  (`harness/forced-cluster.ts`) patch the key network prototype process-wide, so they were the first
  suspect. The forking commits run at `peerCount: 2` during bring-up, before the force is installed.
  Forcing a 3-peer cohort only makes the already-forked machine a mandatory voter, which is why the
  damage surfaces here rather than staying hidden.
- **The overnight harness work did not perturb this scenario.** Diffed across the commit window
  `310661f..c8372d1`: `cadre-core/src` unchanged, the scenario file unchanged, `controlNodeConfig`
  behaviour-identical for the options this scenario passes, and the new harness re-exports carry no
  top-level side effects. The fork is a boot-time discovery-cohort draw and so varies run to run.

## Distinguish it from its neighbours in the same file

- `pending conflict: block … held by unresolved action(s)` is
  `control-write-retry-does-not-absorb-a-transient-stream-reset` — a different defect, already owned.
- The boot-gate timeout `Timeout waiting for C self-publishes its CadrePeer record` may be the
  upstream sibling ticket's mechanism rather than
  `control-peer-row-refresh-invisible-to-third-node`, which currently owns it. Do not re-attribute
  either on this evidence; the sibling ticket carries one observation only.
