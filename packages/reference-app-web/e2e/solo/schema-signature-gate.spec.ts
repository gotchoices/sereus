import { test, expect } from '@playwright/test';
import { assertSchemaSignature, SchemaVerificationError } from '@serfab/cadre-core';
import { getChatSAppConfig, getTamperedChatSAppConfig } from '../../src/lib/chat-strand.js';

/**
 * sApp schema-signature gate. This is the exact check `StrandInstanceManager`
 * runs on strand start (`assertSchemaSignature(sAppConfig)`), so it directly
 * verifies the gate the browser reference is meant to exercise. Pure Node-side
 * assertion — no browser — like `connection-path-parity.spec.ts`, because the
 * web package ships no separate unit runner.
 *
 * The browser always launches the strand with the *valid* signed config; a
 * tampered config (valid signature over the canonical schema, schema mutated
 * afterwards) must be rejected so a strand never starts on an unverified schema.
 */
test.describe('Tier 1 / solo / schema-signature gate', () => {
	test('the bundled signed chat config passes verification', () => {
		expect(() => assertSchemaSignature(getChatSAppConfig())).not.toThrow();
	});

	test('a tampered chat schema is rejected with SchemaVerificationError', () => {
		let caught: unknown;
		try {
			assertSchemaSignature(getTamperedChatSAppConfig());
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SchemaVerificationError);
	});
});
