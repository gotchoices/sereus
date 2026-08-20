----
description: Rewrote the cadre-host package README so its setup walkthrough teaches the current design — the machine lends capacity to other people's workspaces by default — instead of the older model where it owned a shared workspace others joined.
files: packages/cadre-host/README.md, docs/cadre-host.md, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/server/routes/grants.ts, packages/cadre-host/ui/src/App.svelte
----

# Review: cadre-host README rewritten donor-first

Docs-only change. One file modified: `packages/cadre-host/README.md` (+127 / −41). No source,
no tests, no `docs/` changes.

## What changed

The README's "After install" walkthrough (and the founder-first framing around it) was rewritten
to match [`docs/cadre-host.md`](../../docs/cadre-host.md), which is the design source of truth:
node **donor** is the primary, always-on role; **founder** (the host running its own personal
cadre) is opt-in behind `ownCadre.enabled`, default `false`.

Section by section:

- **Intro** — leads with donating nodes to other people's cadres; adds a short two-roles
  orientation with a link to the design doc rather than restating it.
- **Install wizard list** — step 1 now mentions the wizard's own-cadre question (default no);
  step 6 (enrollment invite) is marked founder-and-interactive-only, because
  `Installer.install` only fetches it when `!noInvite && !nonInteractive`, and that fetch hits
  `/auth/invites`, which 404s on a donor-only host and is swallowed as best-effort. Adds
  `--own-cadre` to the unattended-provisioning line.
- **"After install — donating your first node"** — the five numbered steps are preserved in
  shape. Steps 1–2 (verify service, open UI) are unchanged. Step 3 is now "issue your first
  grant token" (`cadre-host grant issue`), step 4 is the grantee driving the donation lifecycle
  against `/grants`, step 5 is `cadre-host grant list` / `grant revoke`.
- **New "The founder role — running your own cadre here (opt-in)" section** — holds everything
  founder-specific, including a table of which surfaces 404 without it, plus the *entire*
  previous trust-circle and NAT/DDNS content (all commands and prose preserved, just relocated
  and marked).
- **CLI reference** — adds the three `cadre-host grant` subcommands (previously undocumented) and
  tags `invite`, `trust *`, and `nat *` as **founder role only**. No command's documented
  behavior was changed.
- **"What `cadre-host start` does today"** — routes list now names `/grants-admin` and `/grants`
  as the always-on donor surface, and groups `/auth/*`, `/nat/*`, `/api/strands` as founder-only.
- **Local UI** — "Five pages" → "Six pages" (the Strands page existed in `ui/src/App.svelte`'s
  `NAV` but was missing from the list), founder-only pages marked, and the donor-only nav gap
  named with its tracking slug.
- **Uninstall + threat model** — `--remove-data` now mentions grants and donation records;
  the threat-model sentence no longer claims trust-circle membership is *the* inter-cadre auth
  model.

## Use cases to test (read it cold)

The intended reader is someone who just ran `cadre-host install` and accepted every default —
i.e. **donor-only**. Every claim in the walkthrough should be true for them.

1. **Donor path.** Follow steps 1–5 as that reader. `cadre-host grant issue "Mom's cadre"` should
   be the first thing asked of them, and nothing in steps 1–5 should require a cadre of their own.
2. **404 orientation.** A reader who tries `cadre-host invite` or `cadre-host nat status` on a
   default install gets `cadre-host returned 404: …` and exit 1 (verified in
   `src/bin/host.ts`). The founder section should explain that without sounding like breakage.
3. **Founder path.** A reader who answered *yes* to the wizard question should find the
   trust-circle invite flow, the `trust list` sample output, the peerId explainer, and the whole
   DDNS/UPnP section intact.
4. **Security warning survives.** The founder invite still carries the original sentence verbatim:
   "**Anyone who gets the token can claim the cadre identity it grants**, so treat it like a
   one-time password." The grant token gets its own warning — deliberately *not* worded as
   one-time, because a grant is reusable up to `--max-nodes` until it expires or is revoked.
5. **Anchors resolve.** Three intra-doc links were added or depend on new headings:
   `#after-install--donating-your-first-node`,
   `#the-founder-role--running-your-own-cadre-here-opt-in`, and the pre-existing
   `#2-open-the-local-ui` (still valid). One cross-doc link:
   `docs/cadre-host.md#node-donation-the-primary-role`.

## Validation performed

