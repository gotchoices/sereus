description: The `it.fails` arm of `joiner-first-commit-over-slow-relay` (20 ms frame cap, 70%-busy event loop) now commits most of the time, so the "expected failure" turns red and fails `yarn check`. Decide whether the defect it recorded is fixed and make the arm a plain `it`, or find what still makes it fail.
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts
----

## Symptom

`it.fails('commits, and its rows outlive the joiner, on a 20 ms frame cap with a 70%-busy event loop', …)` reports `Error: Expect test to fail` when the commit succeeds. Runs on Optimystic 1.29.0:

- 2026-11-20 (adopting 1.29.0): passed once, failed as expected on rerun.
- 2026-11-21 full `yarn check` (at fa5760af): body passed → gate red.
- 2026-11-21, three runs alone (`-t "20 ms frame cap"`): body passed 2 of 3 (≈242 s each), failed as expected 1 of 3 (256 s).

So the body now succeeds in about 4 of 6 runs. Before 1.28.0 it failed in every recorded run (2 of 2 on 2026-10-17, 2026-10-20, 1 of 1 on 1.19.0). Optimystic 1.28.0's silent-member grace and relay reservation renewal (sereus#64) are the likely changes.

## Expected

The suite is deterministic: either the arm is a plain `it` that passes reliably, or a remaining failure is understood and tracked.

## Direction

Read the failing run's log for the cause: is it still the `Failed to get super-majority: 1/2 approvals` the comment above the arm records (a ping drop cycle resetting the founder's leg mid-commit), or something else? If it is the old cause at a reduced rate, the defect is still real; keep it tracked on a ticket and stop it from flipping the gate (for example, skip the arm with that ticket's slug in the reason) rather than leaving an `it.fails` that passes most runs. If the remaining failures are a different cause, make the arm a plain `it` and file that cause. Per the comment, a commit that "missed a drop by timing" explains a single pass, not a majority.
