# cadre-client examples

Screens to copy and adapt, one folder per UI framework. They are not built, tested or published;
each shows how to bind the client's stores and call its operations, with inline English strings
and plain styles an app replaces with its own.

| | React Native | Svelte 5 | NativeScript |
|---|---|---|---|
| The person's cadrons: status dot, name, star, removal, adding one by its code, addresses per invitation | [`CadronList.tsx`](react-native/CadronList.tsx) | [`CadronList.svelte`](svelte/CadronList.svelte) | [`cadrons-view-model.ts`](nativescript/cadrons-view-model.ts) + [`cadrons-page.xml`](nativescript/cadrons-page.xml) |
| Beside a minted invitation: ready to hand out, what it names, the QR code full screen | [`InvitationPanel.tsx`](react-native/InvitationPanel.tsx) | [`InvitationPanel.svelte`](svelte/InvitationPanel.svelte) | |
| Binding a store | [`useStore.ts`](react-native/useStore.ts) (`useSyncExternalStore`) | `$store` (the store contract) | `subscribe` into an `Observable` |

Each takes a `client`, `createCadreClient(...)` from `@serfab/cadre-client/sereus`. Wiring that
client into an app, and minting invitations through it, is in [ADOPTING.md](../ADOPTING.md).

Dependencies the examples assume, beyond the package: React Native and `react-native-qrcode-svg`;
Svelte 5 and `qrcode`; `@nativescript/core`.
