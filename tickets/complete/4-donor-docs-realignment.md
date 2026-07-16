description: Reviewed a documentation rewrite that repositioned cadre-host's docs around its real primary job (running spare nodes that join other people's cadres) instead of the outdated "host your own cadre" framing; the rewrite is accurate and honest about what is built vs still in progress, and shipped clean with no changes needed.
prereq:
files: docs/cadre-host.md, docs/architecture.md, docs/STATUS.md
----

# Complete: cadre-host donor-model docs realignment (review)

Part A of the original `4-donor-docs-and-integration`. Docs-only realignment of
`cadre-host.md` / `architecture.md` / `STATUS.md` around the corrected model: cadre-host
**donates nodes to external cadres** (requester's device is the authority, host holds no
owner key) as its primary role, with running the host's own cadre demoted to an opt-in
**founder** role. Part B (cross-package node-donation integration test) is
`implement/4-donor-node-donation-integration` (prereq: donation-service).

## Review findings

Adversarial pass read the implement diff (`5bac60f`) first, then validated every doc
claim against HEAD code. **Result: docs ship as-is — no inline fixes, no new tickets.**

### Verified accurate against code

- **Landed claims true.** `packages/cadre-host/src/donation/{grant-service,grant-store,donation-store,types}.ts`
  and `server/routes/grants-admin.ts` exist. Store filenames match docs exactly
  (`grants.json`, `donations.json`). CLI subcommands match (`grant issue|list|revoke`),
  and the `grant` CLI targets the loopback `/grants-admin` surface (host.ts:680/720/759).
  Pinned-owner-key wiring is real: `HostProcessOrchestrator.createContainer` (line 220)
  threads `request.pinnedOwnerKeys` into the child via `CADRE_OWNER_KEYS`
  (host-process-orchestrator.ts:236-240). `HostProcessOrchestrator implements Orchestrator`
  (line 97) — confirms architecture.md's "second `Orchestrator` implementation" claim.
- **"In progress" claims true — nothing overclaimed.** No `donation/donation-service.ts`,
  no `server/routes/grants.ts`, no grantee-facing `POST /grants` route, no
  `DonationService` class, no `awaiting_seed` reap sweep in the tree. Docs describe the
  `/grants` lifecycle explicitly as fixed *design*, not shipped code — framing cannot be
  misread as "already works" (`[~]` in STATUS.md; "the routes are in progress" in
  cadre-host.md § Status of the donation surface).
- **All anchors + cross-doc links resolve.** `#node-donation-the-primary-role`,
  `#two-roles-donor-and-founder`, `#control-plane-separation-load-bearing-principle`,
  `#write-whitelist-for-apisettings`, `#security-posture`, and
  `architecture.md#provider-integration` (## Provider Integration, line 622) all exist.
  Referenced ticket files exist: `tickets/backlog/feat-cadre-host-wan-grant-reachability.md`,
  `tickets/implement/2-donation-service.md`, `tickets/implement/4-donor-node-donation-integration.md`.

### Residual founder-drift hunt (review instruction #4) — clean

Scanned `cadre-host.md` for leftover "the host owns the cadre" framing outside the marked
founder sections. None found. The line-120 "the host holds the admin's owner identity"
phrase is the *corrected* one — explicitly scoped to the opt-in founder role and labelled
"the exception, not the rule." The founder-role marker (line 124) enumerates its scope
precisely (single-owner topology, node admin channel, trust circle, NAT/DDNS) and does
**not** overclaim role-general sections (Push, Updates, Local UI, Security posture) as
founder-only — the Local UI honest-gaps even correctly describe donor-only behaviour.

### Judgment call resolved (honest-gap #2) — no revert

`architecture.md` package header changed `(Complete)` → `(Founder role complete; donor
lifecycle in progress)`. **Kept.** Preserving `(Complete)` would falsely claim the donor
lifecycle is done when `DonationService` / `/grants` are absent. The new header is the
honest state.

### Tests / lint — not applicable, with reason

Diff is **purely markdown** (`docs/*.md`). Markdown is outside the ESLint/TS gate
(AGENTS.md → lint is ESLint flat config over TS; no prose/markdown linter in the repo), so
there is no build/test/lint surface this change touches. Running the TS suite would
validate nothing about the change. Nothing skipped or disabled.

### Parked (index only — not re-filed)

- **architecture.md present-tense `/grants` pointers** (lines 410, 625) describe the
  `/grants` delivery surface without an "in progress" caveat, in the design-doc voice. If
  `2-donation-service` lands `/grants` with different route/method names than documented,
  both architecture.md pointers **and** cadre-host.md § Node donation need a touch-up. This
  is the implement handoff's honest-gap #1 and belongs to `2-donation-service` /
  `4-donor-node-donation-integration` — **not re-filed** here per the ticket's review
  disposition (missing `DonationService`/`/grants` surface is that ticket's work). No code
  site to tag; recorded here as the index entry.

## Disposition

Minor findings: none. Major (new tickets): none. Conditional/tripwire: the one parked
item above (owned by donation-service, not re-filed). Docs are accurate, honest about the
build/in-progress split, and internally consistent. Advanced to complete unchanged.
