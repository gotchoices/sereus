/**
 * The peer a multiaddr reaches: its last `/p2p/` component, read past any relay hop.
 *
 * `…/p2p/<relay>/p2p-circuit/p2p/<destination>` names its destination after the circuit
 * hop; an address that ends at the hop (`…/p2p/<relay>/p2p-circuit`) names nobody, and so
 * does one with no `/p2p/` at all. Same rule as cadre-core's `destinationPeerIdOf`
 * (`node-claim-payload.ts`), restated here because the provider does not depend on
 * cadre-core (`server/owner-key-validation.ts` says why). Shared by the invitation
 * validator (every member address must name the member) and the node code (each address
 * gains the node's own id when it names none).
 */

import { CODE_P2P, CODE_P2P_CIRCUIT, type Multiaddr } from '@multiformats/multiaddr';

export type AddressComponents = ReturnType<Multiaddr['getComponents']>;

/** The destination peer id of a parsed address, or null when it names none. */
export function destinationPeerIdOf(components: AddressComponents): string | null {
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i]!;
    if (component.code === CODE_P2P_CIRCUIT) return null;
    if (component.code === CODE_P2P && component.value) return component.value;
  }
  return null;
}
