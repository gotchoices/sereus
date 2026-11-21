description: Phone and browser apps have no way to say what kind of work their machine should take on — settings that already exist for server programs. Until they do, a phone cannot be configured as a light participant in a very large shared workspace.
architecture: docs/cadre/node.md#node-classes
files: packages/cadre-core/src/edge-node/config.ts, packages/cadre-core/src/edge-node/options.ts, packages/cadre-rn/src/phone-node/, docs/cadre/node.md, docs/platforms/react-native.md
tradeoffs: Nothing needs it until an app actually wants a non-default role on a phone, and every role an app can set is a way for an app to misconfigure its own node — a maintainer may prefer to keep the edge node's one opinionated profile and add the field only when a reference app asks for it.
----

# The edge node can state its node roles

`CadreNodeConfig.roles` lets a deployment set each of the four node roles on its own, and `cadre-cli` exposes all four in its config file and environment (`roles.alwaysOn`, `overlayTier`, `reactivity`, `strandCohortMember`). The **edge node** — `@serfab/cadre-core/edge-node`, which `@serfab/cadre-rn/phone-node` and the web reference app run — exposes none. `buildEdgeNodeConfig` hard-codes `nodeClass: 'device'` and passes no `roles` block at all, and `EdgeNodeOptions` has no field for one.

So every role on a phone or in a browser tab is the `device` preset, with no way for an app to change it.

## Why it matters

Two settings that exist today cannot be reached from the machines they were designed for.

- **`strandCohortMember: false`** (a machine that runs a shared workspace without storing or signing its data) was built for exactly one shape: a workspace with tens of thousands of phones, where every phone taking part is wanted and every phone storing is not. A phone is the only machine that shape cares about, and a phone cannot set it.
- **`reactivity: 'subscriber'`** is the setting `feat-decide-phone-reactivity-role-by-simulation` exists to answer by configuring a deployment rather than by changing code. The deployment it needs to configure is a phone.

`alwaysOn` and `overlayTier` have plausible edge uses too — a kiosk or a set-top box running the phone kit is always on, and a desktop browser tab is not an `edge`-tier machine — but neither is blocked on this today.

## What the capability is

An edge app can state any subset of the four roles, and each one it leaves out keeps the `device` preset. An app that states none is byte-identical to today.

The surface runs through three layers, each of which already passes options through: `EdgeNodeOptions` (what an app sets) → `buildEdgeNodeConfig` (which assembles `CadreNodeConfig`) → `CadreNode`, which resolves and validates the block and throws on a misnamed role or a bad value. Nothing new has to validate anything; the field is a pass-through.

Expectations worth stating when this is designed:

- **A bad role stops the start with a message naming the role**, as it does for `cadre-cli` and any other embedder. An app's roles come from its own code or its own settings screen, so a typo must not resolve quietly to the preset.
- **The roles belong to the saved start options.** A background restart or a push wake rebuilds the node from saved options, and it must come back with the roles the app chose rather than the presets.
- **`nodeClass` stays `'device'` and is not exposed.** The class is only a preset, and an app that wants always-on behaviour says `alwaysOn: true`; letting an app call itself a `server` would change four things at once for one intent.
- **The reference apps need no role set** to keep working. Whether any of them should offer one in its UI is a separate question.

## Not in scope

Whether a phone *should* run as a client, or as a reactivity subscriber, is not this ticket. This is the field those questions need before either can be answered on a real device.
