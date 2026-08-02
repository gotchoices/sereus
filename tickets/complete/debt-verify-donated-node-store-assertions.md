description: A check that a lent-out machine really does save its network credentials to disk was written but never run; it has now been run and passes, and the check itself was tightened so it inspects what was saved rather than only that a file appeared.
files: packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts, docs/STATUS.md
difficulty: easy
---

# Donated-node workdir assertions: verified, then strengthened

## What this ticket was

`cadre-host-node-donation.integration.ts` step 6b (assertions that a donated node persists
its identity key + node-local stores to its workdir) existed in source but had never been
executed. Job: run it, report the result.

## What was done

- Rebuilt `@serfab/cadre-core` → `@serfab/cadre-cli` → `@serfab/cadre-host` (all clean).
- Ran the scenario. All 6 ordered steps pass, including step 6b. Confirmed on three separate
  runs (before edits, after assertion changes, and final).
- Strengthened step 6b (see findings below) and corrected a stale line in `docs/STATUS.md`.

Command: `cd packages/integration-tests && yarn vitest run --reporter=verbose src/scenarios/cadre-host-node-donation.integration.ts`
(~20s wall, mostly module transform/import; spawns two real `cadre-cli` children.)

## Review findings

### Checked

- **Implement diff** — the implement commit (`04fe12e`) touched only the ticket file; no source
  changes to review, so the review targeted the assertion set the ticket was verifying.
- **Reproduced the claim** — full scenario run, green, 6/6. The implementer's result holds.
- **Assertion strength of step 6b** — traced what actually writes the files
  (`cadre-core/src/node-local-snapshot.ts`, `file-durable-slot.ts`,
  `bootstrap-peer-store-file.ts`, `trusted-owner-store-file.ts`).
- **Lint + typecheck** — `yarn lint` clean, `yarn workspace @serfab/integration-tests typecheck` clean.
- **Docs touching this scenario** — `docs/STATUS.md`, `docs/cadre-host.md`, `docs/architecture.md`.

### Found and fixed inline (minor)

- **Step 6b only proved files *appeared*, never what was in them.** The store files are
  snapshot-written only from a `put`, so mere existence does imply an entry landed — but a
  prefix-only `startsWith('bootstrap-peers.')` check would equally pass for a *foreign party's*
  file or a *stranger's* key, which is the exact failure the step exists to catch. Step 6b now
  parses both files and asserts the envelope's `partyId` is party P, that `peers` contains the
  requester's peer id (the seed-nominated cold-start dial target), and that `owners` contains
  the pinned requester owner key. Both new assertions pass against the real child, so this is a
  genuine strengthening, not a rewrite of a passing test into a tautology.
- **`docs/STATUS.md` said "5/5 steps green"** for this scenario — stale since step 6b was added
  (it is 6). Updated, and the line now states what step 6b checks on disk.

### Found, not fixed (tripwire)

- The new `readNodeLocalStore` helper takes the *first* filename matching the store prefix. A
  donated node serves exactly one party, so this is unambiguous today; if a workdir ever holds
  several parties' stores it must select by encoded party id instead. Parked as a `NOTE:` comment
  on the helper in the scenario file.

### No tickets filed

No major finding surfaced. The one adjacent gap noticed — a *respawned* donated child rejoining
the borrower's cadre is not covered by this scenario — is already recorded in `docs/STATUS.md`
(§ Cadre-host node-donation realignment) and has an open ticket at the same code site
(`tickets/plan/30-debt-failed-respawn-strands-donated-workdir.md`), so nothing new was filed.

### Not run

No other suites. This ticket's only source change is inside one integration scenario file plus a
docs line; nothing else imports either.

## Result

Verification confirmed: the identity-key spawn wiring and the node's own file-backed store
creation work as designed. Step 6b now proves it against the actual persisted payload.
