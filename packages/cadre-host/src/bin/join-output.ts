/**
 * Human-readable output of the `cadre-host join` and `cadre-host node` commands:
 * the claim payload as a terminal QR code and as text, the warning when the node
 * is not reachable from outside, the claimed line, and the node list.
 *
 * The types are loose mirrors of `ClaimDetails` and `HostedNodeView`
 * (`../hosted/`): the body arrives over HTTP from whichever cadre-host version is
 * running, so every field is optional and a missing one prints as `?`.
 *
 * Streams: the payload text goes to stdout ALONE, so `cadre-host join --no-qr`
 * can be piped or copied; everything else (the QR, the instructions, the
 * warning, the claimed line) goes to stderr. The payload carries the claim
 * secret by design; nothing else printed here contains it.
 */

import { createRequire } from 'node:module';

export interface ClaimDetailsLike {
  payload?: string;
  peerId?: string;
  multiaddrs?: string[];
  reachability?: { verdict?: string; reason?: string | null } | null;
}

export interface HostedNodeLike {
  id?: string;
  status?: string;
  partyId?: string;
  ownerKey?: string;
  connected?: boolean;
  error?: string;
}

const requireForQr = createRequire(import.meta.url);

/** Print the QR code (unless `qr` is false) and the instructions on stderr, then the payload text on stdout. */
export function printClaimPayload(details: ClaimDetailsLike, opts: { qr: boolean }): void {
  console.error('Scan this with the Sereus app on the phone that owns the cadre, or paste the text into it.');
  if (opts.qr && details.payload) renderQr(details.payload);
  console.error(`Node ${details.peerId ?? '?'} at:`);
  for (const addr of details.multiaddrs ?? []) console.error(`  ${addr}`);
  printReachabilityWarning(details);
  console.log(details.payload ?? '');
}

/**
 * One line on stderr when the NAT layer says the node cannot be reached from
 * outside: the claim still works from the home network over the LAN address.
 */
export function printReachabilityWarning(details: ClaimDetailsLike): void {
  const reachability = details.reachability;
  if (!reachability || reachability.verdict !== 'unreachable') return;
  console.error(
    'Warning: this node cannot be reached from outside your home network yet'
    + `${reachability.reason ? ` — ${reachability.reason}` : ''}. `
    + 'A phone on your home network can still claim it; run `cadre-host nat status` for the ports to forward.',
  );
}

/** The line printed once the watcher reports the claim. */
export function printClaimed(node: HostedNodeLike): void {
  console.error(`✓ Claimed by owner ${ownerFingerprint(node.ownerKey)} into cadre ${node.partyId ?? '?'}`);
}

/** One line per hosted node: id, status, party, owner fingerprint, connected. */
export function printNodeList(nodes: HostedNodeLike[]): void {
  if (nodes.length === 0) {
    console.log('Hosted nodes: none. Run `cadre-host join` to start one.');
    return;
  }
  console.log('Hosted nodes:');
  for (const node of nodes) {
    const party = node.status === 'joined' ? `cadre ${node.partyId ?? '?'}` : (node.status ?? '?');
    const owner = node.ownerKey ? `  owner ${ownerFingerprint(node.ownerKey)}` : '';
    const connected = node.status === 'joined' ? `  ${node.connected ? 'connected' : 'not connected'}` : '';
    const error = node.error ? `  (${node.error})` : '';
    console.log(`  ${node.id ?? '?'}  ${node.status ?? '?'}  ${party}${owner}${connected}${error}`);
  }
}

/** The first 8 characters of an owner key, as the UI shows it. */
function ownerFingerprint(ownerKey: string | undefined): string {
  return ownerKey ? ownerKey.slice(0, 8) : '?';
}

/** Best-effort QR render on stderr — fall back to the bare text if the lib chokes. */
function renderQr(text: string): void {
  try {
    const qr = requireForQr('qrcode-terminal') as {
      generate: (text: string, opts?: { small?: boolean }, cb?: (s: string) => void) => void;
    };
    qr.generate(text, { small: true }, (rendered) => { console.error(rendered); });
  } catch (err) {
    console.error(`(qrcode-terminal unavailable: ${(err as Error).message})`);
  }
}
