description: The React Native reference app's phone-node setup and its background/foreground handling could move into the shared kit, so other Sereus phone apps start their node the prescribed way instead of each keeping its own, drifting copy.
prereq: rn-kit-key-store
architecture: docs/reference-app-rn.md#node-local-persistence
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/background-runner.ts, packages/reference-app-rn/src/start-options.ts, packages/reference-app-rn/src/use-cadre.ts, packages/cadre-rn/
tradeoffs: The kit takes on an API for building and running a node, which every app then depends on; each app-specific choice it bakes in (transports, profile, strand filter, schema signing) is one an app has to fight later, so those stay parameters.
----
# Share the phone-node bring-up through `@serfab/cadre-rn`

`rn-kit-key-store` moved the secure key store and the node-local slots into the kit. Two parts of
the reference app's bring-up are left:

- **Building and running the node** (`src/cadre-phone.ts`, `src/phone-node-config.ts`). This covers:
  - the identity resolved from the key store;
  - the four node-local stores opened party-scoped;
  - LevelDB storage per scope;
  - the config (transaction profile, `listenAddrs: []`, relays with `requireRelay: false`, the
    permissive dial gater);
  - single-flight start, `stop` that waits for an in-flight start and closes the node-local
    handle, and fail-soft owner genesis.
- **The lifecycle** (`src/background-runner.ts`): hibernate on background, a bounded resume
  (cold start or `control:connected` settle) on foreground, and an epoch guard against flapping.

The original ticket's condition is met: three apps build a phone node outside the reference app,
and the two that copied sereus-chat's bring-up miss parts of the host contract that the reference
app gets right:
- no AppState handling;
- a start promise never cleared after success, so a node that dies cannot restart;
- `stop` not waiting for an in-flight start;
- `initializeSeedBootstrap` and responder registration not awaited.

## Expectation

Kit subpaths (`/node` and `/lifecycle`, or one) built from the reference app's code. The app-specific
values become parameters:
- storage names;
- the transport list (the reference app's WebRTC transport needs ICE servers from its manifest);
- strand filter;
- schema-signing policy;
- profile.

The reference app then uses the kit and stays the worked example.

Worth taking from sereus-chat's copy, which has these and the reference app does not:
- event subscriptions that survive a node rebuild (`on()` replayed onto a rebuilt node);
- attaching a strand and waiting for it to be writable, counting `StrandAwaitingFirstSyncError` as
  progress;
- a boot state that tells a failed start from a slow one.
