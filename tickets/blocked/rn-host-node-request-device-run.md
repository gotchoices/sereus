description: Someone with an Android phone needs to actually try borrowing a node from a home machine using the app's new Settings section, because that whole feature was written and tested without any phone being involved.
files: packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/host-node-request.ts, packages/reference-app-rn/app/settings.tsx, docs/reference-app-rn.md
repro: none
----

# Borrowing a node from a cadre-host: nobody has tried it on a phone

## Why this needs a person

The feature landed with no device or emulator available, so every claim below is read off the code rather than seen working. The headless tests are real but they all run in Node against fakes, and Node cannot exercise the one thing that is most likely to be wrong: what the phone's bundler actually resolves and what the phone's network stack actually permits.

This is a blocked ticket rather than a backlog one because the missing ingredient is a physical Android phone on the same Wi-Fi as a PC — a dependency outside this repository, not a decision about what to build.

## What to run

`docs/reference-app-rn.md` → "Borrowing a Node From a cadre-host" is the written-down session: start `cadre-host`, issue a grant token, forward the management port with `adb reverse`, then Settings → Host Node on the phone. Follow it as written; where it turns out to be wrong, the doc is as much the deliverable as the code.

## What is actually unproven

**The dial permission.** The phone's node config now sets a permissive dial gater (`connectionGater: { denyDialMultiaddr: () => false }` in `src/phone-node-config.ts`). The reasoning is that libp2p's connection-gater package points its `react-native` entry at the browser build, which refuses to dial insecure `ws://` and private (home-network and loopback) addresses — exactly what a borrowed node is. A unit test checks the setting is present and permissive; nothing checks the premise. If the premise is wrong the setting is harmless, but if it is right and something else also blocks the dial, the request reaches "Connecting to the node…" and then fails after thirty seconds. That failure mode is the signal to watch for.

**Reaching the host at all.** The host only answers requests that look like they came from the machine it runs on, so the phone has to reach it through a forwarded port. Whether the forwarded request's `Host` header satisfies that guard has not been observed. If it does not, the app shows a message telling the user to forward the port — which is the advice they already followed, and the doc needs to say what actually works instead.

**The Windows firewall.** The doc says to allow `node.exe` on private networks when prompted. Whether that prompt appears, and whether allowing it is sufficient, is a guess.

**The plain-language wording.** Six progress lines and a dozen failure messages were written without ever being read on a phone screen. Wording that is too long, or that names something the user cannot act on, is worth correcting while someone is holding the device.

## Expected outcome

The progress line reaches "Connected." and the borrowed node's peer id shows up among the phone's connections. Chat traffic through the borrowed node is out of scope here — a borrowed node starts no strand of its own (ticket `always-on-nodes-host-strands-of-apps-they-do-not-run`).

Reconnecting to the borrowed node after an app restart cannot be checked yet: the phone picks a new cadre id on every launch until ticket `feat-rn-persist-node-start-options` lands.

## If the run finds bugs

File them as their own tickets rather than growing this one, the way the earlier device session (`rn-solo-founding-device-run`, completed) did. Update the doc section in place with whatever the run teaches.
