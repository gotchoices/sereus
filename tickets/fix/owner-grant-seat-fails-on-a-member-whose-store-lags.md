description: A machine that is already in the cadre, but was offline when an owner grant was made, cannot redeem that grant right after it comes back: copying the grant into its own records fails with a duplicate-key error, because the rest of the cadre already holds that record and this machine has not caught up yet.
architecture: docs/architecture.md#owner-grants
files: packages/cadre-core/src/control-database.ts (seatIssuedRow, seatOwnerGrant, seatCadreInvite, redeemOwnerGrant), packages/cadre-core/src/cadre-node.ts (redeemOwnerGrantLocally), packages/cadre-core/src/owner-grant-protocol.ts (OwnerGrantHandler), packages/cadre-core/src/cadre-invite-protocol.ts (CadreInviteHandler), packages/cadre-cli/src/commands/start-owner.ts (redeemForServerKey, the caller that exposed it)
repro: verified
----

# Seating a grant from its bundle fails on a member whose store lags the cohort

## What happens

`CadreNode.redeemOwnerGrant`'s local path (a member machine redeeming in its own store) first seats the grant row from the bundle (`ControlDatabase.seatOwnerGrant`, through `seatIssuedRow`). The seat is insert-if-absent: it reads the row locally under the write lock and inserts when the read finds nothing. When the member was offline while the grant was minted, the read finds nothing (its store has not caught up), but the insert's commit is checked by the cohort, which already holds the row, and is refused:

```
⚠ Control write abandoned [owner-grant-seat] after 1/3 attempt(s) (declined): UNIQUE constraint failed: OwnerGrant.Key
✗ Failed to redeem the owner grant: UNIQUE constraint failed: OwnerGrant.Key
```

The redemption fails with a raw constraint message and no code, which callers (cadre-cli's `/status`, the apps' failure text) classify as final.

## Reproduction (verified with real cadre-cli nodes)

1. Owner node A: `cadre start --owner --admin-port …`.
2. Node C joins by invitation (`POST /admin/invites`, `CADRE_INVITATION`), and A lists it as an authorized member. Stop C.
3. While C is stopped, mint an owner grant on A (`POST /admin/owner-grants`).
4. Start C with `CADRE_OWNER_GRANT=<the grant>`. cadre-cli runs one control-cohort dial pass (so the redemption is not refused `alone`), then `redeemOwnerGrant`; it fails as above.

The same run with step 3 done while C is still running, waiting until C's `GET /admin/owner-grants` lists the grant, then restarting C, succeeds: the grant is redeemed in place and the key wired. So the failure is the member's store lagging the cohort, not the redemption itself. The scenario was a throwaway file and was deleted; the steps above rebuild it from `startOwnerCliNode`-style launches (`packages/integration-tests/src/harness/owner-cli-node.ts`, `child-node-fixtures.ts`).

## Expected

A row the cohort already holds is "already seated" for an insert-if-absent seat, and the redemption carries on against it, as it does when the row is local. If the local store cannot answer the following reads yet (`ControlDatabase.redeemOwnerGrant` reads the grant with `queryOwnerGrant(grantKey, false)` and throws "no OwnerGrant row is seated on this node" when it is absent), the failure should be a retryable one with a name, not a raw constraint error.

## Notes for the fix

- `seatIssuedRow` is shared with `seatCadreInvite`, so an invitation seat on a lagging member has the same shape. The member-side protocol handlers (`OwnerGrantHandler`, `CadreInviteHandler`) seat bundle rows too; how they answer a holder on this refusal (`writeFailureRefusal` / `constraintRefusal` in `member-redemption.ts`) was not checked (static).
- `publishStrand` already tells "my insert hit an existing id" apart by message text (`idConflictPattern` in `control-database.ts`; `docs/schema-guide.md` says to match on the `UNIQUE constraint failed: <Table>.<Column>` text, not the error type).
- The apps' Redeem an owner grant on a member device right after it reconnects takes the same local path (`edge-node/owner-grant.ts` → `redeemOwnerGrant`).
