/**
 * The kit's config plugin (`app.plugin.cjs`, CommonJS) registers the URL schemes of the known Sereus
 * apps and keeps its own copy of the list; it must match `@serfab/cadre-client/app-link`'s.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { KNOWN_SEREUS_APPS } from '@serfab/cadre-client/app-link';

describe('config plugin', () => {
	it('lists the same known apps as cadre-client, since the CommonJS plugin keeps its own copy', () => {
		const plugin = createRequire(import.meta.url)('../../app.plugin.cjs') as { KNOWN_SEREUS_APPS: unknown };
		expect(plugin.KNOWN_SEREUS_APPS).toEqual(KNOWN_SEREUS_APPS);
	});
});
