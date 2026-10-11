/**
 * What the QR code of a node waiting to be claimed carries, and the address list behind it.
 * `HostedNodeService.claimDetails` reads the child's `/status` and hands it here.
 */

import { encodeNodeClaimPayload, selectNodeClaimAddresses, withClaimDestination } from '@serfab/cadre-core';

import type { ClaimAddressSettings } from '../installer/config.js';
import type { NetworkMode, NodeReachability } from '../nat/types.js';
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
  /**
   * `gateway.lanAddress` is this machine's address on the router's subnet, when a UPnP gateway
   * answered; `network.mode` is whether it sits behind a router (`lan`) or holds a public IPv4.
   */
  getStatus(): { nodes: NodeReachability[]; gateway: { lanAddress: string | null }; network: { mode: NetworkMode } };
}

/** One node's claim details, from its record's secret, its `/status`, and its ports. */
export interface ClaimDetailsInput {
  id: string;
  secret: string;
  status: NodeStatus;
  /** The orchestrator handle's ports; absent, the code carries LAN addresses only. */
  ports: { p2p: number; ws?: number } | undefined;
  addresses: HostedNodeAddressSource;
  /** `host.config.json`'s `claimAddresses.addrs`: exact addresses replacing the automatic choice. */
  exactAddrs?: readonly string[];
  /** The LAN address to keep, as {@link claimLanAddress} resolved it. */
  lan: string | null | undefined;
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
 * The LAN address a node code keeps (`selectNodeClaimAddresses`' `lan`), from `claimAddresses.lan`:
 * `'none'` is null; an IP is itself; `'auto'` (default) is null in public-IP mode (no phone shares
 * a LAN with a VPS), else the gateway's `lanAddress`, else the machine's primary address
 * (`primaryLan`, probed only then), else undefined (keep every private address).
 */
export async function claimLanAddress(
  settings: ClaimAddressSettings | undefined,
  addresses: HostedNodeAddressSource,
  primaryLan: () => Promise<string | undefined>,
): Promise<string | null | undefined> {
  const lan = settings?.lan ?? 'auto';
  if (lan === 'none') return null;
  if (lan !== 'auto') return lan;
  const { network, gateway } = addresses.getStatus();
  if (network.mode === 'public') return null;
  return gateway.lanAddress ?? await primaryLan();
}

/**
 * The addresses the QR code names, in dial order. A phone dials each in turn on its own
 * timeout, so every address it cannot reach delays a failing claim and enlarges the code.
 *
 * - With `exactAddrs`, exactly those, each given the node's peer id.
 * - Otherwise cadre-core's `selectNodeClaimAddresses` over the NAT layer's public addresses
 *   and the node's own (`/status`): WebSocket and relay only (a phone has no TCP), public
 *   names before raw public IPs, and of the private addresses only `lan`. Docker bridges,
 *   VPNs and other interfaces a phone cannot reach are left out.
 */
function dialAddressesFor({ id, status, ports, addresses, exactAddrs, lan }: ClaimDetailsInput): string[] {
  // NOTE: `claimAddresses.addrs` is host-wide, so every hosted node's code carries the same
  // addresses with its own peer id; that reaches each node only if they route per node (one
  // node, or a port per node). If several nodes behind one proxy is reported, make it per node.
  if (exactAddrs && exactAddrs.length > 0) return [...new Set(exactAddrs.map((a) => withClaimDestination(a, status.peerId)))];
  const publicAddrs = ports ? addresses.publicAddressesFor(id, ports) : [];
  return selectNodeClaimAddresses([...publicAddrs, ...status.multiaddrs], status.peerId, { lan });
}
