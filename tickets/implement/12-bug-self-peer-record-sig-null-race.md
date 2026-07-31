description: When a node adds itself as a member at the same moment it is publishing its own address record, the published record is left without the node's signature until the next refresh, so other nodes can't reach it in the meantime. Make the publish detect that it lost the race and re-sign instead of silently giving up.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/peer-record-resolution.spec.ts
difficulty: medium
----
**Reproduced and root-caused during the fix stage. A candidate patch below was written,
type-checked, and validated against a real control database — both race orders pass and
136 tests across seven neighbouring specs stay green. The patch was then reverted so this
stage lands it; it is a starting point, not a mandate.**

## What actually happens

`CadreNode.publishSelfRecord` (`packages/cadre-core/src/cadre-node.ts`, inside
`registerSelf`) does a read-then-branch:

```
addrs    = collectSelfAddrs()
existing = controlDatabase.queryPeerRecord(selfPeerId)      // <-- read
record   = signPeerRecord(..., updatedAt = max(now, existing.updatedAt + 1))
existing ? updateSelfPeerRecord(record)                      // self-signed UPDATE
         : seedBootstrapService.insertSelfPeerRecord(record) // owner-signed INSERT
```

`insertSelfPeerRecord` funnels into `SeedBootstrapService.insertCadrePeerRow`
(`seed-bootstrap.ts:364`), which takes the control database's write lock and re-checks
row existence *inside* the lock. That check exists so two writers racing the same peer's
first row don't collide on the unique-key constraint — the loser no-ops instead of
throwing. It returns `void`, so the caller cannot tell "I inserted" from "someone beat
me".

If an owner `authorizePeer(selfPeerId)` lands in the window between the read and the
insert, the authorize seats the row with `Sig` null (an owner cannot forge the peer's own
signature) and an empty `Multiaddr`. The self-publish's insert then no-ops and
`publishSelfRecord` returns `'inserted'` — but the row it "inserted" is the authorize's,
with no signature and no addresses.

Confirmed by instrumenting the stored row after the race: `sig` length `0`, `addrs` `[]`.

## Consequence

The node's own address record does not resolve. `resolvePeerAddrs` verifies `Sig` against
the stored `PublicKey`, and an empty signature fails, so every other member that looks the
node up by PeerId gets nothing back. It self-heals on the next periodic self-registration
(that pass sees the row, takes the UPDATE path, writes a real signature), but the node is
unreachable-by-lookup for up to one heartbeat interval.

The reverse order is already fine: if the self-publish wins, the authorize's insert
no-ops and leaves the good signed row alone. Verified by test.

## Why the one-line version isn't enough

Having the insert report "I lost" and falling through to the UPDATE path is necessary but
not sufficient. The record was signed against the *pre-race* read, so its `UpdatedAt` was
derived from a row that no longer describes reality. The `CadrePeer.AuthorizedUpdate`
self-branch requires a strictly greater `UpdatedAt` than the stored row, so the fall-through
must re-read the row that actually landed and re-sign against **that** stamp.

## Adjacent path checked — not affected

`SeedBootstrapService.insertSelfDeviceToken` (the `DeviceToken` twin) is *not* idempotent:
it has no in-lock existence check and would throw on a conflict rather than silently
no-op, and there is no owner-driven path that seats a `DeviceToken` row on a peer's
behalf. No analogous silent-drop race there. No change needed.

## Candidate patch

`seed-bootstrap.ts` — let the shared insert report whether it actually inserted.
`authorizePeer` ignores the result and stays `void`; the three existing test/integration
callers of `insertSelfPeerRecord` `await` it and ignore the value, so nothing else moves.

```ts
  async insertSelfPeerRecord(record: PeerAddressRecord): Promise<boolean> {
    return await this.insertCadrePeerRow({ /* ...unchanged... */ });
  }

  private async insertCadrePeerRow(row: { /* ...unchanged... */ }): Promise<boolean> {
    // ...unchanged preamble...
    return await controlDatabase.mutateCadrePeer('peer-insert', async () => {
      if (await controlDatabase.queryCadrePeerStampId(row.peerId) !== null) {
        log('CadrePeer row already present for %s; insert skipped (already a member)', row.peerId);
        return false;
      }
      await db.exec(/* ...unchanged insert... */);
      return true;
    });
  }
```