- `yarn lint` from the repo root — exit 0, clean. (READMEs are not linted; this is the repo gate
  staying green, as the ticket asked.)
- Every factual claim was checked against source, not against the old README:
  `src/bin/host.ts` (grant/invite/trust/nat CLI shapes, flags, error text),
  `src/donation/grant-service.ts` (`DEFAULT_MAX_NODES = 1`, ttl optional),
  `src/server/routes/grants.ts` + `grants-admin.ts` (mount paths, bearer gate, loopback-only),
  `src/server/index.ts` (conditional mounting), `src/installer/index.ts` + `wizard.ts`
  (own-cadre prompt, invite best-effort), `ui/src/App.svelte` (`NAV` has six entries).
- No tests were run beyond lint — nothing executable changed.

## Review findings

- **Deliberate deviation from the ticket's spec, on the ticket's own escape hatch.** The ticket
  said "do not change the CLI surface or the commands shown — `cadre-host invite` / `trust list`
  are unchanged; only what the surrounding prose says they mean changes," and told me to redefine
  the trust circle as "the list of identities allowed to have a node donated to them here."
  Both conflict with `docs/cadre-host.md`, which the ticket names as source of truth:
  its *Trust circle* section is headed "**Founder role only** … It is unrelated to node donation:
  donated nodes join *other people's* cadres and are gated by grant tokens, not trust-circle
  invites." The donor-side CLI is `cadre-host grant issue|list|revoke` against `/grants-admin`,
  which exists and works today. Keeping `invite`/`trust list` as the donor walkthrough would have
  failed the ticket's own validation criterion, since both 404 on a default install. I followed
  the design doc: the walkthrough uses `grant`, and the terminology aside now distinguishes the
  everyday sense of "trust circle" (people you handed a grant token to — the design doc uses it
  this way in its intro) from the *feature* of that name. **No CLI code changed and no command was
  dropped from the README** — `invite` / `trust` / `nat` all still documented, relocated under the
  founder heading. Reviewer: this is the one judgment call worth a second opinion.
- **The donor flow is not end-to-end usable from a remote phone yet, and the README now says so.**
  `/grants` mounts on the loopback-only management server (`src/server/routes/grants.ts` header
  comment says as much), and no app drives the four-call lifecycle — it is raw HTTP today. Both
  facts are stated in step 4 with the tracking slug
  `backlog/feat-cadre-host-wan-grant-reachability`. If that reads as too much hedging for a
  package README, it is the reviewer's call to trim — but it is accurate, and a walkthrough that
  omitted it would send a reader to hand a friend a token they cannot spend.
- **Donor-only UI gap: already tracked, not re-filed.** On a default install the SPA still shows
  Trust Circle / Connectivity / Strands in the nav, and those pages error when opened (
  `App.svelte`'s `onMount` calls `refreshTrustCircle()` and `refreshConnectivity()`
  unconditionally against routes that 404). `tickets/backlog/feat-cadre-host-donor-aware-ui.md`
  already owns this exact site and describes it correctly, so I linked its slug from the README
  rather than filing anything.
- **Installer says nothing when it skips the invite (not filed, flagging for triage).**
  `fetchEnrollmentInvite` posts to `/auth/invites`, gets a 404 on a donor-only host, and the
  `.catch` turns that into a debug-log line only — so a default install just prints no QR, with no
  explanation. The README now warns the reader to expect that, but the installer itself could say
  one line ("donor-only install — no enrollment invite; run `cadre-host grant issue <label>` to
  add a grantee"). Cosmetic, hit on the normal-use path. Left unfiled because it is a one-line UX
  polish in `src/installer/index.ts`, not a correctness defect — reviewer's call whether it earns
  a `backlog/` entry.
- **`cadre-host push …` remains undocumented.** The CLI has a whole `push` command group
  (`fcm`, `apns`, `options`, `clear`, `status` — `src/bin/host.ts:1009+`) with no entry in the
  README's CLI reference. Pre-existing gap, unrelated to donor framing, deliberately not touched
  to keep this diff a framing correction.
- **No disagreement found between the README and `docs/cadre-host.md` on the design itself.** The
  design doc was read but not edited, per the ticket. The only conflict surfaced was between the
  ticket text and the doc, recorded in the first finding above.
- **No tripwires recorded.** Nothing conditional came up — this is a prose change with no runtime
  behavior behind it.
