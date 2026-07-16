import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GrantService, createGrantAdminHandlers, DEFAULT_MAX_NODES } from '../grant-service.js';
import { GrantStore } from '../grant-store.js';
import { GrantError } from '../types.js';

let tmpRoot: string;
let store: GrantStore;
let service: GrantService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-grant-svc-'));
  store = new GrantStore(tmpRoot);
  service = new GrantService({ store });
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GrantService.issue', () => {
  it('persists a grant and returns a base64url token', () => {
    const grant = service.issue({ label: "Alice's cadre", maxNodes: 2 });
    expect(grant.token).toBeTruthy();
    // base64url alphabet only.
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(grant.label).toBe("Alice's cadre");
    expect(grant.maxNodes).toBe(2);
    expect(grant.createdAt).toBeTruthy();
    expect(grant.expiresAt).toBeUndefined();
    expect(grant.revokedAt).toBeUndefined();

    expect(store.get(grant.token)).toMatchObject({ label: "Alice's cadre", maxNodes: 2 });
  });

  it('defaults maxNodes when omitted', () => {
    const grant = service.issue({ label: 'Bob' });
    expect(grant.maxNodes).toBe(DEFAULT_MAX_NODES);
  });

  it('sets expiresAt from ttlMs', () => {
    const clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new GrantService({ store, now: () => clock });
    const grant = svc.issue({ label: 'Carol', ttlMs: 24 * 60 * 60 * 1000 });
    expect(grant.expiresAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('rejects empty / whitespace labels', () => {
    expect(() => service.issue({ label: '   ' })).toThrow(GrantError);
    expect(() => service.issue({ label: '' })).toThrow(GrantError);
  });

  it('rejects labels over 200 characters', () => {
    expect(() => service.issue({ label: 'a'.repeat(201) }))
      .toThrow(expect.objectContaining({ code: 'invalid_label' }));
  });

  it('rejects non-positive / non-integer maxNodes', () => {
    expect(() => service.issue({ label: 'X', maxNodes: 0 }))
      .toThrow(expect.objectContaining({ code: 'invalid_max_nodes' }));
    expect(() => service.issue({ label: 'X', maxNodes: -1 }))
      .toThrow(expect.objectContaining({ code: 'invalid_max_nodes' }));
    expect(() => service.issue({ label: 'X', maxNodes: 1.5 }))
      .toThrow(expect.objectContaining({ code: 'invalid_max_nodes' }));
  });

  it('rejects non-positive ttl', () => {
    expect(() => service.issue({ label: 'X', ttlMs: 0 }))
      .toThrow(expect.objectContaining({ code: 'invalid_ttl' }));
    expect(() => service.issue({ label: 'X', ttlMs: -1 }))
      .toThrow(expect.objectContaining({ code: 'invalid_ttl' }));
  });
});

describe('GrantService.validate', () => {
  it('accepts a live grant', () => {
    const { token } = service.issue({ label: 'Alice' });
    const v = service.validate(token);
    expect(v.ok).toBe(true);
    expect(v.grant?.token).toBe(token);
    expect(v.reason).toBeUndefined();
  });

  it('denies an empty bearer with unknown_token (never throws)', () => {
    expect(service.validate('')).toEqual({ ok: false, reason: 'unknown_token' });
  });

  it('denies an unknown token with unknown_token (never throws)', () => {
    expect(service.validate('does-not-exist')).toEqual({ ok: false, reason: 'unknown_token' });
  });

  it('denies a revoked grant with reason "revoked"', () => {
    const { token } = service.issue({ label: 'Rev' });
    service.revoke(token);
    const v = service.validate(token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('revoked');
    expect(v.grant?.token).toBe(token);
  });

  it('denies an expired grant with reason "expired" even when not revoked', () => {
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new GrantService({ store, now: () => clock });
    const { token } = svc.issue({ label: 'Exp', ttlMs: 60_000 });

    clock = new Date('2025-01-02T00:00:00.000Z'); // past expiry
    const v = svc.validate(token);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('expired');
  });

  it('reports revoked over expired when both apply', () => {
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new GrantService({ store, now: () => clock });
    const { token } = svc.issue({ label: 'Both', ttlMs: 60_000 });
    svc.revoke(token);

    clock = new Date('2025-01-02T00:00:00.000Z'); // also past expiry now
    expect(svc.validate(token).reason).toBe('revoked');
  });
});

describe('GrantService.validateForProvision', () => {
  it('allows up to the quota, then denies with quota_exceeded', () => {
    const { token } = service.issue({ label: 'Alice', maxNodes: 2 });

    // First two provisions (live count 0, then 1) pass.
    expect(service.validateForProvision(token, () => 0).ok).toBe(true);
    expect(service.validateForProvision(token, () => 1).ok).toBe(true);

    // Third (live count already at 2) is denied.
    const v = service.validateForProvision(token, () => 2);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('quota_exceeded');
    expect(v.grant?.token).toBe(token);
  });

  it('does not consult liveNodeCount for an unknown token', () => {
    let called = false;
    const v = service.validateForProvision('nope', () => { called = true; return 0; });
    expect(v).toEqual({ ok: false, reason: 'unknown_token' });
    expect(called).toBe(false);
  });

  it('does not consult liveNodeCount for a revoked or expired grant', () => {
    const { token } = service.issue({ label: 'Rev', maxNodes: 5 });
    service.revoke(token);
    let called = false;
    const v = service.validateForProvision(token, () => { called = true; return 0; });
    expect(v.reason).toBe('revoked');
    expect(called).toBe(false);
  });
});

describe('GrantService.revoke', () => {
  it('throws not_found for an unknown token', () => {
    expect(() => service.revoke('nope'))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('is idempotent (second revoke keeps the original timestamp)', () => {
    let clock = new Date('2025-01-01T00:00:00.000Z');
    const svc = new GrantService({ store, now: () => clock });
    const { token } = svc.issue({ label: 'X' });

    svc.revoke(token);
    const first = store.get(token)?.revokedAt;

    clock = new Date('2025-02-01T00:00:00.000Z');
    svc.revoke(token); // no throw; keeps first timestamp
    expect(store.get(token)?.revokedAt).toBe(first);
  });
});

describe('GrantService.list', () => {
  it('enumerates issued grants', () => {
    service.issue({ label: 'A' });
    service.issue({ label: 'B' });
    expect(service.list().map(g => g.label).sort()).toEqual(['A', 'B']);
  });
});

describe('createGrantAdminHandlers', () => {
  it('exposes the admin HTTP-handler surface', async () => {
    const handlers = createGrantAdminHandlers(service);

    const issued = await handlers.postGrant({ label: 'Pat', maxNodes: 3 });
    expect(issued.grant.token).toBeTruthy();
    expect(issued.grant.maxNodes).toBe(3);

    let listed = await handlers.listGrants();
    expect(listed.grants.map(g => g.token)).toContain(issued.grant.token);

    await handlers.deleteGrant(issued.grant.token);
    listed = await handlers.listGrants();
    // Revocation marks, not removes — the grant is still listed but revoked.
    expect(listed.grants.find(g => g.token === issued.grant.token)?.revokedAt).toBeTruthy();
  });

  it('postGrant rejects a missing label', async () => {
    const handlers = createGrantAdminHandlers(service);
    await expect(handlers.postGrant({ label: undefined as unknown as string }))
      .rejects.toMatchObject({ code: 'invalid_label' });
  });

  it('deleteGrant surfaces not_found for an unknown token', async () => {
    const handlers = createGrantAdminHandlers(service);
    await expect(handlers.deleteGrant('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