`cadre-node.ts` — restructure `publishSelfRecord` so the insert branch falls through to
the self-update path on a lost race, re-signing against a fresh read. The signing is
lifted into a small helper so both call sites share the monotonic-stamp rule.

```ts
    const peerId = this.controlNode.peerId.toString();
    const addrs = await this.collectSelfAddrs();
    const existing = await this.controlDatabase.queryPeerRecord(peerId);

    if (!existing) {
      if (!this.seedBootstrapService) {
        log('registerSelf: not yet a CadrePeer member and no owner service to self-insert; skipping (an owner must add this peer first)');
        return 'skipped';
      }
      // First-time row: requires an owner signature (the node is its own
      // owner). insertSelfPeerRecord throws if no owner key is present.
      const record = this.signSelfRecord(peerId, signingKey, addrs, null);
      if (await this.seedBootstrapService.insertSelfPeerRecord(record)) {
        if (this.committedAlone()) this.pendingSelfPeerWrite = true;
        log('registerSelf: inserted own CadrePeer record (owner-signed, updatedAt=%d, %d addrs)', record.updatedAt, addrs.length);
        return 'inserted';
      }
      // An owner authorize of this node's OWN peer id seated the row inside the
      // read-then-insert window. That insert is idempotent, so it left the
      // authorize's empty Sig in place and the row would not resolve until the
      // next heartbeat. Fall through to the self-update path below, which
      // re-reads and re-signs against the row that actually landed — the stamp
      // read above is not that row's, and the self-update rule demands a
      // strictly greater one.
      log('registerSelf: own CadrePeer row appeared mid-publish (concurrent authorize); self-updating to carry the signature');
    }

    // `existing` is the pre-race read on the fall-through path, so re-read there.
    const current = existing ?? await this.controlDatabase.queryPeerRecord(peerId);
    if (!current) {
      log('registerSelf: own CadrePeer row vanished mid-publish; skipping (next refresh re-inserts)');
      return 'skipped';
    }
    const record = this.signSelfRecord(peerId, signingKey, addrs, current);
    await this.controlDatabase.updateSelfPeerRecord(record);
    if (this.committedAlone()) this.pendingSelfPeerWrite = true;
    log('registerSelf: refreshed own CadrePeer record (updatedAt=%d, %d addrs)', record.updatedAt, addrs.length);
    return 'refreshed';
  }

  /**
   * Sign this node's address record for publication, stamped strictly later than
   * `existing` (the row it is about to replace, or null for a first insert) so a
   * same-millisecond re-publish still satisfies the monotonic `UpdatedAt` rule the
   * `CadrePeer.AuthorizedUpdate` self-branch enforces.
   */
  private signSelfRecord(
    peerId: string,
    signingKey: { privateKeyB64: string; publicKeyB64: string },
    addrs: string[],
    existing: PeerAddressRecord | null
  ): PeerAddressRecord {
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    return signPeerRecord(
      { peerId, publicKey: signingKey.publicKeyB64, addrs, updatedAt },
      signingKey.privateKeyB64
    );
  }
```

`PeerAddressRecord` must be added to the existing `import type { ... } from './types.js'`
list at the top of `cadre-node.ts`.

Notes on why the fall-through is safe: the authorize derives `PublicKey` from the peer id,
and `getSelfSigningKey` already refuses to publish unless the node's key matches
`ed25519PublicKeyB64FromPeerId(peerId)` — so the stored key is the one the self-signature
verifies against, and `updateSelfPeerRecord` never touches `PublicKey` (the constraint
pins it immutable). The `existing ?? re-read` keeps the common refresh path at a single
read; only the raced path pays a second one.

The extra `return 'skipped'` guard covers the row being removed between the failed insert
and the re-read (an owner `removePeer` racing in). Without it the code would sign against
a null row.

## Reproducing test

Deterministic — no timing luck. Wrap `queryPeerRecord` so the authorize is wedged into
the exact window after the "does my row exist?" read returns null and before the insert.
Verified to fail on the current code (`verifyPeerRecordSignature` returns false) and pass
with the patch above.

