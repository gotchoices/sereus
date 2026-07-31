description: Add a test proving that when a sleeping group connection wakes back up, it comes back under the same network name it had before instead of a brand-new one.
prereq:
files: packages/cadre-core/src/strand-instance-manager.ts (launchConfigs retention ~L144/L218/L396-414, stopStrand clears at L447), packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/cadre-node-strand-launch-key.spec.ts (launch-side coverage, for the pattern)
difficulty: easy
----

# Pin that waking a hibernated strand reuses its transport identity

A cadre node runs each strand it participates in as its own network (libp2p) node with its own
network identity — a peerId derived once at launch from the cadre identity key plus the strand
id. Idle strands are put to sleep ("hibernated") and woken on demand. Waking rebuilds the strand's
runtime from a launch config the manager retained at launch, which is what makes the woken strand
come back under the *same* peerId.

That stability matters: a relay reservation, a peer-store entry, or any recorded peerId for the
strand node goes stale the moment the peerId changes, and a woken strand that announces a new
identity has to re-earn admission everywhere it was already known.

## What is missing

Nothing tests the reuse. `StrandInstanceManager.resumeStrand` spreads the retained launch config
and only overrides the volatile fields (bootstrap addresses, mode), so the behavior is correct
today — but no test would notice if a future edit rebuilt the config from scratch, dropped the
key, or cleared the retained config on hibernate rather than only on a full stop.

The launch side is now covered (`test/cadre-node-strand-launch-key.spec.ts` asserts the derived
key and the delegate announcement reaching `startStrand`); the wake side is not.

## Expected behavior to assert

- A strand launched with a private key, hibernated, then resumed rebuilds its runtime with the
  **same** private key — byte-equal, not merely present.
- Resume overrides (new bootstrap addresses, new mode) replace only those fields and leave the
  key untouched.
- Fully stopping a strand drops the retained config, so a later launch is a fresh launch rather
  than a silent resume of stale state.
- A strand launched with no private key resumes with none (does not acquire one).
