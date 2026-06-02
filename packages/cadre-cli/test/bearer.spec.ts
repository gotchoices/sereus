import { describe, it, expect } from 'vitest';
import type http from 'node:http';
import { checkBearer } from '../src/server/bearer.js';

/** Build a minimal IncomingMessage carrying just the headers checkBearer reads. */
function reqWith(authorization: string | string[] | undefined): http.IncomingMessage {
  return { headers: { authorization } } as unknown as http.IncomingMessage;
}

const TOKEN = 'super-secret-seed-token';

describe('checkBearer', () => {
  it('accepts an exact `Bearer <token>` match', () => {
    expect(checkBearer(reqWith(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    expect(checkBearer(reqWith(`Bearer ${wrong}`), TOKEN)).toBe(false);
  });

  it('rejects a token differing only in length (no timingSafeEqual throw)', () => {
    expect(checkBearer(reqWith(`Bearer ${TOKEN}extra`), TOKEN)).toBe(false);
    expect(checkBearer(reqWith('Bearer short'), TOKEN)).toBe(false);
  });

  it('never authorizes when the configured token is empty', () => {
    // Defense in depth: an empty secret must not be satisfiable by an empty bearer.
    expect(checkBearer(reqWith('Bearer '), '')).toBe(false);
    expect(checkBearer(reqWith('Bearer x'), '')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    expect(checkBearer(reqWith(undefined), TOKEN)).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(checkBearer(reqWith(`Basic ${TOKEN}`), TOKEN)).toBe(false);
    expect(checkBearer(reqWith(TOKEN), TOKEN)).toBe(false);
  });

  it('rejects a duplicated (array) Authorization header', () => {
    // Node can surface duplicate headers as string[]; a non-string must not authorize.
    expect(checkBearer(reqWith([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]), TOKEN)).toBe(false);
  });
});