```ts
	it('carries a valid self-signature when an authorize lands mid-publish', async () => {
		const { node, peerId } = booted;
		node.setInviteAddresses([circuitAddr(peerId), '/ip4/1.2.3.4/tcp/4001']);

		// Wedge the authorize into the exact window: after publishSelfRecord's
		// "does my row exist?" read returned null, before its INSERT.
		const db = node.getControlDatabase()!;
		const original = db.queryPeerRecord.bind(db);
		let wedged = false;
		db.queryPeerRecord = async (pid: string): Promise<PeerAddressRecord | null> => {
			const result = await original(pid);
			if (!wedged && pid === peerId && result === null) {
				wedged = true;
				await node.authorizePeer(peerId, []);
			}
			return result;
		};

		await node.registerSelf();
		expect(wedged).toBe(true);

		db.queryPeerRecord = original;
		const stored = await db.queryPeerRecord(peerId);
		expect(verifyPeerRecordSignature(stored!)).toBe(true);
		expect((await node.resolvePeerAddrs(peerId)).length).toBeGreaterThan(0);
	}, 60_000);

	it('keeps the self-signature when the authorize lands after the publish', async () => {
		const { node, peerId } = booted;
		node.setInviteAddresses([circuitAddr(peerId), '/ip4/1.2.3.4/tcp/4001']);

		await node.registerSelf();
		await node.authorizePeer(peerId, []);

		const stored = await node.getControlDatabase()!.queryPeerRecord(peerId);
		expect(verifyPeerRecordSignature(stored!)).toBe(true);
		expect((await node.resolvePeerAddrs(peerId)).length).toBeGreaterThan(0);
	}, 60_000);
```

Home: `packages/cadre-core/test/peer-record-resolution.spec.ts`. Its existing
`bootOwnerNode` fixture supplies `booted` (`{ node, peerId, ... }`) and the file already
defines `circuitAddr` and imports `verifyPeerRecordSignature`; the `PeerAddressRecord` type
is imported there too. The reverse-order test is the cheap regression guard for the branch
that already works — keep both. Restore the patched `queryPeerRecord` before asserting so a
later assertion can't re-trigger the wedge.

## TODO

- Change `SeedBootstrapService.insertCadrePeerRow` + `insertSelfPeerRecord` to return
  `boolean` (`true` = this call inserted the row, `false` = a concurrent writer had already
  seated it). Update their doc comments — `insertSelfPeerRecord`'s currently promises the
  row "resolves immediately without a follow-up self-update", which is exactly the claim
  the lost race breaks.
- Restructure `CadreNode.publishSelfRecord` to fall through from a lost insert to the
  self-update path, re-reading and re-signing against the landed row. Add the
  `signSelfRecord` helper and the `PeerAddressRecord` type import.
- Handle the row-vanished case on the re-read (return `'skipped'`), so a concurrent
  `removePeer` can't make the code sign against nothing.
- Add both race-order tests to `packages/cadre-core/test/peer-record-resolution.spec.ts`.
- Decide the return value for the raced path. The candidate patch returns `'refreshed'`,
  which is honest about what the write did (an UPDATE), though the caller's intent was a
  first publish. `SelfRegistrationOutcome` has no third state and no caller branches on
  `'inserted'` vs `'refreshed'` today — confirm that before considering a new variant.
- Validate: `yarn typecheck` and `yarn vitest run` in `packages/cadre-core`. During the fix
  stage the targeted set `peer-record-resolution`, `seed-bootstrap`, `peer-authorization`,
  `control-database-offline-peers`, `control-membership-hub`, `cadre-node-control-replication`,
  `control-database-solo` was run against the candidate patch — 136 passed. Run the full
  package suite here, since only that subset was covered.
- `packages/cadre-core/test/control-write-lock.spec.ts` already covers "both orderings of
  the self-publish/authorize first-row race" — but only asserts *exactly one row, no
  unique-key violation*, which is precisely why this bug slipped through. Add a signature
  assertion to the ordering where the authorize wins, or leave a `NOTE:` there pointing at
  the new coverage in `peer-record-resolution.spec.ts` so the next reader doesn't mistake
  that spec for full coverage of the race.
- `docs/STATUS.md:715` describes that write-lock spec's race coverage; update the wording if
  the assertions there change. Nothing in `docs/cadre-consistency.md` or
  `docs/architecture.md` spells out the read-then-insert self-publish sequence, so no doc
  change is needed for the fall-through itself — confirm before skipping.
