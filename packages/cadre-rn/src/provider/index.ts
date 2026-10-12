/**
 * `@serfab/cadre-rn/provider` — what a phone app adds to cadre-core's `provider/` to rent a node
 * from a hosting provider: the sign-in through the system browser, the tokens in the secure
 * store, and the app's record of its rentals. See the kit README's "Provider" section;
 * `reference-app-rn/src/provider-store-section.tsx` is the worked example.
 *
 * Imports nothing from React Native or Expo: the app passes the browser and the secure store in,
 * so this runs under a Node test.
 */
export {
	providerTokensKey,
	providerTokensSlot,
	signInWithProvider,
	type AuthSessionResult,
	type OpenAuthSession,
	type ProviderTokensSlot,
	type SignInWithProviderOptions,
} from './sign-in.js';
export { rentalStore, type Rental, type RentalStore } from './rental-store.js';
