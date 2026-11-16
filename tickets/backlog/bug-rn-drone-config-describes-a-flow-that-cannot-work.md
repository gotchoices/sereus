description: The sample configuration file for the always-on test node that the phone app talks to opens with setup instructions that no longer produce a working pair of machines, and it leaves out a setting the working procedure needs.
architecture: docs/contributing/device-testing.md#two-node-startup
files: packages/reference-app-rn/drone.cadre.yaml, docs/contributing/device-testing.md, packages/reference-app-rn/README.md, packages/cadre-cli/src/commands/start.ts
repro: static
severity: cosmetic
likelihood: normal-use
tradeoffs: The documented procedure already works around both points with command-line flags, so this is a misleading comment and a missing convenience in a sample file; severity is set to cosmetic for that reason, although a developer who follows the file's own header ends up with two machines that silently share nothing.
----

# `drone.cadre.yaml`: the header's startup sequence cannot work, and the file names no identity key

## What is wrong

`packages/reference-app-rn/drone.cadre.yaml` is the cadre-cli configuration for the "drone", the always-on node used in two-machine tests of the phone app. Two things in it are out of step with the code.

**The header comment describes a sequence with no admission step.** It says to run `npx cadre start -c ../reference-app-rn/drone.cadre.yaml --listen-for-seeds`, then type the drone's party id and bootstrap address into the phone's Settings, tap Connect, and create a strand. A machine belongs to a party only once an owner has admitted it. In this sequence the phone founds a party of its own under the typed party id and becomes its owner, and nothing admits the drone: `--listen-for-seeds` only makes the drone wait for a seed that no step sends. The drone never becomes a member, so it never receives the phone's strands. `packages/reference-app-rn/README.md` now says the same thing in its own words ("Typing the drone's party id and address under **Connect** founds a separate cadre on the phone and does not make the drone a member").

**The file has no `identity.keyFile`.** The procedure that replaced the header's (`docs/contributing/device-testing.md`, "Two-node startup") has the drone found the cadre with `cadre start --owner`. `start.ts` refuses `--owner` without a node identity ("--owner requires a node identity (set identity.keyFile in the config, or pass --identity-file)"), and without a stored identity the drone would also take a new peer id at every start. The document works around the omission by running `cadre enroll create --name drone` and passing `--identity-file drone.key` on the command line.

## Expected behaviour

The file's header either gives the working sequence or points to "Two-node startup" and says nothing else about how to start, and the file carries the identity key path the working sequence uses, so that the documented command needs no flag to make up for the file.

`tickets/backlog/later/6-ci-pipeline-maestro.md` quotes the header's command (`start -c ../reference-app-rn/drone.cadre.yaml --listen-for-seeds`) as its drone strategy and inherits the same problem.

## Evidence and confirmation

The file, `start.ts` and the documents were read; nothing was run. The claim that the header's sequence leaves the drone outside the party rests on the sequence containing no seed, claim, invitation or owner grant, not on an observed run.

The replacement procedure in "Two-node startup" (the drone founds with `enroll create` and `start --owner`, the phone joins with an owner grant) was itself derived from the code and has not been run on a device. That run is recorded as an added case on `rn-device-run-join-existing-cadre` in `tickets/blocked/`. If it shows the procedure needs a change, this file changes with it.
