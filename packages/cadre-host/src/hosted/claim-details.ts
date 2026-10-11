/**
 * What the QR code of a node waiting to be claimed carries, and the address list behind it.
 * `HostedNodeService.claimDetails` reads the child's `/status` and hands it here.
 */

import { encodeNodeClaimPayload, selectNodeClaimAddresses } from '@serfab/cadre-core';

import type { ClaimAddressSettings } from '../installer/config.js';
import type { NodeReachability } from '../nat/types.js';
import type { NodeStatus } from './node-status.js';
import { HostedNodeError } from './types.js';

/** What `claimDetails` answers: the QR payload and its parts. */
export interface ClaimDetails {
  /** `encodeNodeClaimPayload` of the three fields below — the text the QR code carries. */
  payload: string;
  peerId: string;
  /** Public names (or public IPs when there is no name), then the one LAN address; see {@link dialAddressesFor}. */
  multiaddrs: string[];
  /** The NAT layer's verdict for the node, or null when it has no entry yet. A phone at home reaches the LAN address either way. */
  reachability: NodeReachability | null;
}

/** The NAT layer's answers the claim details need. `NatService` satisfies this. */
export interface HostedNodeAddressSource {
  /** The node's public multiaddrs (no `/p2p/` suffix), TCP then WebSocket. */
  publicAddressesFor(nodeId: string, ports: { p2p: number; ws?: number }): string[];
  /** `gateway.lanAddress` is this machine's address on the router's subnet, when a UPnP gateway answered. */
  getStatus(): { nodes: NodeReachability[]; gateway: { lanAddress: string | null } };
}

/** One node's claim details, from its record's secret, its `/status`, and its ports. */
export interface ClaimDetailsInput {
  id: string;
  secret: string;
  status: NodeStatus;
  /** The orchestrator handle's ports; absent, the code carries LAN addresses only. */
  ports: { p2p: number; ws?: number } | undefined;
  addresses: HostedNodeAddressSource;
  /** `host.config.json`'s `claimAddresses`; absent ⇒ automatic. */
  settings?: ClaimAddressSettings;
  /** The machine's primary address (`primaryLanAddress`), the `lan: 'auto'` fallback when no gateway answered. */
  primaryLan?: string;
}

/**
 * The claim details for a node whose `/status` answered. `503 node_unavailable` while the
 * node reports no address a phone could dial (callers poll).
 */
export function buildClaimDetails(input: ClaimDetailsInput): ClaimDetails {
  const { id, status, addresses } = input;
  const multiaddrs = dialAddressesFor(input);
  if (multiaddrs.length === 0) {
    throw new HostedNodeError('node_unavailable', `Hosted node ${id} reports no address a phone could dial yet`);
  }
  return {
    payload: encodeNodeClaimPayload({ peerId: status.peerId, multiaddrs, secret: input.secret }),
    peerId: status.peerId,
    multiaddrs,
    reachability: addresses.getStatus().nodes.find((n) => n.nodeId === id) ?? null,
  };
}

/**
 * The addresses the QR code names, in dial order. A phone dials each in turn on its own
 * timeout, so every address it cannot reach delays a failing claim and enlarges the code.
 *
 * - With `settings.addrs`, exactly those, each given the node's peer id.
 * - Otherwise cadre-core's `selectNodeClaimAddresses` over the NAT layer's public addresses
 *   and the node's own (`/status`): WebSocket and relay only (a phone has no TCP), public
 *   names before raw public IPs, and of the private addresses only the LAN one, chosen by
 *   `settings.lan`: `'auto'` (default) is the gateway's `lanAddress`, else the machine's
 *   primary address; `'none'` drops them; an IP keeps that one. Docker bridges, VPNs and
 *   other interfaces a phone cannot reach are left out.
 */
function dialAddressesFor({ id, status, ports, addresses, settings, primaryLan }: ClaimDetailsInput): string[] {
  const withId = (a: string) => (a.includes('/p2p/') ? a : `${a}/p2p/${status.peerId}`);
  if (settings?.addrs && settings.addrs.length > 0) return [...new Set(settings.addrs.map((a) => withId(a.trim())))];
  const publicAddrs = ports ? addresses.publicAddressesFor(id, ports) : [];
  const lanSetting = settings?.lan ?? 'auto';
  const lan = lanSetting === 'none'
    ? null
    : lanSetting === 'auto'
      ? addresses.getStatus().gateway.lanAddress ?? primaryLan
      : lanSetting;
  return selectNodeClaimAddresses([...publicAddrs, ...status.multiaddrs], status.peerId, { lan });
}
