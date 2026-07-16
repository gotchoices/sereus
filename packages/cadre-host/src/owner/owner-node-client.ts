/**
 * HTTP client for the owner node's loopback admin channel (the 6.6
 * `cadre-node-admin-channel` contract).
 *
 * cadre-host's manager process holds no in-process `CadreNode`; it spawns the
 * admin's owner node as a managed child (see `HostProcessOrchestrator`)
 * and delegates all owner/membership/identity operations to it over this
 * client. The client implements **both** trimmed `CadreNodeLike` interfaces —
 * the trust-circle one (`auth/trust-circle.ts`) and the NAT one
 * (`nat/nat-service.ts`) — plus `pushInviteAddresses`.
 *
 * Transport: `Authorization: Bearer <token>` against
 * `http://127.0.0.1:<adminPort>`. Every response uses the cadre-provider
 * envelope `{ ok: true, data }` / `{ ok: false, error: { code, message } }`.
 * A refused connection, a transport error, or any non-2xx response surfaces
 * as {@link OwnerNodeUnavailableError}; the trust-circle / NAT services
 * translate that into a `node_unavailable` domain error so the management API
 * returns a clear 503 rather than a raw 500.
 */

import debug from 'debug';
import type { CadreInvite } from '@serfab/cadre-core';

import type { OwnerAdminEndpoint } from '../orchestrator/index.js';
import type { CadreNodeLike as TrustCircleCadreNodeLike } from '../auth/trust-circle.js';
import type { CadreNodeLike as NatCadreNodeLike } from '../nat/nat-service.js';

const log = debug('cadre:host:owner-client');

/**
 * Raised when the owner node's admin channel can't be reached or returns
 * a non-success response. Carries the node's stable error `code` when one was
 * present in the envelope (e.g. `not_ready`, `not_authorized`).
 */
export class OwnerNodeUnavailableError extends Error {
  /** The admin-channel error code, when the node answered with an envelope. */
  readonly nodeCode?: string;

  constructor(message: string, nodeCode?: string) {
    super(message);
    this.name = 'OwnerNodeUnavailableError';
    if (nodeCode !== undefined) this.nodeCode = nodeCode;
  }
}

/** Endpoint provided directly or via a getter (so it tracks re-spawns). */
type EndpointSource =
  | OwnerAdminEndpoint
  | (() => OwnerAdminEndpoint | undefined)
  | undefined;

export interface OwnerNodeClientOptions {
  /** Fetch override for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export class OwnerNodeClient implements TrustCircleCadreNodeLike, NatCadreNodeLike {
  private readonly endpointSource: EndpointSource;
  private readonly fetchImpl: typeof fetch;

  /**
   * @param endpoint Either a fixed `{ baseUrl, token }` or a getter returning
   *   the current endpoint (pass `orchestrator.getOwnerAdminEndpoint`
   *   bound, so a restart's new bearer token is picked up automatically).
   */
  constructor(endpoint: EndpointSource, opts: OwnerNodeClientOptions = {}) {
    this.endpointSource = endpoint;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  // --- trust-circle CadreNodeLike ---

  async createInvite(
    token?: string,
    expiresInMs?: number,
  ): Promise<{ invite: CadreInvite; encodedInvite: string }> {
    const body: Record<string, unknown> = {};
    if (token !== undefined) body.token = token;
    if (expiresInMs !== undefined) body.expiresInMs = expiresInMs;
    return await this.request<{ invite: CadreInvite; encodedInvite: string }>(
      'POST',
      '/admin/invites',
      body,
    );
  }

  async acceptPhone(
    options: { phonePeerId: string; token?: string },
    issuedInvite?: CadreInvite,
  ): Promise<void> {
    const body: Record<string, unknown> = { phonePeerId: options.phonePeerId };
    if (options.token !== undefined) body.token = options.token;
    if (issuedInvite !== undefined) body.issuedInvite = issuedInvite;
    await this.request('POST', '/admin/accept-phone', body);
  }

  async removePeer(peerId: string): Promise<void> {
    await this.request('DELETE', `/admin/members/${encodeURIComponent(peerId)}`);
  }

  /**
   * Encode an invite for out-of-band delivery. The admin contract has no
   * encode route (the mint route already returns `encodedInvite`), so this
   * mirrors cadre-core's encoding (`base64url(JSON.stringify(invite))`).
   */
  encodeInvite(invite: CadreInvite): string {
    return Buffer.from(JSON.stringify(invite), 'utf8').toString('base64url');
  }

  async listMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    const data = await this.request<{ members: Array<{ peerId: string; multiaddr: string | null }> }>(
      'GET',
      '/admin/members',
    );
    return data.members;
  }

  async isMember(peerId: string): Promise<boolean> {
    const data = await this.request<{ member: boolean }>(
      'GET',
      `/admin/members/${encodeURIComponent(peerId)}`,
    );
    return data.member;
  }

  /** Authorized-membership surface (excludes self) — see {@link listMembers} for the addressable one. */
  async listAuthorizedMembers(): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    const data = await this.request<{ members: Array<{ peerId: string; multiaddr: string | null }> }>(
      'GET',
      '/admin/authorized-members',
    );
    return data.members;
  }

  async isAuthorizedMember(peerId: string): Promise<boolean> {
    const data = await this.request<{ member: boolean }>(
      'GET',
      `/admin/authorized-members/${encodeURIComponent(peerId)}`,
    );
    return data.member;
  }

  // --- NAT CadreNodeLike ---

  async getPeerId(): Promise<string> {
    const data = await this.request<{ peerId: string | null; partyId: string }>('GET', '/admin/identity');
    return data.peerId ?? '';
  }

  async getMultiaddrs(): Promise<string[]> {
    const data = await this.request<{ multiaddrs: string[] }>('GET', '/admin/multiaddrs');
    return data.multiaddrs;
  }

  // --- push-model invite addresses ---

  /** Push the NAT-resolved addresses the node should embed in future invites. */
  async pushInviteAddresses(addresses: string[]): Promise<void> {
    await this.request('PUT', '/admin/invite-addresses', { addresses });
  }

  // --- internals ---

  private resolveEndpoint(): OwnerAdminEndpoint {
    const ep = typeof this.endpointSource === 'function' ? this.endpointSource() : this.endpointSource;
    if (!ep) {
      throw new OwnerNodeUnavailableError('Owner node admin endpoint is not available');
    }
    return ep;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ep = this.resolveEndpoint();
    const headers: Record<string, string> = { authorization: `Bearer ${ep.token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${ep.baseUrl}${path}`, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('admin %s %s transport error: %s', method, path, message);
      throw new OwnerNodeUnavailableError(`Owner node unreachable: ${message}`);
    }

    const envelope = await this.parseEnvelope(res);
    if (!res.ok || !envelope.ok) {
      const code = envelope.error?.code;
      const message = envelope.error?.message ?? `admin ${method} ${path} → HTTP ${res.status}`;
      log('admin %s %s failed: [%s] %s', method, path, code ?? res.status, message);
      throw new OwnerNodeUnavailableError(message, code);
    }
    return envelope.data as T;
  }

  private async parseEnvelope(res: Response): Promise<{
    ok?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  }> {
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object') {
        return parsed as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } };
      }
    } catch {
      // Non-JSON body — fall through to an empty envelope; status drives the
      // ok/non-ok decision in the caller.
    }
    return {};
  }
}
