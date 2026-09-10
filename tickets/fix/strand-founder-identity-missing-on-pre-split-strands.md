----
description: Closed strands founded before the per-party identity change keep their old founder identity, which every joining party can compute, and the founder's new identity key is never admitted as a member or manager. The launch claims to heal such strands but does not. Detect this and fail loudly with a clear remedy instead of silently running a strand that is still forgeable and that can no longer issue invitations.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-membership-writer.ts, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----

# Founder identity is not healed on closed strands founded before the key split

## Background

`strand-party-member-key` (complete) split a closed strand's founding identity from the shared read secret. Before it, the founding `Strand.Member` / `Strand.Manager` rows were seated with a keypair derived from the control-layer `Strand.MemberPrivateKey`, which formation hands to every joining party — so any joiner could sign as the founding manager (gotchoices/sereus#4). After it, the founder's identity comes from a per-party `CadreControl.StrandPartyKey` row.

## The defect

For a closed strand whose `Strand.Member` / `Strand.Manager` rows were written before that change, nothing is healed:

- `CadreNode.resolveStrandPartyKey` mints and persists a new party key on the founding machine (its doc comment calls this "the heal for strands published before the key split").
- `StrandDatabase.ensureFounderBootstrap` → `bootstrapFounderMembership` then inserts the founding Member and Manager only when the tables are empty (`insertFounderMemberIfAbsent`, `strand-membership-writer.ts` ~line 298, guards on `strandTableCount(db, 'Member') > 0`). On a pre-split strand they are not empty, so the bootstrap writes nothing.

Result on such a strand:

1. The manager is still the key derived from the shared `MemberPrivateKey`. Every party that ever joined can still act as the founder. The security fix does not apply to it.
2. The founder's new party key is neither a `Member` nor a `Manager`. Anything that signs as the founder with it — `issueInvite` (`InviteValid` rejects a non-manager), `revokeMember`, and the formation-issued membership invitation from `strand-formation-membership-invite` — is refused by the strand's constraints, so closed-strand joins to that strand fail with a constraint error that says nothing about why.
3. Nothing reports any of this. The launch succeeds.

This is reachable by anyone upgrading from `@serfab/*` 0.13.0 or earlier with a closed strand whose `Strand` row carries a `FounderOwnerKey` (strands with a null `FounderOwnerKey` never mint, and hit only point 2).

## Expected behavior

The repo's policy is no backwards compatibility yet, and the v0.13.0 release notes already tell test deployments to wipe. So the fix is not a migration: it is to stop pretending, and to make the failure legible.

- On a founder launch of a closed strand whose `Strand.Manager` table is non-empty but does not contain the party key's public half, fail loudly (or, if failing the launch is judged too disruptive for a strand that is otherwise readable, refuse founder-only writes with the same message) naming the cause and the remedy: this closed strand was founded before per-party identity, its founder identity is shared with every joiner, and it must be recreated.
- The check must not fire on a founder whose strand rows simply have not loaded, and must not fire on a correctly founded strand (manager set contains the party key). A joiner launch is out of scope — joiners do not bootstrap.
- Correct the `resolveStrandPartyKey` doc comment: minting the key on a pre-split strand does not heal its membership.
- Fix the stale error message in `bootstrapFounderMembership` (`strand-membership-writer.ts` ~line 392), which still says "no founder key pair derived from MemberPrivateKey".
- Docs: `docs/strands.md` (closed-strand member key handling) and `docs/architecture.md` (strand membership bootstrap) should say plainly that closed strands founded before the split must be recreated.
- Add a line to `.release-notes.pending.md` for sApp builders: closed strands created on 0.13.0 or earlier must be recreated after upgrading; the launch will refuse them.

## Considered and rejected

A founder-signed migration — the founding machine still holds `MemberPrivateKey`, so it could sign as the old manager to admit its party key as member + manager and then revoke the old identity. Rejected: the old manager key was held by every joiner, so any joiner could already have admitted or revoked anyone, and could race the migration itself. A strand whose manager key was shared cannot be trusted by rewriting its manager, and building the migration contradicts the no-backwards-compat policy.

## Reproduce first

A cadre-core spec: found a closed strand the pre-split way (seat Header / Member / Manager from `strandMemberKeyPair(MemberPrivateKey)` directly via the strand database, with a `Strand` row whose `FounderOwnerKey` is this machine's owner key), then launch it through `CadreNode` as founder. Today: launch succeeds, a `StrandPartyKey` row appears, `Strand.Manager` still holds only the shared-derived key, and `issueInvite` with the party keypair is refused. After the fix: the launch (or the founder write) fails with the named cause.

## TODO

- Write the reproducing spec described above and confirm today's behavior.
- Add the manager-set check at the founder bootstrap seam, with the message naming the cause and the remedy.
- Cover: correctly founded strand still launches; pre-split strand fails with the message; joiner launch unaffected.
- Correct the `resolveStrandPartyKey` comment and the `bootstrapFounderMembership` error text.
- Update `docs/strands.md`, `docs/architecture.md`, `.release-notes.pending.md`.

## Addendum (2026-09-10): how this surfaces through formation

`strand-formation-membership-invite` (implement fc0ad48) added `CadreNode.issueStrandMembershipInvite`, called on every bound closed-strand redemption. On a pre-split strand the founder launch has already minted a `StrandPartyKey` row, the runtime is live, so the method reaches `issueInvite(db, { managerKeyPair: strandMemberKeyPair(partyKey) })` — and the strand's `InviteValid` constraint rejects it because the party key is not a `Strand.Manager`. The formation manager maps every hook throw to `MEMBERSHIP_INVITE_UNAVAILABLE_REASON` ('Strand membership invitation unavailable, retry'). So a joiner is told to retry a condition that is permanent, and retries forever.

Two more corrections for this ticket:

- The `issueStrandMembershipInvite` doc comment and its no-`StrandPartyKey` error text both say "a pre-split strand that has not healed at launch" — the same false premise as `resolveStrandPartyKey`: launch does not heal membership. Correct both.
- If the launch-time check above is implemented as a hard launch failure, formation never reaches this path for a pre-split strand (no live runtime → the existing "not live" rejection). If it is implemented as refusing founder-only writes instead, the hook must throw a distinct, non-retryable reason for this case rather than the generic retry one. Either way, add a test that a bound closed redemption against a pre-split strand does not answer "retry".
