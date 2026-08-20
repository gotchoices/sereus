----
description: Rewrote the cadre-host package README so its setup walkthrough teaches the current design — the machine lends capacity to other people's workspaces by default — instead of the older model where it owned a shared workspace others joined.
files: packages/cadre-host/README.md
----

# Complete: cadre-host README rewritten donor-first

Docs-only change. One file modified across implement + review:
`packages/cadre-host/README.md`. No source or test changes.

## What shipped

The README's "After install" walkthrough and the framing around it now match
[`docs/cadre-host.md`](../../docs/cadre-host.md), the design source of truth:
**node donor** is the primary, always-on role; **founder** (the host running its
own personal cadre) is opt-in behind `ownCadre.enabled`, default `false`.

- Intro leads with donating nodes to other people's cadres and orients the reader
  on the two roles with a link to the design doc.
- Install wizard list names the own-cadre question (default no), marks the
  enrollment-invite step founder-and-interactive-only, and documents
  `--own-cadre` for unattended provisioning.
- "After install — donating your first node" keeps its five-step shape: verify
  service, open UI, `cadre-host grant issue`, the grantee driving the `/grants`
  donation lifecycle, then `grant list` / `grant revoke`.
- New "The founder role" section holds everything founder-specific — a table of
  which surfaces 404 without it, plus the entire previous trust-circle and
  NAT/DDNS content, relocated intact.
- CLI reference gains the three `cadre-host grant` subcommands and tags
  `invite`, `trust *`, `nat *` as founder-role-only.
- Routes list, Local UI page list (five → six; Strands was missing), uninstall
  `--remove-data` scope, and the threat-model sentence all updated.

## Review findings

**Checked.** The implement diff was read before the handoff summary. Every
factual claim in the changed README was re-verified against source, not against
the handoff: `src/bin/host.ts` (grant/invite/trust/nat CLI shapes and flags,
`parseDuration` suffixes), `src/donation/grant-service.ts`
(`DEFAULT_MAX_NODES = 1`, optional ttl, `validate()` revoked/expired behavior),
`src/donation/donation-supervisor.ts` (respawn triggers and supervised
statuses), `src/server/routes/grants.ts` + `grants-admin.ts` (mount paths,
bearer gate, the four lifecycle calls), `src/server/routes/nodes.ts`
(stop/start/restart guards), `src/server/index.ts` (conditional mounting),
`src/installer/index.ts` + `wizard.ts` + `config.ts` (own-cadre prompt, default
false, best-effort invite fetch), `ui/src/App.svelte` (six NAV entries,
unconditional founder-route calls on mount), `ui/src/routes/Home.svelte`
(connectivity tile stuck on "Loading…" without `/nat`), `ui/vite.config.ts`
(proxy list). All five intra-doc anchors and the one cross-doc anchor were
resolved against the actual headings.

**Fixed in this pass (minor).**

- *The teardown advice was wrong, in both places it appeared.* The new text told
  readers that nodes already donated under a revoked grant could be stopped from
  the UI's Nodes page or released by the grantee with `DELETE /grants/:id`.
  Neither works: that DELETE runs the grantee bearer gate, which returns 403 for
  a revoked grant, and a UI stop is undone within milliseconds by
  `DonationSupervisor`, which respawns any non-terminal donation whose child
  exits. Both passages now state the real situation and point at the ticket
  below.
- *"A child cadre node spawns inside your cadre-host process"* contradicted the
  design doc's core statement that the manager holds no in-process cadre node.
  Reworded to name it as a child process.

**Filed (major).**

- [`backlog/bug-cadre-host-donated-node-teardown-unavailable`](../backlog/bug-cadre-host-donated-node-teardown-unavailable.md)
  — the defect behind the fixed doc text. Revoking a grant cannot stop the nodes
  already donated under it: the grantee's release call is refused, the UI's stop
  button is silently undone by the respawn supervisor, and no admin route reaches
  `DonationService.terminate` at all. Filed at the seam rather than as two
  instances: `routes/nodes.ts` already refuses `start`/`restart` for donated ids
  and points at the donation surface, so the invariant "donated-node lifecycle
  belongs to the donation surface" exists — `stop` just doesn't honor it, and the
  donation surface has no host-side entry point. Two arms, one ticket.
  `repro: static` — read from code, not run; the ticket names the integration
  test that would confirm it.
- [`backlog/debt-cadre-host-cli-reference-drift-guard`](../backlog/debt-cadre-host-cli-reference-drift-guard.md)
  — the `cadre-host push` group (five subcommands) has never appeared in the
  README's CLI reference. Filed as a guard rather than as "document push",
  because the reference is hand-maintained prose beside a commander CLI that
  knows its own command list: a test asserting every registered command has an
  entry retires the class instead of patching this instance.

Site-claim grep over all open ticket folders before filing: only this review
ticket touched those paths.

**Confirmed, not re-filed.** The donor-only UI gap — founder-only pages stay in
the nav and error when opened, because `App.svelte`'s `onMount` calls
`refreshTrustCircle()` and `refreshConnectivity()` unconditionally — is real and
already owned by `backlog/feat-cadre-host-donor-aware-ui`, which the README
links.

**Reviewed and upheld: the implementer's deviation from the ticket spec.** The
ticket asked for the trust circle to be redefined as "the list of identities
allowed to have a node donated to them here" and said `invite` / `trust list`
should stay as the walkthrough's commands. `docs/cadre-host.md` — which the same
ticket names as source of truth and puts out of scope for edits — says the
opposite: the trust circle is founder-role-only and unrelated to node donation,
which is gated by grant tokens. Following the ticket literally would have
produced a walkthrough whose every command 404s on a default install, failing the
ticket's own validation criterion. The implementer followed the design doc, said
so, and flagged it for a second opinion. That was the right call, and the
resulting text is accurate. No CLI code changed and no command was dropped from
the README.

**Reviewed and left as-is.** The step-4 statement that the donor flow is not yet
reachable from a remote phone is accurate (`/grants` mounts on the loopback-only
management server; no app drives the four calls) and matches
`docs/cadre-host.md` § Reachability. It reads as hedging, but omitting it would
send a reader to hand a friend a token they cannot spend. Kept.

**Not filed, flagged for triage.** `fetchEnrollmentInvite` posts to
`/auth/invites`, gets a 404 on a donor-only host, and the `.catch` reduces that
to a debug-log line — so a default install prints no QR and no explanation. The
README now warns readers to expect it. This is a one-line UX polish in
`src/installer/index.ts`, not a correctness defect, so it stayed unfiled; a
maintainer who disagrees can file it.

**No disagreement found between the README and `docs/cadre-host.md` on the design
itself.** The design doc was read, not edited, per the ticket. The only conflict
surfaced was between the ticket text and the doc, resolved above.

**No tripwires recorded** — nothing conditional came up. The one candidate (the
respawn supervisor undoing a manual stop) is not "fine now, matters if X later";
it is wrong the moment a donor presses the button, so it went into the bug ticket
instead.

## Validation

- `yarn lint` from the repo root — exit 0, clean. READMEs are not linted; this is
  the repo gate staying green.
- `yarn workspace @serfab/cadre-host test` — 65 files, 601 passed, 4 skipped,
  0 failed. The skips are pre-existing and unrelated to this docs-only change.
