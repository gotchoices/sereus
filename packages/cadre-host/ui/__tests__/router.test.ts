// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';

import { parseHash, hrefFor, navigate, DEFAULT_ROUTE } from '../src/lib/router.js';

describe('parseHash', () => {
	it('returns home for empty / root hashes', () => {
		expect(parseHash('')).toEqual(DEFAULT_ROUTE);
		expect(parseHash('#')).toEqual(DEFAULT_ROUTE);
		expect(parseHash('#/')).toEqual(DEFAULT_ROUTE);
	});

	it('parses simple routes', () => {
		expect(parseHash('#/trust-circle').name).toBe('trust-circle');
		expect(parseHash('#/connectivity').name).toBe('connectivity');
		expect(parseHash('#/nodes').name).toBe('nodes');
		expect(parseHash('#/settings').name).toBe('settings');
	});

	it('parses node detail with id', () => {
		const r = parseHash('#/nodes/abc-123');
		expect(r).toEqual({ name: 'node-detail', params: { id: 'abc-123' } });
	});

	it('decodes URL-encoded id segments', () => {
		const r = parseHash('#/nodes/foo%20bar');
		expect(r).toEqual({ name: 'node-detail', params: { id: 'foo bar' } });
	});

	it('falls back to home on unknown segments', () => {
		expect(parseHash('#/totally-bogus')).toEqual(DEFAULT_ROUTE);
	});
});

describe('hrefFor', () => {
	it('produces stable hrefs', () => {
		expect(hrefFor('home')).toBe('#/');
		expect(hrefFor('trust-circle')).toBe('#/trust-circle');
		expect(hrefFor('connectivity')).toBe('#/connectivity');
		expect(hrefFor('nodes')).toBe('#/nodes');
		expect(hrefFor('settings')).toBe('#/settings');
		expect(hrefFor('node-detail', { id: 'x y' })).toBe('#/nodes/x%20y');
	});
});

describe('navigate', () => {
	beforeEach(() => {
		window.location.hash = '';
	});

	it('sets the location hash, prepending # if missing', () => {
		navigate('/connectivity');
		expect(window.location.hash).toBe('#/connectivity');
	});

	it('accepts an already-prefixed hash href', () => {
		navigate('#/settings');
		expect(window.location.hash).toBe('#/settings');
	});

	it('is a no-op when the hash already matches', () => {
		window.location.hash = '#/nodes';
		navigate('#/nodes');
		expect(window.location.hash).toBe('#/nodes');
	});
});
