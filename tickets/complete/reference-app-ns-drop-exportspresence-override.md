description: Tried to remove a temporary build-warning suppression in the NativeScript reference app; the underlying problem turned out not to be fixed, so the suppression stays — but the build gate that it weakened was restored, and the real fix was filed as its own ticket.
files: packages/reference-app-ns/webpack.config.js, packages/reference-app-ns/scripts/bundle-check.js, docs/reference-app-ns.md, tickets/backlog/debt-reference-app-ns-resolve-nested-libp2p-deps.md
----

## Outcome

The override stays. `packages/reference-app-ns/webpack.config.js` keeps
`exportsPresence: 'warn'` plus its `ignoreWarnings` allowlist, because the upstream
dependency alignment the ticket was waiting on does not fix what actually breaks.

What this pass *did* change: the bundle gate now fails on warnings, and the docs
now describe the real cause instead of the assumed one. The remaining work is
filed as `backlog/debt-reference-app-ns-resolve-nested-libp2p-deps`.

## Why the override can't be removed

Removing it reintroduces 22 hard `export 'X' was not found in 'Y'` build errors.
Two independent, structural causes — both re-verified in this review:

- `@nativescript/webpack`'s base config prepends the app's **absolute**
  `node_modules` to `resolve.modules` for every import, so imports originating
  inside `../optimystic/packages/db-p2p/node_modules` resolve `protons-runtime`
  to the hoisted `5.6.0` instead of the nested `6.0.2` beside them. Confirmed
  installed versions: app `protons-runtime@5.6.0` / `@libp2p/interface@3.1.0`;
  nested `db-p2p` `protons-runtime@6.0.2`; gossipsub's own nested
  `@libp2p/interface@2.11.0`.
- `@chainsafe/libp2p-gossipsub@14.1.2` declares `@libp2p/interface@^2` while the
  rest of the stack is `^3`.

The upstream `optimystic-db-p2p-libp2p-dep-skew` fix did land (`../optimystic`
commit `e632b54`) and is live via the `link:../optimystic/packages/db-p2p`
resolution — it just doesn't address either cause.

## Review findings

**Verified from the implement handoff** — all its factual claims held up:
installed version numbers, gossipsub's `^2.0.0` requirement and its nested
`2.11.0` copy, the upstream commit landing, and `test:bundle` at 0/0 with the
override in place.

**Closed the implement stage's first known gap.** It flagged an unchecked
npm-registry question. Answer: `@chainsafe/libp2p-gossipsub@14.1.2` is the latest
published release and still requires `@libp2p/interface@^2`. No `^3`-compatible
version exists to upgrade to. Recorded in the backlog ticket so the next agent
doesn't re-check it.

**Major — the override silently removed the build's strictness, and nothing
replaced it.** `exportsPresence: 'warn'` applies to the *whole* bundle, but
`scripts/bundle-check.js` only failed on errors and printed warnings as a count
with `warnings: false` in its stats output. So any genuinely new missing export —
including from this repo's own source — would have downgraded to a warning, been
counted, printed nowhere, and passed the gate. Fixed inline (minor in size, real
in effect): bundle-check now fails on `errorCount > 0 || warningCount > 0`, prints
warning detail, and says why warnings are fatal. Verified both directions —
`yarn test:bundle` is green at 0/0, and a throwaway compile with `ignoreWarnings`
emptied reports exactly 22 warnings, i.e. the allowlist is doing the suppressing
and an unallowlisted warning does reach the gate.

**Docs were stale in two ways** (as the review stage assumes until checked).
`docs/reference-app-ns.md` § `exportsPresence: 'warn'` claimed the bundle carries
"~22 warnings" — it carries 0 since the `ignoreWarnings` allowlist landed — and
pointed readers at `tickets/backlog/optimystic-db-p2p-libp2p-dep-skew.md`, which
has since completed upstream without resolving this. Rewrote the section with both
real causes, the 0/0 expectation, why warnings are fatal, and a pointer to the new
backlog ticket. Also corrected the bundle-smoke description below it.

**Major — the real fix** is `backlog/debt-reference-app-ns-resolve-nested-libp2p-deps`:
scope the resolution of `protons-runtime` / `@libp2p/interface` to the copies their
importers need (the same scoped-`NormalModuleReplacementPlugin` pattern this config
already uses for `@libp2p/crypto`, `libp2p`'s `user-agent.js`, and noise's crypto
module), then delete the override. Filed as backlog rather than fix/ because it is
a behaviour change to a working build config with real blast radius and an open
design question (is shipping two majors of `@libp2p/interface` acceptable, or
should gossipsub be dropped?) — not a defect with a known correct answer. The
implement stage's second known gap (it did not attempt the alias workaround) is
this ticket; agreed with leaving it out of scope here.

**No tripwires recorded.** Every concern found was either already true today
(the gate hole, the stale docs) or unconditional latent work (the resolution fix) —
nothing in the "fine now, only matters if X later" shape.

**Not re-examined:** the rest of `webpack.config.js` (crypto/noise/user-agent
shims, esbuild downlevel, fallbacks) — untouched by this ticket and out of its
diff. No pre-existing test failures surfaced.

## Validation

- `yarn test:bundle` (from `packages/reference-app-ns`) — `0 errors, 0 warnings`,
  with the tightened gate.
- Allowlist-stripped compile — 22 warnings, confirming the gate has something to
  catch and the allowlist is what keeps the build green.
- `yarn lint` (root) — exit 0.
