description: The React Native reference app's secure key storage and phone-node setup code could also move into the shared kit package, so other Sereus phone apps do not have to rewrite them, but only one app uses them today.
architecture: docs/reference-app-rn.md#node-local-persistence
files: packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/cadre-rn/
tradeoffs: Only the reference app uses them; sereus-chat is bare React Native without Expo and keeps its identity differently, so a shared version would be designed around one consumer and could fit the next app badly.
----
# Share the key store and phone-node helpers through `@serfab/cadre-rn`

The kit package (`@serfab/cadre-rn`, created by `rn-kit-package-and-native-noise-crypto`) carries the polyfills, the Metro helper and the native Noise crypto adapter. The planning pass for that package left two more candidates in the reference app:

- **`SecureStoreKeyStore`** (`src/secure-key-store.ts`): cadre-core's `KeyStore` interface over `expo-secure-store`, the platform secure enclave. It is Expo-only, so in the kit it would need its own subpath with `expo-secure-store` as an optional peer.
- **The phone-node construction** (`src/cadre-phone.ts`, `src/phone-node-config.ts`, `src/node-local-slots.ts`): the transport list, LevelDB storage over `rn-leveldb`, and the node-local record slots split between the secure store and LevelDB.

They were left out because they are not yet independent of the app. `node-local-slots.ts` fixes the app's own storage names and key prefixes, and `phone-node-config.ts` encodes the reference app's own choices (listen policy, profile, strand filter). sereus-chat builds its node differently (`../sereus-chat/apps/mobile/src/cadre/CadreService.ts`).

## Expectation

When a second app wants the same thing, move the parts both apps would use unchanged into kit subpaths, with the app-specific values (storage names, slot keys, profile) as parameters. Until then they stay in the reference app, which remains the worked example.
