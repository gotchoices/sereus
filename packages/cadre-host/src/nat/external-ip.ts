import debug from 'debug';

const log = debug('cadre:host:nat-external-ip');

/** Result of an external-IP detection cycle. */
export interface ExternalIpResult {
  /** IP reported by the upstream router (UPnP/NAT-PMP gateway), if reachable. */
  routerIp: string | null;
  /** IP reported by a public IP echo service. */
  publicIp: string | null;
  /**
   * True when both probes succeeded AND returned different addresses, which
   * is the textbook CGNAT signature: the router thinks its WAN address is
   * private to the carrier.
   */
  cgnat: boolean;
  /** When this snapshot was taken. */
  detectedAt: Date;
}

/** Abstract router-side probe (gateway WAN address). */
export type RouterIpProbe = () => Promise<string | null>;

/** Public IP echo endpoints. Tried in order; first success wins. */
const DEFAULT_PUBLIC_IP_URLS: ReadonlyArray<string> = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
];

export interface ExternalIpDetectorOptions {
  /** Probe the local router's external IP (typically via the port mapper). */
  routerProbe?: RouterIpProbe;
  /** Public IP service endpoints. */
  publicIpUrls?: ReadonlyArray<string>;
  /** Fetch override (tests stub this). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Clock override for tests. */
  now?: () => Date;
  /** Per-request timeout in ms (default 5000). */
  requestTimeoutMs?: number;
}

/**
 * External-IP detector.
 *
 * Two independent sources:
 *   - The router (queried via the port mapper's gateway interface). May be
 *     unavailable if UPnP is off or the upstream device doesn't expose
 *     WANIPConnection.
 *   - A public HTTPS echo service (api.ipify.org and friends). May be
 *     unreachable on a firewalled / offline machine.
 *
 * When both succeed AND disagree, we flag CGNAT. The check is heuristic — a
 * fast-changing IP, a sliced VPN, or an IPv6-only public probe could all
 * trigger a false positive. The verdict is informational, not enforced.
 */
export class ExternalIpDetector {
  private readonly routerProbe: RouterIpProbe | undefined;
  private readonly publicIpUrls: ReadonlyArray<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => Date;
  private readonly requestTimeoutMs: number;

  constructor(opts: ExternalIpDetectorOptions = {}) {
    this.routerProbe = opts.routerProbe;
    this.publicIpUrls = opts.publicIpUrls ?? DEFAULT_PUBLIC_IP_URLS;
    this.fetchImpl = opts.fetch ?? fetch;
    this.nowFn = opts.now ?? (() => new Date());
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  }

  /** Run both probes in parallel and return the snapshot. */
  async detect(): Promise<ExternalIpResult> {
    const [routerIp, publicIp] = await Promise.all([
      this.runRouterProbe(),
      this.runPublicProbe(),
    ]);

    const cgnat = routerIp !== null && publicIp !== null && routerIp !== publicIp;
    if (cgnat) {
      log('CGNAT detected: routerIp=%s, publicIp=%s', routerIp, publicIp);
    }

    return {
      routerIp,
      publicIp,
      cgnat,
      detectedAt: this.nowFn(),
    };
  }

  private async runRouterProbe(): Promise<string | null> {
    if (!this.routerProbe) return null;
    try {
      const ip = await this.routerProbe();
      return ip && isPlausibleIp(ip) ? ip : null;
    } catch (err) {
      log('routerProbe failed: %s', (err as Error).message);
      return null;
    }
  }

  private async runPublicProbe(): Promise<string | null> {
    for (const url of this.publicIpUrls) {
      const ip = await this.tryPublicUrl(url);
      if (ip) return ip;
    }
    return null;
  }

  private async tryPublicUrl(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        log('public IP probe %s returned %d', url, res.status);
        return null;
      }
      const text = (await res.text()).trim();
      if (!isPlausibleIp(text)) {
        log('public IP probe %s returned non-IP: %s', url, text.slice(0, 64));
        return null;
      }
      return text;
    } catch (err) {
      log('public IP probe %s failed: %s', url, (err as Error).message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Liberal IP validation — accepts both IPv4 and IPv6 in dotted/colon form.
 * Tighter validation lives at the consumer (`nat-service` checks for IPv4
 * before building an `/ip4/` multiaddr).
 */
export function isPlausibleIp(s: string): boolean {
  if (!s || s.length > 45) return false;
  // IPv4: 4 dotted octets, 0-255 each.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    return v4.slice(1).every((octet) => {
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }
  // IPv6: very liberal — at least two colons, only hex/colon characters.
  if (/^[0-9a-fA-F:]+$/.test(s) && s.split(':').length >= 3) return true;
  return false;
}
