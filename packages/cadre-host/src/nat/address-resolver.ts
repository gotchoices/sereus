/**
 * Build the multiaddrs that should be embedded in invites.
 *
 * Inputs are the host's currently-best understanding of its dialable surface:
 *   - DDNS hostname (`/dns4/<hostname>/...`) when configured AND reachable.
 *   - Raw external IP (`/ip4/<ip>/...`) when no DDNS but reachable.
 *   - Whatever libp2p reports otherwise — including any `/p2p-circuit/`
 *     addresses, once relay-client wiring lands (see follow-up tickets).
 *
 * This is intentionally a pure function so it's trivial to unit-test, and so
 * the NatService can be the only place that knows about settings → multiaddrs.
 */
export interface BuildInviteAddressesInput {
  peerId: string;
  externalPort: number;
  ddnsHostname: string | null;
  externalIp: string | null;
  reachable: boolean;
  /** Multiaddrs reported by the underlying libp2p node. */
  libp2pAddrs: string[];
}

export function buildInviteAddresses(input: BuildInviteAddressesInput): string[] {
  const suffix = `/p2p/${input.peerId}`;
  // DNS path-of-truth: stable across IP changes.
  if (input.reachable && input.ddnsHostname) {
    return [`/dns4/${input.ddnsHostname}/tcp/${input.externalPort}${suffix}`];
  }
  // Raw IPv4: works when we know our external IP.
  if (input.reachable && input.externalIp && isIpv4(input.externalIp)) {
    return [`/ip4/${input.externalIp}/tcp/${input.externalPort}${suffix}`];
  }
  // Fallback: whatever libp2p sees. Strip any addresses that lack the
  // peer suffix and append it for clarity, but otherwise pass through.
  return input.libp2pAddrs.map((a) => withPeerSuffix(a, input.peerId));
}

function withPeerSuffix(addr: string, peerId: string): string {
  if (addr.includes(`/p2p/${peerId}`)) return addr;
  if (addr.includes('/p2p/')) return addr;  // already has *some* peer
  return `${addr}/p2p/${peerId}`;
}

function isIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255;
  });
}
