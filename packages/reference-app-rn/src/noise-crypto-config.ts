/**
 * noise-crypto-config.ts — resolve which Noise crypto mode the phone node is built
 * with when nothing chose one: native symmetric crypto, native including key
 * exchange, or libp2p-noise's stock pure-JavaScript path.
 *
 * The mode is a start option (`PhoneNodeOptions.noiseCryptoMode`), read when the
 * node is built exactly as `relayAddrs` is; `cadre-phone.ts` turns it into an
 * implementation with the kit's `buildNoiseCrypto`. The Settings screen offers the
 * three modes and prefills its choice from {@link defaultNoiseCryptoMode}.
 *
 * Sibling of `relay-config.ts`, with the same build-time seam: `EXPO_PUBLIC_NOISE_CRYPTO`
 * (Expo inlines `EXPO_PUBLIC_`-prefixed vars into the Hermes bundle at build time).
 * Unlike that file this one imports the kit's `noise-crypto` module, for its default,
 * so it loads `react-native-quick-crypto` and is for the app bundle only; the
 * Node-tested `phone-node-config.ts` takes the mode's type and nothing else.
 */

import { DEFAULT_NOISE_CRYPTO_MODE, type NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';

/** Every mode, in the order the Settings screen lists them. */
export const NOISE_CRYPTO_MODES: readonly NoiseCryptoMode[] = ['symmetric', 'full', 'off'];

function isNoiseCryptoMode(value: string): value is NoiseCryptoMode {
	return (NOISE_CRYPTO_MODES as readonly string[]).includes(value);
}

/**
 * The build-time mode (`EXPO_PUBLIC_NOISE_CRYPTO`), or `undefined` when the build
 * sets none. A blank value counts as unset, as it does for `EXPO_PUBLIC_RELAY_ADDR`.
 *
 * Throws on any other value: a misspelt mode is a build misconfiguration, and
 * silently running a different mode would corrupt the measurement the switch exists
 * for (see `docs/reference-app-rn.md` → Phone (RN app) Configuration).
 */
function envNoiseCryptoMode(): NoiseCryptoMode | undefined {
	const raw = process.env.EXPO_PUBLIC_NOISE_CRYPTO?.trim();
	if (!raw) return undefined;
	if (isNoiseCryptoMode(raw)) return raw;
	throw new Error(
		`EXPO_PUBLIC_NOISE_CRYPTO is '${raw}'; expected one of ${NOISE_CRYPTO_MODES.join(', ')}`,
	);
}

/** The mode a node starts with unless one is chosen: env (`EXPO_PUBLIC_NOISE_CRYPTO`) → the kit's default. */
export function defaultNoiseCryptoMode(): NoiseCryptoMode {
	return envNoiseCryptoMode() ?? DEFAULT_NOISE_CRYPTO_MODE;
}
