----
description: The setup walkthrough in one package's README still describes an older model where the machine running the software owns the shared workspace and other people join it. The design has since flipped — that machine normally just lends capacity to other people's workspaces — so the walkthrough teaches newcomers the wrong mental model.
files: packages/cadre-host/README.md, docs/cadre-host.md
repro: verified
----

# cadre-host README's "After install" walkthrough still teaches the founder-first model

## Background

[`docs/cadre-host.md:43-56`](../../docs/cadre-host.md) states the current design plainly: cadre-host
has two independent roles, and **node donor is primary**. The host contributes always-on capacity to
*other people's* cadres — a friend holding a grant token asks the host to spawn a node that joins
*their* cadre, pinning *their* owner key. The **founder** role (the host running its own personal
cadre) is opt-in, gated behind `ownCadre.enabled` in `host.config.json`, **default false**. A
pure-donor host never uses `installId` as a party id at all.

[`packages/cadre-host/README.md`](../../packages/cadre-host/README.md)'s "After install — getting
your first user running" walkthrough predates that flip and still reads founder-first. The framing
runs through the whole section rather than sitting in one sentence:

- Step 3 — "Anyone who gets the token can claim **the cadre identity it grants**" — presumes a single
  host-owned cadre whose identities are handed out.
- Step 4 — "The invitee's device can now use **that cadre** to participate in strands" — again the
  host's cadre, singular, which members join.

Note the line that looks wrong but is not: "A child cadre node spawns inside your cadre-host process
for this member's identity" is *correct* under the donor model — that is exactly what donation does.
The defect is the surrounding narrative, not that sentence.

## What to build

Rewrite the "After install" walkthrough donor-first, matching `docs/cadre-host.md`:

- The invitee already has (or is creating) **their own** cadre. The host donates a node to it.
- The trust circle is the list of identities allowed to *have a node donated to them here* — not a
  list of members of the host's cadre.
- Say where the founder role fits: opt-in, `ownCadre.enabled`, default false, and note that
  `/auth/*` and `/nat/*` are unmounted (404) without it, so a reader who followed the default
  install is not confused when those routes are missing.

Keep the walkthrough's step structure and its command examples; this is a framing correction, not a
new document. `docs/cadre-host.md` is the source of truth — do not restate its detail, link it.

## Edge cases & interactions

- **Do not change the CLI surface or the commands shown.** `cadre-host invite` / `trust list` are
  unchanged; only what the surrounding prose says they mean changes.
- **The QR/token security warning must survive the rewrite** — "anyone who gets the token can claim
  it, treat it like a one-time password" is true in both models and is the most important line in
  the section.
- **Check the sibling framing in the same README** beyond the numbered steps (intro, the terminology
  aside about trust circle, the Nodes-page note). A half-converted walkthrough is worse than an
  un-converted one.
- **`docs/cadre-host.md` is not in scope to change** — it is already correct. If the rewrite surfaces
  a genuine disagreement between the two, that is a finding to report, not to resolve by editing the
  design doc to match the README.

## Validation

Read the rewritten section cold, as someone who has just run `cadre-host install` with defaults
(donor-only). Every claim it makes should be true for that reader. `yarn lint` (README is not
linted, but the repo gate should stay green).

## TODO

- [ ] Rewrite `packages/cadre-host/README.md`'s "After install" walkthrough donor-first
- [ ] Sweep the rest of that README for founder-first framing outside the numbered steps
- [ ] Preserve the token-security warning and all command examples verbatim
- [ ] Link `docs/cadre-host.md` rather than restating the two-roles detail
